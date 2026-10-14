/**
 * The worker's commands. Every one of them runs to completion and exits: the nightly
 * schedule starts a fresh process, and nothing depends on a terminal or a laptop.
 *
 *   migrate                       apply pending database migrations (owner credentials)
 *   provision-roles               set the least-privileged roles' passwords from the environment
 *   nightly [--force] [--season Y] [--no-analytics] [--cron]
 *   backfill (--season Y | --seasons A-B) [--team NAME]... [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *            [--missing-only] [--force] [--no-schedules] [--from-csv DIR] [--no-analytics]
 *   refresh-game --game ID [--analytics]
 *   retry [--run ID]              re-run a failed or abandoned run with its original options
 *   analytics                     rebuild ratings, forecasts and dashboard files from the database
 *   status [--run ID]             latest runs, failures, freshness and coverage, as JSON
 *   health                        exit 1 (and alert) if data is stale or the database unreachable
 */

import * as path from 'path';
import { Pool } from 'pg';
import {
    createPool,
    freshness,
    lastSuccess,
    latestRuns,
    markSync,
    migrate,
    pendingMigrations,
    recentGamesMissingBoxscores,
    refreshReadModels,
    seasonCoverage,
    waitForDatabase
} from '@ncaa/database';
import { WorkerConfig, loadConfig } from './config';
import { ingestSeason, loadFromWorkDir, rebuildAnalytics } from './ingest';
import { log } from './log';
import { notify } from './notify';
import { EXIT_FAILED, EXIT_OK, RunContext, executeRun, task } from './run';
import { localTime, nightlyGate, seasonFor } from './schedule';

class UsageError extends Error {}

interface Args {
    command: string;
    flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
    const [command = 'help', ...rest] = argv;
    const flags = new Map<string, string[]>();
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (!arg.startsWith('--')) throw new UsageError(`Unexpected argument "${arg}"`);
        const next = rest[i + 1];
        const value = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
        flags.set(arg.slice(2), [...(flags.get(arg.slice(2)) ?? []), value]);
    }
    return { command, flags };
}

const one = (args: Args, name: string) => args.flags.get(name)?.[0];
const has = (args: Args, name: string) => args.flags.has(name);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function seasonsFrom(args: Args): number[] {
    const range = one(args, 'seasons');
    if (range) {
        const [a, b] = range.split('-').map(Number);
        if (!a || !b || b < a) throw new UsageError(`Bad --seasons "${range}"; expected e.g. 2016-2019`);
        return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    }
    const season = Number(one(args, 'season'));
    if (!Number.isInteger(season) || season < 1990) throw new UsageError('Give --season YYYY or --seasons A-B');
    return [season];
}

async function requireMigrated(pool: Pool): Promise<void> {
    const pending = await pendingMigrations(pool);
    if (pending.length > 0) {
        throw new Error(`Database has ${pending.length} pending migration(s) (${pending.join(', ')}). Run "migrate" first.`);
    }
}

// ---------------------------------------------------------------------------------------

interface NightlyOptions {
    force: boolean;
    season?: number;
    analytics: boolean;
}

async function nightly(pool: Pool, config: WorkerConfig, opts: NightlyOptions, trigger: string): Promise<number> {
    const now = new Date();
    const last = await lastSuccess(pool, ['nightly']);
    const gate = nightlyGate({
        now,
        timezone: config.timezone,
        hour: config.nightlyHour,
        lastSuccessAt: last?.finished_at ? new Date(last.finished_at) : null,
        recoveryAfterHours: config.recoveryAfterHours,
        force: opts.force
    });
    if (!gate.run) {
        log.info('nightly: not due', { reason: gate.reason });
        // The off-hour firing still checks freshness, so staleness is noticed within
        // hours rather than at the next 03:00.
        return health(pool, config);
    }

    const local = localTime(config.timezone, now);
    const season = opts.season ?? seasonFor(local);
    return executeRun(pool, config, { kind: 'nightly', trigger, params: { ...opts, gate: gate.reason } }, async ctx => {
        if (!opts.force && !config.activeMonths.includes(local.month)) {
            ctx.stats.skipped = `off-season (month ${local.month}; active months ${config.activeMonths.join(',')})`;
            log.info('nightly: off-season, nothing to scrape', { month: local.month });
            await markSync(pool, 'nightly', ctx.runId, true, { skipped: ctx.stats.skipped });
            return;
        }

        const outcome = await ingestSeason(ctx, {
            season,
            schedules: true,
            boxscores: true,
            incremental: config.mode === 'incremental',
            recheckDays: config.lookbackDays
        });
        if (!outcome.loaded) await markSync(pool, `season:${season}`, ctx.runId, false);

        await finishWithReadModels(ctx, outcome.loaded && opts.analytics && config.analyticsEnabled);
        await recordCoverage(ctx, season);
        await markSync(pool, 'nightly', ctx.runId, ctx.failures.length === 0, ctx.stats);
    });
}

