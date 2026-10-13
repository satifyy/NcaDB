/**
 * Reads a season back out in the scrapers' own CSV shapes.
 *
 * The scrapers merge new results into whatever games.csv and player_stats.csv they find
 * on disk, and decide what is "new" by what is already there. On a server the disk is
 * empty at every start, so the worker writes these rows out first and the scrapers work
 * exactly as they do on a laptop with a full checkout.
 */

import { Pool } from 'pg';

/** games.csv's column order, as `@ncaa/storage`'s writers produce it. */
export const GAME_COLUMNS = [
    'game_id',
    'date',
    'home_team_name',
    'away_team_name',
    'home_team_ranked',
    'away_team_ranked',
    'home_score',
    'away_score',
    'location_type',
    'status',
    'schedule_url',
    'boxscore_url',
    'boxscore_url_alt',
    'dedupe_key',
    'game_type'
];

export const PLAYER_STAT_COLUMNS = [
    'game_id',
    'team_id',
    'player_name',
    'player_key',
    'jersey_number',
    'minutes',
    'goals',
    'assists',
    'shots',
    'shots_on_goal',
    'saves'
];

export async function exportGameRows(pool: Pool, season: number): Promise<Record<string, string>[]> {
    const { rows } = await pool.query<{ payload: Record<string, string> }>(
        `SELECT gs.payload
         FROM game_sources gs JOIN seasons s ON s.id = gs.season_id
         WHERE s.year = $1
         ORDER BY gs.payload->>'date', gs.id`,
        [season]
    );
    return rows.map(r => r.payload);
}

const cell = (value: number | string | null): string => (value === null ? '' : String(value));

export async function exportPlayerStatRows(pool: Pool, season: number): Promise<Record<string, string>[]> {
    const { rows } = await pool.query(
        `SELECT p.source_game_id, p.source_team_name, p.source_player_name, p.source_player_key,
                p.jersey_number, p.minutes, p.goals, p.assists, p.shots, p.shots_on_goal, p.saves
         FROM player_game_stats p JOIN seasons s ON s.id = p.season_id
         WHERE s.year = $1
         ORDER BY p.source_game_id, p.id`,
        [season]
    );
    return rows.map(r => ({
        game_id: r.source_game_id,
        team_id: r.source_team_name,
        player_name: r.source_player_name,
        player_key: r.source_player_key,
        jersey_number: cell(r.jersey_number),
        minutes: cell(r.minutes),
        goals: cell(r.goals),
        assists: cell(r.assists),
        shots: cell(r.shots),
        shots_on_goal: cell(r.shots_on_goal),
        saves: cell(r.saves)
    }));
}

export async function seasonsInDatabase(pool: Pool): Promise<number[]> {
    const { rows } = await pool.query<{ year: number }>(
        `SELECT DISTINCT s.year FROM seasons s JOIN games g ON g.season_id = s.id ORDER BY s.year`
    );
    return rows.map(r => r.year);
}
