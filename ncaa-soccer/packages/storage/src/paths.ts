/**
 * Where the data lives, in one place.
 *
 * Every script used to resolve these for itself, which meant six different spellings of
 * the same directory: `path.resolve(__dirname, '../../../..')` from two different depths,
 * `process.cwd()` in the aggregate stage — which silently wrote to the wrong place when
 * run from anywhere but the repository root — and inline `data/games/${year}/games.csv`
 * template strings elsewhere. Moving a directory meant finding all of them.
 *
 * `NCAA_REPO_ROOT` overrides the computed root, which is how a test points the readers at
 * a fixture directory without copying data into it.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * The repository root.
 *
 * Resolved from this file rather than the working directory, so a script behaves the
 * same whether it is run from the repo root, from `apps/scraper`, or by a scheduler that
 * did not chdir at all. This file compiles to `packages/storage/dist/paths.js`, three
 * levels below the root, and sits at the same depth in `src` when run through `tsx`.
 */
export const REPO_ROOT: string = process.env.NCAA_REPO_ROOT
    ? path.resolve(process.env.NCAA_REPO_ROOT)
    : path.resolve(__dirname, '../../..');

export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const GAMES_DIR = path.join(DATA_DIR, 'games');
export const STATS_DIR = path.join(DATA_DIR, 'player_stats');
export const TEAMS_DIR = path.join(DATA_DIR, 'teams');
export const RATINGS_DIR = path.join(DATA_DIR, 'ratings');
export const IMPACT_DIR = path.join(RATINGS_DIR, 'impact');
export const PREDICTIONS_DIR = path.join(DATA_DIR, 'predictions');

/** `data/raw/` — pages exactly as fetched, kept so a parser change can be re-run offline. */
export const RAW_DIR = path.join(DATA_DIR, 'raw');

export const INVENTORY = path.join(TEAMS_DIR, 'd1_msoc_teams.json');
export const ACC_INVENTORY = path.join(TEAMS_DIR, 'acc_teams.json');
export const TEAM_ALIASES = path.join(TEAMS_DIR, 'team_aliases.json');
export const COVERAGE_PATH = path.join(DATA_DIR, 'season_coverage.json');

/**
 * The box-score stage's two logs.
 *
 * They sit under `data/` and are resolved here for the same reason the CSVs are: the
 * stage that writes them is the one most likely to be running somewhere other than a
 * checkout, and a log written next to the code instead of next to the data is a log
 * nobody finds.
 */
export const DEBUG_BOXSCORE_LOG = path.join(STATS_DIR, 'debug_boxscore.log');
export const FAILED_BOXSCORES_LOG = path.join(STATS_DIR, 'failed_boxscores.log');

/** `data/games/<season>/games.csv` — one row per fixture, both schools merged. */
export const gamesCsv = (season: string): string => path.join(GAMES_DIR, season, 'games.csv');

/** `data/player_stats/<season>/player_stats.csv` — one row per player per game. */
export const playerStatsCsv = (season: string): string =>
    path.join(STATS_DIR, season, 'player_stats.csv');

/** `data/player_stats/<season>/aggregated_player_stats.csv` — season totals per player. */
export const aggregatedStatsCsv = (season: string): string =>
    path.join(STATS_DIR, season, 'aggregated_player_stats.csv');

/** `data/ratings/impact/<season>.csv` — every player's valued season. */
export const impactCsv = (season: string): string => path.join(IMPACT_DIR, `${season}.csv`);

/**
 * Which seasons are actually on disk.
 *
 * The dataset is backfilled a year at a time, so "every season" is a question about the
 * filesystem rather than a constant, and both callers of these had their own copy of the
 * readdir-filter-sort.
 */
const seasonDirs = (root: string, file: (season: string) => string): string[] => {
    if (!fs.existsSync(root)) return [];
    return fs
        .readdirSync(root)
        .filter(name => /^\d{4}$/.test(name))
        .filter(name => fs.existsSync(file(name)))
        .sort();
};

/** Seasons with aggregated player totals, oldest first. */
export const seasonsWithAggregatedStats = (): string[] => seasonDirs(STATS_DIR, aggregatedStatsCsv);

/** Seasons with a schedule, oldest first. Rated seasons need only this. */
export const seasonsWithGames = (): string[] => seasonDirs(GAMES_DIR, gamesCsv);

/** Seasons with box scores, oldest first. */
export const seasonsWithPlayerStats = (): string[] => seasonDirs(STATS_DIR, playerStatsCsv);
