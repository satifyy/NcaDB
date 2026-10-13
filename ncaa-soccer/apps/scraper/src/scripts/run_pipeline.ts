/**
 * Runs the whole pipeline for one or more seasons, unattended.
 *
 * The four stages have always been four commands typed in order. That is fine for one
 * season and unworkable for five: a full backfill is roughly six hours, most of it in the
 * box-score stage, so it will be interrupted — a laptop sleeps, a runner times out, a
 * site rate-limits — and starting again from the top each time is what makes the backfill
 * never finish. So progress is written to a state file as each stage completes and a
 * re-run resumes from the first stage that has not.
 *
 * Stages run as separate processes rather than as imports. They are written as scripts
 * with their own `process.exit` paths, and the box-score stage drives Playwright in
 * batches whose memory is only reclaimed when the process ends.
 *
 * Usage:
 *   npx tsx apps/scraper/src/scripts/run_pipeline.ts --season 2025
 *   npx tsx apps/scraper/src/scripts/run_pipeline.ts --seasons 2021-2025
 *   npx tsx apps/scraper/src/scripts/run_pipeline.ts --seasons 2021-2025 --force
 *   npx tsx apps/scraper/src/scripts/run_pipeline.ts --season 2025 --only schedules
 *   npx tsx apps/scraper/src/scripts/run_pipeline.ts --season 2025 --dry-run
 *
 * Options:
 *   --season <year>        One season (defaults to the current calendar year).
 *   --seasons <a>-<b>      An inclusive range, oldest first.
 *   --teams <file>         Inventory to scrape (default `data/teams/d1_msoc_teams.json`).
 *   --only <stage,...>     Run just these stages.
 *   --skip <stage,...>     Run everything except these.
 *   --force                Re-run stages already recorded complete.
 *   --incremental          Fetch only box scores that are missing or recent. This is
 *                          what a daily in-season refresh wants; a backfill does not.
 *   --no-preflight         Skip the season-availability check.
 *   --max-drop <percent>   How much of a season's rows a stage may lose against what is
 *                          already on disk before it counts as failed (default 3).
 *   --no-row-guard         Do not check row counts at all. For a deliberate rebuild that
 *                          is expected to shrink a season.
 *   --dry-run              Print the plan and exit.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    aggregatedStatsCsv,
    gamesCsv,
    playerStatsCsv,
    REPO_ROOT as DATA_ROOT,
    streamRowsIfExists
} from '@ncaa/storage';

// Where the stage scripts are, and what they are run from. Resolved separately from
// `@ncaa/storage`'s `DATA_ROOT`, which `NCAA_REPO_ROOT` can point at a fixture tree: the
// scripts have to be found where they actually live either way.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPTS = path.join(REPO_ROOT, 'apps/scraper/src/scripts');
const STATE_PATH = path.join(REPO_ROOT, 'data/pipeline_state.json');
const DEFAULT_TEAMS = 'data/teams/d1_msoc_teams.json';

/**
 * How much of a season a stage may lose before the run stops.
 *
 * Three percent is roughly half a dozen fixtures out of a 2,300-row season, or one
 * school's box scores out of a hundred and ninety-seven. Below that is the ordinary
 * churn of cancellations and re-normalisation; above it, something has broken quietly.
 */
const DEFAULT_MAX_DROP_PCT = 3;

type StageName = 'schedules' | 'boxscores' | 'aggregate' | 'ratings' | 'predictions' | 'dashboard' | 'analytics';

interface Stage {
    name: StageName;
    /** Human-readable, for the plan and the summary. */
    describe: string;
    /** Arguments to the stage script, given the season being run. */
    command: (season: number, options: Options) => string[];
    /**
     * Whether this stage runs once per pipeline rather than once per season.
     *
     * The dashboard reads a single season, so building it for 2021 and then again for
     * every later year just overwrites its own output four times.
     */
    oncePerRun?: boolean;
    /**
     * The CSV this stage's yield lands in, if it has one. Row-count guarded; see
     * {@link guardRowCount}.
     */
    output?: (season: number) => string;
}

