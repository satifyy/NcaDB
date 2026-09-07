/**
 * What a row of each CSV is, and the four ways a cell becomes a number.
 *
 * Before this file, thirteen call sites each declared their own view of the same files —
 * `RawPlayerRow`, `GameRow`, `AggregatedRow`, `PerGameRow`, `ImpactRow`, `Row`,
 * `Record<string, string>` and one `any[]` — and each wrote its own coercion beside it.
 * Nothing made those views agree with the files or with each other, so a renamed column
 * degraded to `undefined`, then to `NaN`, then to `0`, without anything throwing.
 *
 * The types below are the single description of each file. They are deliberately
 * all-string: this is what a CSV holds, and pretending otherwise moves the coercion
 * somewhere it cannot be seen. The index signature keeps columns a type does not name
 * addressable, which is what lets `backfill_game_type` and `prune_ambiguous_boxscores`
 * rewrite a file without dropping the columns they do not care about.
 */

/** Any parsed row. Columns a type does not name survive here, and survive a rewrite. */
export interface CsvRow {
    [column: string]: string | undefined;
}

/** `data/games/<season>/games.csv`. */
export interface GameCsvRow extends CsvRow {
    game_id: string;
    date: string;
    home_team_name: string;
    away_team_name: string;
    home_team_ranked: string;
    away_team_ranked: string;
    home_score: string;
    away_score: string;
    location_type: string;
    status: string;
    schedule_url: string;
    boxscore_url: string;
    boxscore_url_alt: string;
    dedupe_key: string;
    /** Absent from seasons written before `backfill_game_type` was run. */
    game_type?: string;
}

/** `data/player_stats/<season>/player_stats.csv` — one row per player per game. */
export interface PlayerStatCsvRow extends CsvRow {
    game_id: string;
    team_id: string;
    player_name: string;
    player_key: string;
    jersey_number: string;
    minutes: string;
    goals: string;
    assists: string;
    shots: string;
    shots_on_goal: string;
    saves: string;
}

/** `data/player_stats/<season>/aggregated_player_stats.csv` — season totals per player. */
export interface AggregatedPlayerCsvRow extends CsvRow {
    player_key: string;
    player_name: string;
    team_id: string;
    jersey_number: string;
    games_played: string;
    minutes: string;
    goals: string;
    assists: string;
    shots: string;
    shots_on_goal: string;
    saves: string;
}

/** `data/ratings/impact/<season>.csv` — written by `build_ratings`, read by the dashboard. */
export interface ImpactCsvRow extends CsvRow {
    identity: string;
    player_name: string;
    team: string;
    conference: string;
    season: string;
    jersey_number: string;
    games: string;
    minutes: string;
    goals: string;
    assists: string;
    shots: string;
    shots_on_goal: string;
    saves: string;
    goals_against: string;
    is_keeper: string;
    keeper_games: string;
    impact: string;
    impact_per90: string;
    opponent_strength: string;
    rating: string;
    qualified: string;
    division_one: string;
}

/**
 * A counting stat: whole, and zero when the cell is empty, absent or unparseable.
 *
 * Zero is the right answer for a box score — a player with no `saves` cell made no saves
 * — and it is the wrong answer for a score, which is why {@link score} exists separately.
 */
export function int(value: string | undefined): number {
    const parsed = parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A fractional stat — impact, per-90 rates, goals against.
 *
 * `Number` rather than `parseInt`, because these columns are written with `toFixed` and
 * truncating them to whole numbers would silently flatten the leaderboard.
 */
export function dec(value: string | undefined): number {
    return Number(value ?? '');
}

/**
 * A score, which is null until the game is played.
 *
 * The distinction matters more than it looks: coercing an unplayed fixture's empty score
 * to 0 turns every future game into a 0-0 draw, which is a result an Elo will happily
 * rate.
 */
export function score(value: string | undefined): number | null {
    return value === undefined || value === '' ? null : Number(value);
}

/**
 * A boolean column.
 *
 * Written as the words `true`/`false` rather than left to `csv-stringify`, which renders
 * `true` as `1` and `false` as an empty cell — and an empty cell cannot be told apart
 * from a column that was never written.
 */
export function flag(value: string | undefined): boolean {
    return value === 'true';
}
