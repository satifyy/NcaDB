/**
 * Scrape-and-load for one season, and the analytics rebuild.
 *
 *   hydrate  write the season's stored rows into the scratch tree
 *   scrape   run the existing schedule and box-score stages against it
 *   load     validate what they wrote and upsert it in one transaction
 *
 * The scrapers stay exactly as they are on a laptop — they merge into what is on disk,
 * skip box scores already stored, keep rows a transient failure would otherwise lose,
 * and refuse a stage that shrinks a season. The database is what persists between runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    LoadResult,
    loadSeason,
    recordIssues,
    markSync,
    saveArtifacts,
    seasonsInDatabase
} from '@ncaa/database';
import { writeRows, headerFrom } from '@ncaa/storage';
import { buildSeasonBatch, loadInventory, TeamResolver } from './normalize';
import { RunContext, task } from './run';
import { runScript } from './stages';
import {
    collectDashboardArtifacts,
    gamesFile,
    hydrateSeason,
    inventoryFile,
    pipelineState,
    prepareWorkDir,
    readSeason,
    teamsDir
} from './workspace';
import { log } from './log';

export interface SeasonPlan {
    season: number;
    /** Scrape schedules (discovers games, results, score corrections). */
    schedules: boolean;
    /** Scrape box scores. */
    boxscores: boolean;
    /** Only box scores that are missing or within `recheckDays`; otherwise re-fetch all. */
    incremental: boolean;
    recheckDays: number;
    /** Restrict to these teams (names or inventory ids). */
    teams?: string[];
    /** Restrict box scores to games on or after / before these dates (YYYY-MM-DD). */
    from?: string;
    to?: string;
    /** Restrict box scores to these scraper game ids. */
    sourceGameIds?: string[];
    /**
     * Re-read only games whose stored rows predate this box-score capture version,
     * newest first (see `backfill-capture`). Implies a partial, add-and-update load.
     */
    recaptureBelow?: number;
    /** At most this many box scores in this run. */
    limit?: number;
    /** Load inside a transaction that is rolled back; report what would change. */
    dryRun?: boolean;
}

export interface SeasonOutcome {
    season: number;
    loaded: boolean;
    result?: LoadResult;
}

const filtered = (plan: SeasonPlan) =>
    !!(plan.teams?.length || plan.from || plan.to || plan.sourceGameIds?.length || plan.recaptureBelow || plan.limit);

function addCounts(ctx: RunContext, result: LoadResult): void {
    const totals = (ctx.stats.totals as Record<string, number>) ?? {};
    const add = (key: string, n: number) => (totals[key] = (totals[key] ?? 0) + n);
    add('games_inserted', result.games.inserted);
    add('games_updated', result.games.updated);
    add('games_unchanged', result.games.unchanged);
    add('player_stats_inserted', result.playerStats.inserted);
    add('player_stats_updated', result.playerStats.updated);
    add('player_stats_unchanged', result.playerStats.unchanged);
    add('player_stats_deleted', result.playerStats.deleted);
    add('players_inserted', result.players.inserted);
    add('teams_inserted', result.teams.inserted);
    add('rejected_rows', result.issues.filter(i => i.category === 'validation').reduce((n, i) => n + i.count, 0));
    ctx.stats.totals = totals;
}