async function finishWithReadModels(ctx: RunContext, analytics: boolean): Promise<void> {
    await task(ctx, 'refresh_read_models', null, {}, async () => {
        await refreshReadModels(ctx.pool);
        return { value: true };
    });
    if (analytics) await rebuildAnalytics(ctx);
}

/** Coverage for the season, stored on the run, with the alerts it warrants. */
async function recordCoverage(ctx: RunContext, season: number): Promise<void> {
    const [coverage] = await seasonCoverage(ctx.pool, season);
    const missing = await recentGamesMissingBoxscores(ctx.pool, ctx.config.lookbackDays);
    ctx.stats.coverage = coverage ?? null;
    ctx.stats.recent_final_games_missing_boxscores = missing;
    if (!coverage || coverage.games === 0) {
        await notify(ctx.config.alertWebhookUrl, `Season ${season} has no games in the database after a nightly run`, {
            hint: 'The schedule scrape returned nothing usable. Check the run logs and the source sites.'
        });
    }
}

// ---------------------------------------------------------------------------------------

interface BackfillOptions {
    seasons: number[];
    teams: string[];
    from?: string;
    to?: string;
    force: boolean;
    schedules: boolean;
    fromCsv?: string;
    analytics: boolean;
    allowMassDelete: boolean;
}

function backfillOptions(args: Args): BackfillOptions {
    const from = one(args, 'from');
    const to = one(args, 'to');
    for (const d of [from, to]) if (d && !DATE.test(d)) throw new UsageError(`Bad date "${d}"; use YYYY-MM-DD`);
    return {
        seasons: seasonsFrom(args),
        teams: args.flags.get('team') ?? [],
        from,
        to,
        force: has(args, 'force'),
        schedules: !has(args, 'no-schedules'),
        fromCsv: one(args, 'from-csv'),
        analytics: !has(args, 'no-analytics'),
        allowMassDelete: has(args, 'allow-mass-delete')
    };
}

async function backfill(pool: Pool, config: WorkerConfig, opts: BackfillOptions, trigger: string): Promise<number> {
    return executeRun(pool, config, { kind: 'backfill', trigger, params: { ...opts } }, async ctx => {
        // Resumable: each season records its own success under a scope naming the exact
        // request, and a re-run of the same request skips seasons already done.
        const signature = JSON.stringify({ t: opts.teams, f: opts.from, to: opts.to, s: opts.schedules, c: !!opts.fromCsv });
        let loadedAny = false;
        for (const season of opts.seasons) {
            const scope = `backfill:${opts.fromCsv ? 'csv' : 'scrape'}:${season}:${Buffer.from(signature).toString('base64url').slice(0, 40)}`;
            const { rows } = await pool.query(`SELECT last_status FROM data_sync_state WHERE scope = $1`, [scope]);
            if (!opts.force && rows[0]?.last_status === 'succeeded') {
                log.info('backfill: season already done for this request; skipping (use --force to redo)', { season });
                continue;
            }
            let loaded = false;
            if (opts.fromCsv) {
                const result = await loadFromWorkDir(ctx, season, {
                    complete: true,
                    includeStats: true,
                    root: path.resolve(opts.fromCsv),
                    allowMassDelete: opts.allowMassDelete
                });
                loaded = !!result;
            } else {
                const outcome = await ingestSeason(ctx, {
                    season,
                    schedules: opts.schedules,
                    boxscores: true,
                    // Default: only what is missing. --force re-fetches everything.
                    incremental: !opts.force,
                    recheckDays: 0,
                    teams: opts.teams,
                    from: opts.from,
                    to: opts.to
                });
                loaded = outcome.loaded;
            }
            loadedAny ||= loaded;
            await markSync(pool, scope, ctx.runId, loaded);
        }
        await finishWithReadModels(ctx, loadedAny && opts.analytics && config.analyticsEnabled);
    });
}

// ---------------------------------------------------------------------------------------

