/**
 * The worker's commands. Every one of them runs to completion and exits: the nightly
 * schedule starts a fresh process, and nothing depends on a terminal or a laptop.
 *
 *   migrate                       apply pending database migrations (owner credentials)
 *   provision-roles               set the least-privileged roles' passwords from the environment
 *   set-role --subject ID --role user|admin --reason TEXT --actor NAME
 *                                 change an account's role, audited (owner credentials)
 *   sync-admins                   make the administrators exactly NCADB_ADMIN_SUBJECTS (owner credentials)
 *   maintenance                   carry out pending admin maintenance requests
 *   nightly [--force] [--season Y] [--no-analytics] [--cron]
 *   backfill (--season Y | --seasons A-B) [--team NAME]... [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *            [--missing-only] [--force] [--no-schedules] [--from-csv DIR] [--no-analytics]
 *   backfill-capture --season Y [--limit N] [--no-analytics]
 *                                 re-read up to N stored box scores (default 150) that predate the
 *                                 current capture version, newest first; re-run to continue
 *   renormalize (--season YYYY | --seasons A-B) [--dry-run] [--no-analytics]
                               (re-apply team identity rules to stored seasons; no network; --dry-run
                                reports what would change, in the run's stats, and keeps nothing)
  reconcile-identities [--apply]
                               (owner credentials; removes team and player rows no data refers to any
                                more, moving users' favorites to the surviving identity; dry run by default)
  refresh-game --game ID [--analytics]
 *   retry [--run ID]              re-run a failed or abandoned run with its original options
 *   team-of-week --season Y       recompute Team of the Week for a season from the database
 *   analytics                     rebuild ratings, forecasts and dashboard files from the database
 *   status [--run ID]             latest runs, failures, freshness and coverage, as JSON
 *   health                        exit 1 (and alert) if data is stale or the database unreachable
 */

import * as path from 'path';
import { Pool } from 'pg';
import {
    computeTeamOfWeek,
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
import { BOXSCORE_CAPTURE_VERSION } from '@ncaa/shared';
import { WorkerConfig, loadConfig } from './config';
import { ingestSeason, loadFromWorkDir, rebuildAnalytics } from './ingest';
import { log } from './log';
import { notify } from './notify';
import { EXIT_FAILED, EXIT_OK, RunContext, executeRun, task } from './run';
import { processMaintenanceRequests } from './maintenance';
import { changeRole, parseAdminSubjects, RoleError, syncAdmins } from './roles';
import { localTime, nightlyGate, seasonFor } from './schedule';
import { reconcileIdentities } from './reconcile';
import { loadInventory, TeamResolver } from './normalize';
import { teamsDir } from './workspace';

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

        await finishWithReadModels(ctx, outcome.loaded && opts.analytics && config.analyticsEnabled, outcome.loaded ? [season] : []);
        await recordCoverage(ctx, season);
        await markSync(pool, 'nightly', ctx.runId, ctx.failures.length === 0, ctx.stats);
    });
}

async function finishWithReadModels(ctx: RunContext, analytics: boolean, seasons: number[] = []): Promise<void> {
    await task(ctx, 'refresh_read_models', null, {}, async () => {
        await refreshReadModels(ctx.pool);
        return { value: true };
    });
    // Team of the Week, for each season this run touched. Only weeks whose inputs (or
    // status) changed are rewritten, so a night with no new box scores writes nothing.
    // It runs after the load, so a failure here is reported without undoing any data.
    for (const season of seasons) {
        await task(ctx, 'team_of_week', season, {}, async () => {
            const result = await computeTeamOfWeek(ctx.pool, season);
            return { value: result, stats: { ...result } };
        });
    }
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
        await finishWithReadModels(ctx, loadedAny && opts.analytics && config.analyticsEnabled, loadedAny ? opts.seasons : []);
    });
}

// ---------------------------------------------------------------------------------------