/** Writes an inventory holding only the requested teams, for a targeted schedule scrape. */
function writeTeamFilter(ctx: RunContext, teams: string[]): { file: string; names: Set<string> } {
    const inventory = loadInventory(teamsDir(ctx.config.workDir));
    const resolver = new TeamResolver(inventory);
    const wanted = new Set(teams.map(t => resolver.resolve(t)?.slug).filter((s): s is string => !!s));
    const subset = inventory.teams.filter(t => wanted.has(resolver.resolve(t.name_canonical)!.slug) || teams.includes(t.team_id));
    const file = path.join(ctx.config.workDir, 'tmp/inventory_filter.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(subset, null, 2));
    return { file, names: new Set(subset.map(t => t.name_canonical)) };
}

/** Writes the subset of a season's games a targeted box-score scrape should read. */
function writeGameFilter(ctx: RunContext, plan: SeasonPlan): { file: string; count: number } {
    const { games } = readSeason(ctx.config.workDir, plan.season);
    const inventory = loadInventory(teamsDir(ctx.config.workDir));
    const resolver = new TeamResolver(inventory);
    const teamSlugs = new Set((plan.teams ?? []).map(t => resolver.resolve(t)?.slug).filter(Boolean));
    const ids = new Set(plan.sourceGameIds ?? []);
    const subset = games.filter(g => {
        if (plan.from && g.date < plan.from) return false;
        if (plan.to && g.date > plan.to) return false;
        if (ids.size > 0 && !ids.has(g.game_id)) return false;
        if (teamSlugs.size > 0) {
            const home = resolver.resolve(g.home_team_name)?.slug;
            const away = resolver.resolve(g.away_team_name)?.slug;
            if (!teamSlugs.has(home) && !teamSlugs.has(away)) return false;
        }
        return true;
    });
    // Named games.csv inside a season directory, because that is the shape the
    // box-score stage expects — but in tmp/, so the season's own file is untouched.
    const file = path.join(ctx.config.workDir, 'tmp/games', String(plan.season), 'games.csv');
    fs.rmSync(file, { force: true });
    if (subset.length > 0) writeRows(file, subset, headerFrom(subset));
    return { file, count: subset.length };
}

export async function ingestSeason(ctx: RunContext, plan: SeasonPlan): Promise<SeasonOutcome> {
    const { config } = ctx;
    const season = plan.season;
    prepareWorkDir(config);

    const hydrated = await task(ctx, 'hydrate', season, {}, async () => {
        const counts = await hydrateSeason(ctx.pool, config.workDir, season);
        return { value: counts, stats: counts };
    });
    if (!hydrated) return { season, loaded: false };

    const scrape = await task(ctx, 'scrape', season, { ...plan }, async () => {
        let schedulesOk = !plan.schedules;
        let boxscoresOk = !plan.boxscores;
        const stats: Record<string, unknown> = {};

        if (!plan.schedules && !plan.boxscores) {
            // Nothing to scrape (`renormalize`). The pipeline must not be started at all:
            // `--only` with no stage means every stage to it.
            stats.skipped = 'no stages requested';
        } else if (!filtered(plan)) {
            const stages = [plan.schedules && 'schedules', plan.boxscores && 'boxscores'].filter(Boolean).join(',');
            const args = [
                '--season', String(season), '--only', stages, '--force',
                '--teams', inventoryFile(config.workDir),
                '--max-drop', String(config.maxDropPct)
            ];
            if (plan.incremental) args.push('--incremental', '--recheck-days', String(plan.recheckDays));
            const result = await runScript(config, 'run_pipeline.ts', args);
            const state = pipelineState(config.workDir, season);
            if (plan.schedules) schedulesOk = state.schedules?.status === 'ok';
            if (plan.boxscores) boxscoresOk = state.boxscores?.status === 'ok';
            Object.assign(stats, { exit_code: result.code, seconds: result.seconds, stages: state });
            if (result.code !== 0) stats.tail = result.tail.slice(-15);
        } else {
            if (plan.schedules) {
                const filter = plan.teams?.length ? writeTeamFilter(ctx, plan.teams) : undefined;
                if (filter && filter.names.size === 0) {
                    stats.schedules = 'skipped: none of the requested teams is in the inventory';
                    schedulesOk = true;
                } else {
                    const result = await runScript(config, 'run_pipeline.ts', [
                        '--season', String(season), '--only', 'schedules', '--force', '--no-preflight',
                        '--teams', filter?.file ?? inventoryFile(config.workDir),
                        '--max-drop', String(config.maxDropPct)
                    ]);
                    schedulesOk = pipelineState(config.workDir, season).schedules?.status === 'ok';
                    stats.schedules = { exit_code: result.code, seconds: result.seconds };
                }
            }
            if (plan.boxscores) {
                const games = writeGameFilter(ctx, plan);
                stats.selected_games = games.count;
                if (games.count === 0) {
                    boxscoresOk = true;
                } else {
                    const args = [games.file];
                    if (plan.limit) args.push(String(plan.limit));
                    if (plan.recaptureBelow) args.push('--recapture-below', String(plan.recaptureBelow));
                    if (plan.incremental) args.push('--new-only', '--recheck-days', String(plan.recheckDays));
                    const result = await runScript(config, 'fetch_boxscores_from_csv.ts', args);
                    boxscoresOk = result.code === 0;
                    stats.boxscores = { exit_code: result.code, seconds: result.seconds };
                    if (result.code !== 0) stats.tail = result.tail.slice(-15);
                }
            }
        }
        const failed = [!schedulesOk && 'schedules', !boxscoresOk && 'boxscores'].filter(Boolean);
        return {
            value: { schedulesOk, boxscoresOk },
            stats,
            failed: failed.length ? `${failed.join(' and ')} stage failed (see task stats and logs)` : undefined
        };
    });
    if (!scrape || !scrape.schedulesOk) return { season, loaded: false };

    const result = await loadFromWorkDir(ctx, season, {
        // A whole-season scrape that fully succeeded is the authority on which rows
        // exist. Anything narrower only adds and updates.
        complete: !filtered(plan) && scrape.schedulesOk && scrape.boxscoresOk,
        // A box-score stage that failed may have written a thinner file; its rows are
        // not trusted. The schedules it ran after still are.
        includeStats: scrape.boxscoresOk,
        dryRun: plan.dryRun
    });
    return { season, loaded: !!result && !plan.dryRun, result };
}

export async function loadFromWorkDir(
    ctx: RunContext,
    season: number,
    options: { complete: boolean; includeStats: boolean; root?: string; allowMassDelete?: boolean; dryRun?: boolean }
): Promise<LoadResult | undefined> {
    const root = options.root ?? ctx.config.workDir;
    return task(ctx, 'load', season, { complete: options.complete, include_stats: options.includeStats }, async taskId => {
        const { games, stats } = readSeason(root, season);
        if (games.length === 0) {
            return { value: undefined as unknown as LoadResult, failed: `no games.csv rows for ${season}` };
        }
        const inventory = loadInventory(teamsDir(root));
        const { batch, issues } = buildSeasonBatch(season, games, options.includeStats ? stats : [], inventory, options.complete);
        const result = await loadSeason(ctx.pool, { ...batch, allowMassDelete: options.allowMassDelete, dryRun: options.dryRun });
        const allIssues = [...issues, ...result.issues];
        if (result.dryRun) {
            // Nothing was kept: no issues recorded, no sync marked, nothing counted as loaded.
            const summary = {
                games: result.games, game_sources: result.gameSources, player_stats: result.playerStats,
                players_inserted: result.players.inserted, teams_inserted: result.teams.inserted,
                rekeyed: result.rekeyed, after: result.after,
                issues: Object.fromEntries(allIssues.map(i => [i.code, i.count]))
            };
            log.info('season dry run (rolled back)', { run_id: ctx.runId, season, ...summary });
            return { value: result, stats: { dry_run: true, ...summary } };
        }
        await recordIssues(ctx.pool, ctx.runId, taskId, season, allIssues);
        result.issues = allIssues;
        addCounts(ctx, result);
        await markSync(ctx.pool, `season:${season}`, ctx.runId, true, {
            games: result.games,
            player_stats: result.playerStats
        });
        log.info('season loaded', {
            run_id: ctx.runId,
            season,
            games: result.games,
            player_stats: result.playerStats,
            issues: allIssues.map(i => `${i.code}:${i.count}`)
        });
        return {
            value: result,
            stats: {
                games: result.games,
                game_sources: result.gameSources,
                player_stats: result.playerStats,
                players_inserted: result.players.inserted,
                teams_inserted: result.teams.inserted,
                issues: Object.fromEntries(allIssues.map(i => [i.code, i.count]))
            }
        };
    });
}

/**
 * Recomputes ratings, forecasts, impact and the per-season player files from the whole
 * database, and stores them for the API. Needs no network: a few minutes of CPU.
 */
export async function rebuildAnalytics(ctx: RunContext): Promise<boolean> {
    const { config } = ctx;
    const done = await task(ctx, 'analytics', null, {}, async () => {
        prepareWorkDir(config);
        fs.rmSync(path.join(config.workDir, 'apps/dashboard/src/data'), { recursive: true, force: true });
        const seasons = await seasonsInDatabase(ctx.pool);
        for (const season of seasons) await hydrateSeason(ctx.pool, config.workDir, season);
        for (const season of seasons) {
            if (!fs.existsSync(gamesFile(config.workDir, season))) continue;
            const result = await runScript(config, 'aggregate_player_stats.ts', [String(season)]);
            if (result.code !== 0) return { value: false, failed: `aggregate ${season} failed` };
        }
        const result = await runScript(config, 'run_pipeline.ts', [
            '--only', 'ratings,predictions,dashboard,analytics', '--force'
        ]);
        if (result.code !== 0) {
            return { value: false, stats: { tail: result.tail.slice(-15) }, failed: 'analytics stages failed' };
        }
        const artifacts = collectDashboardArtifacts(config.workDir);
        if (artifacts.length === 0) return { value: false, failed: 'analytics produced no files' };
        const saved = await saveArtifacts(ctx.pool, ctx.runId, artifacts);
        ctx.stats.artifacts = { files: artifacts.length, ...saved };
        return { value: true, stats: { seasons, files: artifacts.length, ...saved, seconds: result.seconds } };
    });
    return !!done;
}