async function refreshGame(pool: Pool, config: WorkerConfig, gameId: number, analytics: boolean, trigger: string) {
    const { rows } = await pool.query(
        `SELECT s.year, h.name AS home, a.name AS away,
                array_agg(DISTINCT gs.source_game_id) AS source_ids
         FROM games g JOIN seasons s ON s.id = g.season_id
         JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id
         LEFT JOIN game_sources gs ON gs.game_id = g.id
         WHERE g.id = $1 GROUP BY s.year, h.name, a.name`,
        [gameId]
    );
    if (!rows[0]) throw new UsageError(`No game with id ${gameId}`);
    const game = rows[0];
    return executeRun(pool, config, { kind: 'refresh-game', trigger, params: { game: gameId, analytics } }, async ctx => {
        await ingestSeason(ctx, {
            season: game.year,
            // Both schools' schedules, for a corrected score; then this game's box score.
            schedules: true,
            boxscores: true,
            incremental: false,
            recheckDays: 0,
            teams: [game.home, game.away],
            sourceGameIds: game.source_ids.filter(Boolean)
        });
        await finishWithReadModels(ctx, analytics && config.analyticsEnabled);
    });
}

async function retry(pool: Pool, config: WorkerConfig, runId?: number): Promise<number> {
    const { rows } = await pool.query(
        runId
            ? `SELECT id::int, kind, params FROM ingestion_runs WHERE id = $1`
            : `SELECT id::int, kind, params FROM ingestion_runs
               WHERE status IN ('failed', 'abandoned') AND kind IN ('nightly', 'backfill', 'refresh-game', 'analytics')
               ORDER BY started_at DESC LIMIT 1`,
        runId ? [runId] : []
    );
    const run = rows[0];
    if (!run) {
        log.info('retry: no failed run to retry');
        return EXIT_OK;
    }
    log.info('retrying run', { run_id: run.id, kind: run.kind });
    const p = run.params;
    const trigger = `retry:${run.id}`;
    switch (run.kind) {
        case 'nightly':
            return nightly(pool, config, { force: true, season: p.season, analytics: p.analytics ?? true }, trigger);
        case 'backfill':
            return backfill(pool, config, { ...p, force: false }, trigger);
        case 'refresh-game':
            return refreshGame(pool, config, p.game, p.analytics, trigger);
        case 'analytics':
            return executeRun(pool, config, { kind: 'analytics', trigger, params: {} }, async ctx => {
                await rebuildAnalytics(ctx);
            });
        default:
            throw new UsageError(`Run ${run.id} is a "${run.kind}" run, which cannot be retried`);
    }
}

// ---------------------------------------------------------------------------------------

async function status(pool: Pool, runId?: number): Promise<number> {
    if (runId) {
        const [run, tasks, errors] = await Promise.all([
            pool.query('SELECT * FROM ingestion_runs WHERE id = $1', [runId]),
            pool.query('SELECT id, season, stage, status, stats, error, started_at, finished_at FROM ingestion_tasks WHERE run_id = $1 ORDER BY id', [runId]),
            pool.query('SELECT category, severity, code, message, count, context, created_at FROM ingestion_errors WHERE run_id = $1 ORDER BY id', [runId])
        ]);
        console.log(JSON.stringify({ run: run.rows[0] ?? null, tasks: tasks.rows, errors: errors.rows }, null, 2));
        return EXIT_OK;
    }
    const [runs, fresh, coverage, failedTasks, errorCounts] = await Promise.all([
        latestRuns(pool, 10),
        freshness(pool),
        seasonCoverage(pool),
        pool.query(
            `SELECT t.run_id, t.season, t.stage, t.error, t.finished_at FROM ingestion_tasks t
             WHERE t.status = 'failed' ORDER BY t.id DESC LIMIT 10`
        ),
        pool.query(
            `SELECT category, code, severity, sum(count)::int AS rows, count(*)::int AS occurrences
             FROM ingestion_errors WHERE created_at > now() - interval '7 days'
             GROUP BY category, code, severity ORDER BY rows DESC`
        )
    ]);
    console.log(
        JSON.stringify(
            {
                freshness: fresh,
                runs: runs.map(r => ({ id: r.id, kind: r.kind, status: r.status, started_at: r.started_at, finished_at: r.finished_at, error: r.error })),
                failed_tasks: failedTasks.rows,
                issues_last_7_days: errorCounts.rows,
                coverage
            },
            null,
            2
        )
    );
    return EXIT_OK;
}

async function health(pool: Pool, config: WorkerConfig): Promise<number> {
    const fresh = await freshness(pool);
    const month = localTime(config.timezone).month;
    const inSeason = config.activeMonths.includes(month);
    const stale = inSeason && (fresh.hours_since_sync === null || fresh.hours_since_sync > config.staleAfterHours);
    log.info('health', { ...fresh, in_season: inSeason, stale });
    if (stale) {
        await notify(config.alertWebhookUrl, `No successful sync for ${fresh.hours_since_sync ?? '∞'} hours`, {
            last_successful_sync: fresh.last_successful_sync ?? 'never',
            latest_run: fresh.latest_run ? `${fresh.latest_run.id} ${fresh.latest_run.kind} ${fresh.latest_run.status}` : 'none'
        });
        return EXIT_FAILED;
    }
    return EXIT_OK;
}

