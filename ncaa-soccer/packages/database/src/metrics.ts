/**
 * Coverage and freshness: the numbers that tell a working scraper apart from a complete
 * dataset. Shared by the worker (recorded with each run) and the API (data-status).
 */

import { Pool } from 'pg';

export interface SeasonCoverageRow {
    season: number;
    games: number;
    scheduled: number;
    final: number;
    postponed: number;
    canceled: number;
    unknown_status: number;
    boxscore_complete: number;
    boxscore_partial: number;
    boxscore_missing: number;
    /** Share of final games with both sides' box scores. */
    boxscore_coverage: number | null;
    score_conflicts: number;
    goals_excess: number;
    players: number;
    player_game_rows: number;
    teams: number;
    division_one_teams_with_games: number;
    last_final_date: string | null;
    last_verified_at: string | null;
}

export async function seasonCoverage(pool: Pool, season?: number): Promise<SeasonCoverageRow[]> {
    const { rows } = await pool.query(
        `WITH g AS (
             SELECT s.year AS season, g.*
             FROM games g JOIN seasons s ON s.id = g.season_id
             WHERE $1::int IS NULL OR s.year = $1
         ),
         per_season AS (
             SELECT season,
                    count(*)::int AS games,
                    count(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
                    count(*) FILTER (WHERE status = 'final')::int AS final,
                    count(*) FILTER (WHERE status = 'postponed')::int AS postponed,
                    count(*) FILTER (WHERE status = 'canceled')::int AS canceled,
                    count(*) FILTER (WHERE status IN ('unknown', 'live'))::int AS unknown_status,
                    count(*) FILTER (WHERE status = 'final' AND boxscore_status = 'complete')::int AS boxscore_complete,
                    count(*) FILTER (WHERE status = 'final' AND boxscore_status = 'partial')::int AS boxscore_partial,
                    count(*) FILTER (WHERE status = 'final' AND boxscore_status = 'none')::int AS boxscore_missing,
                    count(*) FILTER (WHERE 'score_conflict' = ANY(quality_flags))::int AS score_conflicts,
                    max(game_date) FILTER (WHERE status = 'final')::text AS last_final_date,
                    max(last_verified_at) AS last_verified_at
             FROM g GROUP BY season
         ),
         stats AS (
             SELECT s.year AS season, count(*)::int AS player_game_rows, count(DISTINCT p.player_id)::int AS players
             FROM player_game_stats p JOIN seasons s ON s.id = p.season_id
             WHERE $1::int IS NULL OR s.year = $1
             GROUP BY s.year
         ),
         excess AS (
             SELECT g.season, count(*)::int AS goals_excess
             FROM team_game_stats t JOIN g ON g.id = t.game_id
             WHERE t.goals_reconciliation = 'excess' GROUP BY g.season
         ),
         teams AS (
             SELECT s.year AS season, count(*)::int AS teams,
                    count(*) FILTER (WHERE t.is_division_one)::int AS division_one_teams_with_games
             FROM team_seasons ts JOIN seasons s ON s.id = ts.season_id JOIN teams t ON t.id = ts.team_id
             WHERE $1::int IS NULL OR s.year = $1
             GROUP BY s.year
         )
         SELECT p.*,
                CASE WHEN p.final > 0 THEN round(p.boxscore_complete::numeric / p.final, 4)::float END AS boxscore_coverage,
                COALESCE(e.goals_excess, 0) AS goals_excess,
                COALESCE(st.players, 0) AS players,
                COALESCE(st.player_game_rows, 0) AS player_game_rows,
                COALESCE(t.teams, 0) AS teams,
                COALESCE(t.division_one_teams_with_games, 0) AS division_one_teams_with_games
         FROM per_season p
         LEFT JOIN stats st USING (season)
         LEFT JOIN excess e USING (season)
         LEFT JOIN teams t USING (season)
         ORDER BY p.season`,
        [season ?? null]
    );
    return rows;
}

/** Final games in the last `days` whose box score has not arrived. */
export async function recentGamesMissingBoxscores(pool: Pool, days: number): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM games
         WHERE status = 'final' AND boxscore_status = 'none' AND game_date >= current_date - $1::int`,
        [days]
    );
    return rows[0].n;
}

export interface Freshness {
    last_successful_sync: string | null;
    hours_since_sync: number | null;
    last_final_game_date: string | null;
    latest_run: { id: number; kind: string; status: string; started_at: string; finished_at: string | null } | null;
}

export async function freshness(pool: Pool): Promise<Freshness> {
    const [sync, game, run] = await Promise.all([
        pool.query(
            `SELECT max(last_success_at) AS at FROM data_sync_state WHERE scope LIKE 'season:%'`
        ),
        pool.query(`SELECT max(game_date)::text AS d FROM games WHERE status = 'final'`),
        pool.query(
            `SELECT id::int, kind, status, started_at, finished_at FROM ingestion_runs ORDER BY started_at DESC LIMIT 1`
        )
    ]);
    const at: Date | null = sync.rows[0].at;
    return {
        last_successful_sync: at ? at.toISOString() : null,
        hours_since_sync: at ? Math.round(((Date.now() - at.getTime()) / 3_600_000) * 10) / 10 : null,
        last_final_game_date: game.rows[0].d,
        latest_run: run.rows[0] ?? null
    };
}