const STAGES: Stage[] = [
    {
        name: 'schedules',
        describe: 'fetch schedules into data/games/<season>/games.csv',
        command: (season, options) => [
            path.join(SCRIPTS, 'fetch_schedules_parallel.ts'),
            options.teams,
            String(season)
        ],
        output: season => gamesCsv(String(season))
    },
    {
        name: 'boxscores',
        describe: 'fetch box scores into data/player_stats/<season>/player_stats.csv',
        command: (season, options) => [
            path.join(SCRIPTS, 'fetch_boxscores_from_csv.ts'),
            `data/games/${season}/games.csv`,
            ...(options.incremental ? ['--new-only'] : [])
        ],
        output: season => playerStatsCsv(String(season))
    },
    {
        name: 'aggregate',
        describe: 'total each player’s season',
        command: season => [path.join(SCRIPTS, 'aggregate_player_stats.ts'), String(season)],
        output: season => aggregatedStatsCsv(String(season))
    },
    {
        name: 'ratings',
        describe: 'judge each season’s coverage, then rate teams and value players',
        command: () => [path.join(SCRIPTS, 'build_ratings.ts')],
        oncePerRun: true
    },
    {
        name: 'predictions',
        describe: 'forecast every week from the ratings it was played at',
        command: season => [path.join(SCRIPTS, 'build_predictions.ts'), '--season', String(season)],
        oncePerRun: true
    },
    {
        name: 'dashboard',
        describe: 'write the dashboard’s per-season player JSON',
        command: season => [path.join(SCRIPTS, 'generate_dashboard_data.ts'), String(season)],
        oncePerRun: true
    },
    {
        name: 'analytics',
        describe: 'write the dashboard’s ratings, forecasts and impact JSON',
        command: () => [path.join(SCRIPTS, 'generate_dashboard_analytics.ts')],
        oncePerRun: true
    }
];

/**
 * Stages that run over the whole dataset rather than one season, in dependency order.
 *
 * `ratings` decides which seasons are usable and writes `season_coverage.json`; both
 * dashboard stages read that verdict and `predictions` reads the fitted model, so the
 * order these appear in {@link STAGES} is the order they have to run in.
 */

interface StageRecord {
    status: 'ok' | 'failed';
    at: string;
    seconds: number;
    /** Rows in the stage's output CSV before and after it ran, where it writes one. */
    rows?: { before: number; after: number };
}

interface PipelineState {
    updated_at: string;
    seasons: Record<string, Partial<Record<StageName, StageRecord>>>;
}

function readState(): PipelineState {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return { updated_at: '', seasons: {} };
    }
}