/**
 * Sets the login passwords of the least-privileged roles from the environment
 * (NCADB_API_DB_PASSWORD, NCADB_WORKER_DB_PASSWORD). Values are never logged. A role
 * whose variable is unset is left alone, so this is safe to run on every deploy.
 */
async function provisionRoles(pool: Pool): Promise<number> {
    const roles: [string, string | undefined][] = [
        ['ncadb_api', process.env.NCADB_API_DB_PASSWORD],
        ['ncadb_worker', process.env.NCADB_WORKER_DB_PASSWORD]
    ];
    for (const [role, password] of roles) {
        if (!password) {
            log.warn('role password not provided; left unchanged', { role });
            continue;
        }
        if (password.length < 24) throw new UsageError(`The password for ${role} must be at least 24 characters`);
        // ALTER ROLE cannot take a bind parameter; format(%L) quotes the literal server-side.
        const { rows } = await pool.query<{ sql: string }>('SELECT format($1::text, $2::text) AS sql', [
            `ALTER ROLE ${role} PASSWORD %L`,
            password
        ]);
        await pool.query(rows[0].sql);
        log.info('role password set', { role });
    }
    return EXIT_OK;
}

// ---------------------------------------------------------------------------------------

const USAGE = `Usage: npm run worker -- <command> [options]

  migrate                      (uses MIGRATION_DATABASE_URL when set)
  provision-roles              (sets ncadb_api / ncadb_worker passwords from the environment)
  nightly [--force] [--season YYYY] [--no-analytics]
  backfill (--season YYYY | --seasons A-B) [--team NAME]... [--from YYYY-MM-DD] [--to YYYY-MM-DD]
           [--missing-only] [--force] [--no-schedules] [--from-csv DIR] [--no-analytics] [--allow-mass-delete]
  refresh-game --game ID [--analytics]
  retry [--run ID]
  analytics
  status [--run ID]
  health`;

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === 'help' || has(args, 'help')) {
        console.log(USAGE);
        return EXIT_OK;
    }
    const config = loadConfig();
    const trigger = has(args, 'cron') ? 'cron' : 'manual';
    // Schema changes and role passwords need the owner; everything else runs as the
    // least-privileged ncadb_worker role. MIGRATION_DATABASE_URL is set only where the
    // migrate step runs, so the nightly process never holds owner credentials.
    const ownerCommand = args.command === 'migrate' || args.command === 'provision-roles';
    const pool = createPool({
        max: 4,
        applicationName: `ncadb-worker:${args.command}`,
        connectionString: ownerCommand ? process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL : undefined
    });
    try {
        try {
            await waitForDatabase(pool);
        } catch (err) {
            await notify(config.alertWebhookUrl, 'Worker cannot reach the database', { error: (err as Error).message });
            throw err;
        }
        if (args.command === 'migrate') {
            const result = await migrate(pool);
            log.info('migrations', { ...result });
            return EXIT_OK;
        }
        if (args.command === 'provision-roles') {
            return await provisionRoles(pool);
        }
        await requireMigrated(pool);
        const runId = one(args, 'run') ? Number(one(args, 'run')) : undefined;
        switch (args.command) {
            case 'nightly':
                return await nightly(pool, config, {
                    force: has(args, 'force'),
                    season: one(args, 'season') ? Number(one(args, 'season')) : undefined,
                    analytics: !has(args, 'no-analytics')
                }, trigger);
            case 'backfill':
                return await backfill(pool, config, backfillOptions(args), trigger);
            case 'refresh-game': {
                const game = Number(one(args, 'game'));
                if (!Number.isInteger(game) || game <= 0) throw new UsageError('Give --game ID (the database id from the API)');
                return await refreshGame(pool, config, game, has(args, 'analytics'), trigger);
            }
            case 'retry':
                return await retry(pool, config, runId);
            case 'analytics':
                return await executeRun(pool, config, { kind: 'analytics', trigger, params: {} }, async ctx => {
                    await rebuildAnalytics(ctx);
                });
            case 'status':
                return await status(pool, runId);
            case 'health':
                return await health(pool, config);
            default:
                throw new UsageError(`Unknown command "${args.command}"\n\n${USAGE}`);
        }
    } finally {
        await pool.end().catch(() => undefined);
    }
}

main()
    .then(code => process.exit(code))
    .catch(err => {
        if (err instanceof UsageError) {
            console.error(err.message);
            process.exit(2);
        }
        log.error('worker failed', { error: (err as Error).stack || String(err) });
        process.exit(EXIT_FAILED);
    });