/** Games in a season whose stored box-score rows predate `version`. */
async function gamesBelowCapture(pool: Pool, season: number, version: number): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(DISTINCT p.game_id) AS n FROM player_game_stats p JOIN seasons s ON s.id = p.season_id
         WHERE s.year = $1 AND p.capture_version < $2`,
        [season, version]
    );
    return Number(rows[0].n);
}

/**
 * Re-reads stored box scores that predate the current capture version, a bounded slice
 * at a time.
 *
 * Bounded so that no single run is a season-long crawl of other people's sites, and
 * resumable without bookkeeping of its own: a game is done once its stored rows carry
 * the version, so the next run simply selects what is still below it. The load is a
 * partial batch — it adds and updates, and never removes a row it did not re-read. Any
 * season works the same way, which is how older seasons are processed later.
 */
async function backfillCapture(
    pool: Pool,
    config: WorkerConfig,
    opts: { season: number; limit: number; analytics: boolean },
    trigger: string
): Promise<number> {
    return executeRun(pool, config, { kind: 'backfill-capture', trigger, params: { ...opts } }, async ctx => {
        const version = BOXSCORE_CAPTURE_VERSION;
        const before = await gamesBelowCapture(pool, opts.season, version);
        ctx.stats.capture = { version, season: opts.season, remaining_before: before };
        if (before === 0) {
            log.info('backfill-capture: nothing below the current capture version', { season: opts.season, version });
            return;
        }
        const outcome = await ingestSeason(ctx, {
            season: opts.season,
            schedules: false,
            boxscores: true,
            incremental: false,
            recheckDays: 0,
            recaptureBelow: version,
            limit: opts.limit
        });
        const after = await gamesBelowCapture(pool, opts.season, version);
        ctx.stats.capture = { version, season: opts.season, remaining_before: before, remaining_after: after };
        log.info('backfill-capture: slice done', { season: opts.season, remaining_before: before, remaining_after: after });
        await finishWithReadModels(ctx, outcome.loaded && opts.analytics && config.analyticsEnabled, outcome.loaded ? [opts.season] : []);
    });
}

/**
 * Re-applies the current team-identity rules to stored seasons, without the network.
 *
 * Each season is exported from the database, normalized again (names cleaned, aliases
 * and Division I membership re-resolved) and loaded as a whole season, which re-keys
 * games whose teams now resolve differently and merges the duplicate fixtures that left
 * behind. Re-running it changes nothing. It is the nightly's own load path, just with no
 * scrape in front of it.
 */
async function renormalize(
    pool: Pool,
    config: WorkerConfig,
    opts: { seasons: number[]; analytics: boolean; dryRun?: boolean },
    trigger: string
): Promise<number> {
    return executeRun(pool, config, { kind: 'renormalize', trigger, params: { ...opts } }, async ctx => {
        const loaded: number[] = [];
        for (const season of opts.seasons) {
            const outcome = await ingestSeason(ctx, {
                season, schedules: false, boxscores: false, incremental: false, recheckDays: 0, dryRun: opts.dryRun
            });
            if (outcome.loaded) loaded.push(season);
        }
        // A dry run changed nothing, so there is nothing to recompute.
        if (opts.dryRun) return;
        await finishWithReadModels(ctx, loaded.length > 0 && opts.analytics && config.analyticsEnabled, loaded);
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
        await finishWithReadModels(ctx, analytics && config.analyticsEnabled, [game.year]);
    });
}

async function retry(pool: Pool, config: WorkerConfig, runId?: number, triggerOverride?: string): Promise<number> {
    const { rows } = await pool.query(
        runId
            ? `SELECT id::int, kind, params FROM ingestion_runs WHERE id = $1`
            : `SELECT id::int, kind, params FROM ingestion_runs
               WHERE status IN ('failed', 'abandoned') AND kind IN ('nightly', 'backfill', 'backfill-capture', 'refresh-game', 'analytics')
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
    const trigger = triggerOverride ?? `retry:${run.id}`;
    switch (run.kind) {
        case 'nightly':
            return nightly(pool, config, { force: true, season: p.season, analytics: p.analytics ?? true }, trigger);
        case 'backfill':
            return backfill(pool, config, { ...p, force: false }, trigger);
        case 'refresh-game':
            return refreshGame(pool, config, p.game, p.analytics, trigger);
        case 'backfill-capture':
            return backfillCapture(pool, config, p, trigger);
        case 'renormalize':
            return renormalize(pool, config, p, trigger);
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
        ['ncadb_worker', process.env.NCADB_WORKER_DB_PASSWORD],
        ['ncadb_accounts', process.env.NCADB_ACCOUNTS_DB_PASSWORD]
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

/** One audited role change by hand (local or break-glass). See roles.ts. */
async function setRole(pool: Pool, args: Args): Promise<number> {
    const role = one(args, 'role');
    if (role !== 'user' && role !== 'admin') throw new UsageError('Give --role user or --role admin');
    try {
        await changeRole(pool, { subject: one(args, 'subject') ?? '', role, reason: one(args, 'reason') ?? '', actor: one(args, 'actor') ?? '' });
    } catch (err) {
        if (err instanceof RoleError) throw new UsageError(err.message);
        throw err;
    }
    return EXIT_OK;
}

/**
 * Makes the administrators exactly NCADB_ADMIN_SUBJECTS (migrate service). Unset: nothing
 * changes, so a missing variable can never demote everyone; set to an empty value it does
 * demote everyone, deliberately.
 */
async function syncAdminsFromEnv(pool: Pool): Promise<number> {
    const subjects = parseAdminSubjects(process.env.NCADB_ADMIN_SUBJECTS);
    if (subjects === undefined) {
        log.info('NCADB_ADMIN_SUBJECTS unset; administrators unchanged');
        return EXIT_OK;
    }
    const reason = process.env.NCADB_ADMIN_CHANGE_REASON?.trim() || 'Administrator list on the migrate service (NCADB_ADMIN_SUBJECTS)';
    const actor = `migrate:${process.env.RAILWAY_DEPLOYMENT_ID ?? 'local'}`;
    try {
        const result = await syncAdmins(pool, subjects, reason, actor);
        log.info('administrators synced', { ...result, admins: subjects.length });
        if (result.pending.length) log.warn('listed administrators have not signed in yet', { pending: result.pending });
    } catch (err) {
        if (err instanceof RoleError) throw new UsageError(err.message);
        throw err;
    }
    return EXIT_OK;
}

/** Carries out pending admin requests. Never fails the caller: problems are recorded per request. */
async function maintenance(pool: Pool, config: WorkerConfig): Promise<number> {
    try {
        const processed = await processMaintenanceRequests(pool, {
            retryRun: (runId, trigger) => retry(pool, config, runId, trigger),
            rebuildAnalytics: trigger =>
                executeRun(pool, config, { kind: 'analytics', trigger, params: {} }, async ctx => {
                    await rebuildAnalytics(ctx);
                })
        });
        if (processed > 0) log.info('maintenance requests processed', { count: processed });
    } catch (err) {
        log.error('maintenance processing failed', { error: (err as Error).message });
    }
    return EXIT_OK;
}

// ---------------------------------------------------------------------------------------

const USAGE = `Usage: npm run worker -- <command> [options]

  migrate                      (uses MIGRATION_DATABASE_URL when set)
  provision-roles              (sets ncadb_api / ncadb_worker / ncadb_accounts passwords from the environment)
  set-role --subject ID --role user|admin --reason TEXT --actor NAME   (owner credentials; audited)
  sync-admins                  (owner credentials; administrators = NCADB_ADMIN_SUBJECTS, audited)
  maintenance                  (pending admin maintenance requests)
  nightly [--force] [--season YYYY] [--no-analytics]
  backfill (--season YYYY | --seasons A-B) [--team NAME]... [--from YYYY-MM-DD] [--to YYYY-MM-DD]
           [--missing-only] [--force] [--no-schedules] [--from-csv DIR] [--no-analytics] [--allow-mass-delete]
  backfill-capture --season YYYY [--limit N] [--no-analytics]
                               (re-read stored box scores below the current capture version; re-run to continue)
  refresh-game --game ID [--analytics]
  retry [--run ID]
  team-of-week --season YYYY   (recompute Team of the Week weeks whose inputs changed)
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
    const ownerCommand = ['migrate', 'provision-roles', 'set-role', 'sync-admins', 'reconcile-identities'].includes(args.command);
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
        if (args.command === 'set-role') {
            return await setRole(pool, args);
        }
        if (args.command === 'sync-admins') {
            return await syncAdminsFromEnv(pool);
        }
        await requireMigrated(pool);
        const runId = one(args, 'run') ? Number(one(args, 'run')) : undefined;
        switch (args.command) {
            case 'nightly': {
                const code = await nightly(pool, config, {
                    force: has(args, 'force'),
                    season: one(args, 'season') ? Number(one(args, 'season')) : undefined,
                    analytics: !has(args, 'no-analytics')
                }, trigger);
                // Admin requests run after the scheduled work, on the same ingestion lock
                // discipline, and never change the scheduled run's exit status.
                if (trigger === 'cron') await maintenance(pool, config);
                return code;
            }
            case 'maintenance':
                return await maintenance(pool, config);
            case 'backfill':
                return await backfill(pool, config, backfillOptions(args), trigger);
            case 'reconcile-identities': {
                const apply = has(args, 'apply');
                const report = await reconcileIdentities(pool, new TeamResolver(loadInventory(teamsDir(config.codeRoot))), apply);
                log.info('reconcile-identities', {
                    applied: report.applied,
                    teams: report.teams.length,
                    teams_with_successor: report.teams.filter(t => t.successor).length,
                    players: report.players.length,
                    players_with_successor: report.players.filter(p => p.successor).length,
                    ...report.favorites
                });
                console.log(JSON.stringify(report, null, 2));
                return EXIT_OK;
            }
            case 'renormalize':
                return await renormalize(
                    pool, config, { seasons: seasonsFrom(args), analytics: !has(args, 'no-analytics'), dryRun: has(args, 'dry-run') }, trigger);
            case 'backfill-capture': {
                const season = Number(one(args, 'season'));
                if (!Number.isInteger(season) || season < 1990) throw new UsageError('Give --season YYYY');
                const limit = one(args, 'limit') ? Number(one(args, 'limit')) : 150;
                if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new UsageError('--limit must be 1-2000');
                return await backfillCapture(pool, config, { season, limit, analytics: !has(args, 'no-analytics') }, trigger);
            }
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
            case 'team-of-week': {
                const season = Number(one(args, 'season'));
                if (!Number.isInteger(season) || season < 1990) throw new UsageError('Give --season YYYY');
                return await executeRun(pool, config, { kind: 'team-of-week', trigger, params: { season } }, async ctx => {
                    await task(ctx, 'team_of_week', season, {}, async () => {
                        const result = await computeTeamOfWeek(ctx.pool, season);
                        return { value: result, stats: { ...result } };
                    });
                });
            }
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