function writeState(state: PipelineState): void {
    state.updated_at = new Date().toISOString();
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 4)}\n`);
}

/** Runs a stage script to completion, streaming its output, and resolves its exit code. */
function run(args: string[]): Promise<number> {
    return new Promise(resolve => {
        const child = spawn('npx', ['tsx', ...args], {
            cwd: REPO_ROOT,
            stdio: 'inherit',
            env: process.env
        });
        child.on('close', code => resolve(code ?? 1));
        child.on('error', err => {
            console.error(`Could not start stage: ${err.message}`);
            resolve(1);
        });
    });
}

/**
 * Rows in a CSV, or 0 when it is not there yet.
 *
 * Streamed and parsed rather than counted with newlines: a player name can carry a comma
 * or a quote, `escapeCsv` wraps it, and a wrapped field is allowed to span lines. Being
 * off by one row would not matter; being off by a rule that only bites on the rows
 * hardest to notice missing would.
 */
async function countRows(file: string): Promise<number> {
    let rows = 0;
    try {
        for await (const _row of streamRowsIfExists(file, { relaxColumnCount: true })) rows++;
    } catch (err) {
        console.warn(`Could not count rows in ${file}: ${(err as Error).message}`);
        return 0;
    }
    return rows;
}

/**
 * Refuses a stage that came back with materially less data than it started with.
 *
 * The golden fixtures in `packages/parsers/src/__fixtures__` pin the shapes we know
 * about; this is the net under them. A school re-themes a page, a JSON field is renamed,
 * a site starts serving a consent wall to datacentre IPs — the scrape still exits 0 and
 * still writes a file, just a thinner one, and every stage downstream goes on to rate
 * teams on whatever is left. Nothing in the run says anything went wrong.
 *
 * Comparing against what is already on disk costs one pass over a CSV and needs no
 * knowledge of what the sites look like, which is the point: it catches the changes no
 * fixture anticipated. It only ever compares a season against its own history, so a
 * season being scraped for the first time is unguarded — there is nothing to have lost.
 *
 * The tolerance is a few percent rather than zero because genuine shrinkage happens: a
 * school cancels a fixture, a re-scrape collapses two spellings of one opponent onto a
 * single row. Losing a tenth of a season does not happen for a good reason.
 *
 * @returns the new count, and a description of the drop when it is too large
 */
async function guardRowCount(
    file: string,
    before: number,
    maxDropPct: number
): Promise<{ after: number; failure?: string }> {
    const after = await countRows(file);
    const dropped = before - after;
    if (before === 0 || dropped <= 0) return { after };

    const droppedPct = (dropped / before) * 100;
    if (droppedPct <= maxDropPct) return { after };

    return {
        after,
        failure:
            `${path.relative(DATA_ROOT, file)} lost ${dropped} of ${before} rows ` +
            `(${droppedPct.toFixed(1)}%, tolerance ${maxDropPct}%)`
    };
}

/** A mistake in the command line, reported as a message rather than a stack trace. */
class UsageError extends Error {}

interface Options {
    seasons: number[];
    teams: string;
    stages: Stage[];
    force: boolean;
    preflight: boolean;
    dryRun: boolean;
    /** Fetch only box scores that are missing or still likely to change. */
    incremental: boolean;
    /** Fail a stage whose output CSV shrinks by more than this many percent. */
    maxDropPct: number;
    /** Whether to apply that check at all. */
    rowGuard: boolean;
}

function parseArgs(argv: string[]): Options {
    const value = (flag: string): string | undefined => {
        const at = argv.indexOf(flag);
        return at === -1 ? undefined : argv[at + 1];
    };

    let seasons: number[];
    const range = value('--seasons');
    if (range) {
        const [from, to] = range.split('-').map(Number);
        if (!from || !to || to < from) throw new UsageError(`Bad --seasons range: ${range}`);
        seasons = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    } else {
        seasons = [Number(value('--season')) || new Date().getFullYear()];
    }

    const names = (flag: string): StageName[] =>
        (value(flag) || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean) as StageName[];

    const only = names('--only');
    const skip = new Set(names('--skip'));
    const known = new Set(STAGES.map(stage => stage.name));
    for (const name of [...only, ...skip]) {
        if (!known.has(name)) {
            throw new UsageError(`Unknown stage "${name}". Known stages: ${[...known].join(', ')}`);
        }
    }

    let stages = only.length > 0 ? STAGES.filter(stage => only.includes(stage.name)) : STAGES;
    stages = stages.filter(stage => !skip.has(stage.name));

    const drop = value('--max-drop');
    const maxDropPct = drop === undefined ? DEFAULT_MAX_DROP_PCT : Number(drop);
    if (!Number.isFinite(maxDropPct) || maxDropPct < 0 || maxDropPct > 100) {
        throw new UsageError(`Bad --max-drop: ${drop}. Give a percentage between 0 and 100.`);
    }

    return {
        seasons,
        teams: value('--teams') || DEFAULT_TEAMS,
        stages,
        force: argv.includes('--force'),
        preflight: !argv.includes('--no-preflight'),
        dryRun: argv.includes('--dry-run'),
        incremental: argv.includes('--incremental'),
        maxDropPct,
        rowGuard: !argv.includes('--no-row-guard')
    };
}

function hhmmss(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const state = readState();

    const perSeason = options.stages.filter(stage => !stage.oncePerRun);
    const perRun = options.stages.filter(stage => stage.oncePerRun);

    console.log(`Seasons:   ${options.seasons.join(', ')}`);
    console.log(`Inventory: ${options.teams}`);
    console.log(`Stages:    ${options.stages.map(stage => stage.name).join(' -> ') || '(none)'}`);
    console.log(`Resume:    ${options.force ? 'off (--force re-runs everything)' : `on, from ${STATE_PATH}`}`);
    console.log(
        `Row guard: ${options.rowGuard ? `on, a stage may lose up to ${options.maxDropPct}% of a season` : 'off (--no-row-guard)'}\n`
    );

    if (options.dryRun) {
        for (const season of options.seasons) {
            for (const stage of perSeason) {
                const done = !options.force && state.seasons[season]?.[stage.name]?.status === 'ok';
                const guard =
                    options.rowGuard && stage.output && !done
                        ? `  [guards ${path.relative(DATA_ROOT, stage.output(season))}]`
                        : '';
                console.log(`  ${season} ${stage.name.padEnd(12)} ${done ? 'skip (done)' : stage.describe}${guard}`);
            }
        }
        // No season against these: they run once over the whole dataset.
        for (const stage of perRun) {
            console.log(`  all  ${stage.name.padEnd(12)} ${stage.describe}`);
        }
        return;
    }

    if (options.preflight && perSeason.some(stage => stage.name === 'schedules')) {
        console.log('--- preflight: are these seasons published? ---');
        const code = await run([path.join(SCRIPTS, 'preflight_seasons.ts'), ...options.seasons.map(String)]);
        if (code !== 0) {
            console.error('\nPreflight failed. Nothing was scraped. Re-run with --no-preflight to override.');
            process.exit(1);
        }
        console.log('');
    }

    const failures: string[] = [];

    for (const season of options.seasons) {
        state.seasons[season] ||= {};
        for (const stage of perSeason) {
            const previous = state.seasons[season][stage.name];
            if (!options.force && previous?.status === 'ok') {
                console.log(`--- ${season} ${stage.name}: already done ${previous.at}, skipping ---`);
                continue;
            }

            console.log(`\n--- ${season} ${stage.name}: ${stage.describe} ---`);
            // Counted before the stage runs, because the stage overwrites the file it is
            // being judged against.
            const guardedOutput = options.rowGuard ? stage.output?.(season) : undefined;
            const before = guardedOutput ? await countRows(guardedOutput) : 0;

            const started = Date.now();
            const code = await run(stage.command(season, options));
            const seconds = (Date.now() - started) / 1000;

            // A stage that exited non-zero is already a failure; re-counting its output
            // would only report the same thing twice, in less useful words.
            const check =
                guardedOutput && code === 0
                    ? await guardRowCount(guardedOutput, before, options.maxDropPct)
                    : undefined;

            const failed = code !== 0 || check?.failure !== undefined;
            state.seasons[season][stage.name] = {
                status: failed ? 'failed' : 'ok',
                at: new Date().toISOString(),
                seconds: Math.round(seconds),
                ...(check ? { rows: { before, after: check.after } } : {})
            };
            writeState(state);

            if (check?.failure) {
                console.error(`--- ${season} ${stage.name} FAILED the row check: ${check.failure} ---`);
                console.error('The stage reported success, so this is a source or parser change rather');
                console.error('than a crash. Check the stage output above for the schools that returned');
                console.error('nothing, then either fix the parser or re-run with --no-row-guard if the');
                console.error('season really is meant to shrink.');
            } else if (code !== 0) {
                console.error(`--- ${season} ${stage.name} FAILED after ${hhmmss(seconds)} (exit ${code}) ---`);
            }

            if (failed) {
                failures.push(`${season}/${stage.name}`);
                // The rest of this season depends on this stage's output, so move on to
                // the next season rather than aggregating a file that was never written.
                break;
            }

            const grew = check && check.after !== before ? `, ${before} -> ${check.after} rows` : '';
            console.log(`--- ${season} ${stage.name} ok in ${hhmmss(seconds)}${grew} ---`);
        }
    }

    // The dashboard opens on the newest season that has totals to show — the newest on
    // disk, not the newest in this run. A backfill of 2016-2020 must not leave the site
    // opening on 2020 while 2026 is being played. Asking the disk rather than this run's
    // state also means `--only dashboard` works on a fresh checkout, where nothing has
    // been recorded but the CSVs are right there.
    const statsDir = path.join(REPO_ROOT, 'data/player_stats');
    const aggregated = (fs.existsSync(statsDir) ? fs.readdirSync(statsDir) : [])
        .filter(name => /^\d{4}$/.test(name))
        .filter(name => fs.existsSync(path.join(statsDir, name, 'aggregated_player_stats.csv')))
        .sort();
    const newest = aggregated[aggregated.length - 1];

    // Every stage left reads the whole dataset rather than one season's file, so running
    // them after a season stopped part-way rates teams, forecasts fixtures and rebuilds
    // the dashboard on a season that is missing whatever the failed stage did not fetch —
    // and overwrites the last good copy of all four with it. The per-season CSVs that did
    // land stay: they are correct as far as they go, and re-running resumes from them.
    // Nothing derived from them is rebuilt until the scrape is whole again.
    if (failures.length > 0 && perRun.length > 0) {
        console.error(
            `\n--- skipping ${perRun.map(stage => stage.name).join(', ')}: ` +
                `${failures.join(', ')} failed ---`
        );
        console.error('These read every season, so building them now would publish a partial one.');
        console.error('Fix the failure and re-run; the stages that succeeded are skipped.');
    }

    for (const stage of failures.length > 0 ? [] : perRun) {
        if (newest === undefined) {
            console.log(`\n--- ${stage.name}: skipped, no season has aggregated stats on disk ---`);
            continue;
        }
        console.log(`\n--- ${stage.name} (${newest}): ${stage.describe} ---`);
        if ((await run(stage.command(Number(newest), options))) !== 0) {
            failures.push(`${newest}/${stage.name}`);
        }
    }

    console.log('\n=== summary ===');
    for (const season of options.seasons) {
        const record = state.seasons[season] || {};
        const line = STAGES.filter(stage => !stage.oncePerRun)
            .map(stage => `${stage.name}=${record[stage.name]?.status ?? '-'}`)
            .join('  ');
        console.log(`  ${season}  ${line}`);
    }

    if (failures.length > 0) {
        console.error(`\n${failures.length} stage(s) failed: ${failures.join(', ')}`);
        console.error('Re-run the same command to resume; completed stages are skipped.');
        process.exit(1);
    }
    console.log('\nPipeline complete.');
}

main().catch(err => {
    if (err instanceof UsageError) console.error(err.message);
    else console.error('Fatal error:', err);
    process.exit(1);
});
