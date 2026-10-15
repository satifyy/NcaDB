/**
 * Team of the Week: reading a season's box scores week by week, and persisting the
 * model's output.
 *
 * Idempotent and restartable: each week is hashed from exactly the rows the model reads
 * (plus the model version), a week whose hash and status are unchanged is skipped, and a
 * changed week is replaced in its own transaction. Running it twice does nothing the
 * second time; killing it part-way leaves every week either as it was or fully updated.
 * Corrections need no special path: a corrected box score changes its week's hash.
 */

import { Pool } from 'pg';
import type { PositionGroup } from '@ncaa/shared';
import { hashOf } from '../loader';
import { withTransaction } from '../pool';
import { MODEL_VERSION, PlayerGameInput, PlayerWeek, RULES, WEIGHTS, explain, rateWeek, selectTeam } from './model';

export type WeekStatus = 'in_progress' | 'provisional' | 'final';

/** Days after a week ends before it is final: the scrapers re-read box scores for seven. */
export const FINAL_AFTER_DAYS = 8;

const addDays = (date: string, days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};

/** Today's calendar date in America/Chicago, the site's reference timezone. */
export function chicagoToday(now = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Monday of the week a date falls in. */
export function weekStartOf(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    const offset = (d.getUTCDay() + 6) % 7;
    return addDays(date, -offset);
}

export function weekStatus(weekStart: string, today: string): WeekStatus {
    const end = addDays(weekStart, 6);
    if (today <= end) return 'in_progress';
    if (today <= addDays(end, FINAL_AFTER_DAYS)) return 'provisional';
    return 'final';
}

interface InputRow {
    player_id: string;
    player_name: string;
    team_id: number;
    team_name: string;
    game_id: string;
    game_date: string;
    opponent_name: string;
    opponent_division_one: boolean;
    position_group: PositionGroup;
    position: string | null;
    minutes: number;
    goals: number | null;
    assists: number | null;
    shots_on_goal: number | null;
    saves: number | null;
    goals_allowed: number | null;
    team_score: number;
    opponent_score: number;
    team_keepers_used: string;
    game_minutes: number;
}

/**
 * Every rateable row of a season: a final, non-exhibition game; a Division I player's
 * row captured at version 2 with a position group and minutes. Rows that fail any of
 * those are not "zero" — they are not evidence, and the completeness figures count them.
 */
const INPUT_SQL = `
    WITH sides AS (
        SELECT g.id AS game_id, g.game_date, g.home_team_id AS team_id, g.away_team_id AS opponent_id,
               g.home_score AS team_score, g.away_score AS opponent_score
        FROM games g WHERE g.season_id = $1 AND g.status = 'final' AND g.game_type IS DISTINCT FROM 'exhibition'
        UNION ALL
        SELECT g.id, g.game_date, g.away_team_id, g.home_team_id, g.away_score, g.home_score
        FROM games g WHERE g.season_id = $1 AND g.status = 'final' AND g.game_type IS DISTINCT FROM 'exhibition'
    ),
    rows AS (
        SELECT s.*, sd.game_date, sd.team_score, sd.opponent_score, sd.opponent_id,
               count(*) FILTER (WHERE s.position_group = 'GK' AND s.minutes > 0)
                   OVER (PARTITION BY s.game_id, s.team_id) AS team_keepers_used,
               max(s.minutes) OVER (PARTITION BY s.game_id, s.team_id) AS game_minutes
        FROM player_game_stats s
        JOIN sides sd ON sd.game_id = s.game_id AND sd.team_id = s.team_id
        WHERE s.season_id = $1 AND s.capture_version >= 2
    )
    SELECT r.player_id, p.display_name AS player_name, r.team_id, t.name AS team_name, r.game_id,
           r.game_date::text AS game_date, o.name AS opponent_name, o.is_division_one AS opponent_division_one, r.position_group, r.position, r.minutes,
           r.goals, r.assists, r.shots_on_goal, r.saves, r.goals_allowed, r.team_score, r.opponent_score,
           r.team_keepers_used, r.game_minutes
    FROM rows r
    JOIN players p ON p.id = r.player_id
    JOIN teams t ON t.id = r.team_id
    JOIN teams o ON o.id = r.opponent_id
    WHERE t.is_division_one AND r.position_group IS NOT NULL AND r.minutes IS NOT NULL
    ORDER BY r.game_date, r.game_id, r.player_id`;

/** How much of a week the inputs cover, per week start. */
const COMPLETENESS_SQL = `
    WITH g AS (
        SELECT g.id, date_trunc('week', g.game_date)::date AS week_start, g.boxscore_status
        FROM games g
        JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id
        WHERE g.season_id = $1 AND g.status = 'final' AND g.game_type IS DISTINCT FROM 'exhibition'
          AND (h.is_division_one OR a.is_division_one)
    ),
    s AS (
        SELECT g.week_start,
               count(*) FILTER (WHERE p.minutes > 0) AS played_rows,
               count(*) FILTER (WHERE p.minutes > 0 AND p.capture_version >= 2) AS captured_rows,
               count(*) FILTER (WHERE p.minutes > 0 AND p.capture_version >= 2 AND p.position_group IS NOT NULL) AS positioned_rows,
               count(*) FILTER (WHERE p.capture_version >= 2 AND p.position_group = 'GK' AND p.minutes > 0) AS keeper_rows,
               count(*) FILTER (WHERE p.capture_version >= 2 AND p.position_group = 'GK' AND p.minutes > 0 AND p.goals_allowed IS NOT NULL) AS keeper_rows_official_ga,
               count(*) FILTER (WHERE p.capture_version >= 2 AND p.position_group = 'GK' AND p.minutes > 0 AND p.saves IS NOT NULL) AS keeper_rows_with_saves
        FROM g JOIN player_game_stats p ON p.game_id = g.id
        GROUP BY g.week_start
    )
    SELECT g.week_start::text AS week_start,
           count(*)::int AS final_games,
           count(*) FILTER (WHERE g.boxscore_status <> 'none')::int AS games_with_boxscore,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM player_game_stats p WHERE p.game_id = g.id AND p.capture_version >= 2))::int AS games_captured,
           coalesce(max(s.played_rows), 0)::int AS played_rows,
           coalesce(max(s.captured_rows), 0)::int AS captured_rows,
           coalesce(max(s.positioned_rows), 0)::int AS positioned_rows,
           coalesce(max(s.keeper_rows), 0)::int AS keeper_rows,
           coalesce(max(s.keeper_rows_official_ga), 0)::int AS keeper_rows_official_ga,
           coalesce(max(s.keeper_rows_with_saves), 0)::int AS keeper_rows_with_saves
    FROM g LEFT JOIN s ON s.week_start = g.week_start
    GROUP BY g.week_start`;

function toInput(r: InputRow): PlayerGameInput {
    return {
        playerId: Number(r.player_id),
        playerName: r.player_name,
        teamId: r.team_id,
        teamName: r.team_name,
        gameId: Number(r.game_id),
        gameDate: r.game_date,
        opponentName: r.opponent_name,
        opponentDivisionOne: r.opponent_division_one,
        positionGroup: r.position_group,
        position: r.position ?? '',
        minutes: r.minutes,
        goals: r.goals,
        assists: r.assists,
        shotsOnGoal: r.shots_on_goal,
        saves: r.saves,
        goalsAllowed: r.goals_allowed,
        teamScore: r.team_score,
        opponentScore: r.opponent_score,
        teamKeepersUsed: Number(r.team_keepers_used),
        gameMinutes: r.game_minutes
    };
}

export interface TotwRunResult {
    season: number;
    weeks: number;
    computed: number;
    unchanged: number;
}

async function ensureModelVersion(pool: Pool): Promise<void> {
    await pool.query(
        `INSERT INTO totw_model_versions (version, weights, rules) VALUES ($1, $2, $3)
         ON CONFLICT (version) DO NOTHING`,
        [MODEL_VERSION, JSON.stringify(WEIGHTS), JSON.stringify(RULES)]
    );
}

/**
 * Computes every week of a season that has played games, writing only weeks whose
 * inputs or status changed.
 */
export async function computeTeamOfWeek(
    pool: Pool,
    season: number,
    now = new Date(),
    options: { minCapturedGames?: number } = {}
): Promise<TotwRunResult> {
    const minGames = options.minCapturedGames ?? RULES.minCapturedGames;
    const { rows: seasonRows } = await pool.query<{ id: number }>(
        `SELECT s.id FROM seasons s JOIN competitions c ON c.id = s.competition_id
         WHERE c.code = 'ncaa-d1-msoc' AND s.year = $1`,
        [season]
    );
    const result: TotwRunResult = { season, weeks: 0, computed: 0, unchanged: 0 };
    if (!seasonRows[0]) return result;
    const seasonId = seasonRows[0].id;
    await ensureModelVersion(pool);

    const today = chicagoToday(now);
    const { rows } = await pool.query<InputRow>(INPUT_SQL, [seasonId]);
    const { rows: coverage } = await pool.query(COMPLETENESS_SQL, [seasonId]);
    const coverageByWeek = new Map(coverage.map(c => [c.week_start as string, c]));

    const byWeek = new Map<string, PlayerGameInput[]>();
    for (const row of rows) {
        const week = weekStartOf(row.game_date);
        if (week > today) continue;
        byWeek.set(week, [...(byWeek.get(week) ?? []), toInput(row)]);
    }
    // A week with played games but nothing rateable still gets a row, so the site can
    // say "not enough data" instead of skipping it silently.
    for (const week of coverageByWeek.keys()) if (week <= today && !byWeek.has(week)) byWeek.set(week, []);

    for (const [weekStart, inputs] of [...byWeek].sort(([a], [b]) => a.localeCompare(b))) {
        result.weeks++;
        const status = weekStatus(weekStart, today);
        const inputsHash = hashOf([MODEL_VERSION, minGames, inputs]);
        const { rows: existing } = await pool.query<{ id: string; inputs_hash: string; status: string }>(
            `SELECT id, inputs_hash, status FROM totw_weeks WHERE season_id = $1 AND week_start = $2 AND model_version = $3`,
            [seasonId, weekStart, MODEL_VERSION]
        );
        if (existing[0] && existing[0].inputs_hash === inputsHash && existing[0].status === status) {
            result.unchanged++;
            continue;
        }
        const c = coverageByWeek.get(weekStart);
        // Too few captured games and there is no XI to speak of: a week of three preseason
        // fixtures would otherwise "select" whoever played in them. The week is still
        // stored, so the site can say why it is empty.
        const enough = (c?.games_captured ?? 0) >= minGames;
        const groups = enough ? rateWeek(inputs) : rateWeek([]);
        const xi = selectTeam(groups);
        const completeness = { ...summarize(c, groups), published: enough, reason: enough ? null : 'too_few_games' };

        await withTransaction(pool, async client => {
            const changedInputs = existing[0] && existing[0].inputs_hash !== inputsHash;
            const { rows: week } = await client.query<{ id: string }>(
                `INSERT INTO totw_weeks (season_id, week_start, week_end, model_version, status, inputs_hash, completeness)
                 VALUES ($1, $2, $2::date + 6, $3, $4, $5, $6)
                 ON CONFLICT (season_id, week_start, model_version) DO UPDATE SET
                     status = EXCLUDED.status, inputs_hash = EXCLUDED.inputs_hash,
                     completeness = EXCLUDED.completeness, computed_at = now(),
                     revision = totw_weeks.revision + $7
                 RETURNING id`,
                [seasonId, weekStart, MODEL_VERSION, status, inputsHash, JSON.stringify(completeness), changedInputs ? 1 : 0]
            );
            const weekId = week[0].id;
            await client.query('DELETE FROM totw_selections WHERE week_id = $1', [weekId]);
            await client.query('DELETE FROM totw_player_weeks WHERE week_id = $1', [weekId]);
            const players = (Object.values(groups) as PlayerWeek[][]).flat();
            if (players.length > 0) {
                await client.query(
                    `INSERT INTO totw_player_weeks (week_id, player_id, team_id, position_group, position, group_rank, rating,
                         raw_score, best_game, mean_game, games, minutes, missing, explanation, detail)
                     SELECT $1, x.player_id, x.team_id, x.position_group, x.position, x.group_rank, x.rating, x.raw_score,
                            x.best_game, x.mean_game, x.games, x.minutes,
                            ARRAY(SELECT jsonb_array_elements_text(x.missing)), x.explanation, x.detail
                     FROM jsonb_to_recordset($2::jsonb) AS x(player_id bigint, team_id int, position_group text, position text,
                         group_rank int, rating numeric, raw_score numeric, best_game numeric, mean_game numeric, games int,
                         minutes int, missing jsonb, explanation text, detail jsonb)`,
                    [weekId, JSON.stringify(players.map(p => ({
                        player_id: p.playerId,
                        team_id: p.teamId,
                        position_group: p.positionGroup,
                        position: p.position || null,
                        group_rank: p.rank,
                        rating: p.rating,
                        raw_score: p.raw,
                        best_game: p.bestGame,
                        mean_game: p.meanGame,
                        games: p.games.length,
                        minutes: p.totalMinutes,
                        missing: p.missing,
                        explanation: explain(p),
                        detail: p.games
                    })))]
                );
            }
            await client.query(
                `INSERT INTO totw_selections (week_id, slot, position_group, player_id)
                 SELECT $1, x.slot, x.position_group, x.player_id
                 FROM jsonb_to_recordset($2::jsonb) AS x(slot int, position_group text, player_id bigint)`,
                [weekId, JSON.stringify(xi.map(s => ({ slot: s.slot, position_group: s.positionGroup, player_id: s.player?.playerId ?? null })))]
            );
        });
        result.computed++;
    }
    return result;
}

function summarize(c: Record<string, number> | undefined, groups: Record<PositionGroup, PlayerWeek[]>) {
    const share = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
    const finalGames = c?.final_games ?? 0;
    return {
        final_games: finalGames,
        games_with_boxscore: c?.games_with_boxscore ?? 0,
        games_captured: c?.games_captured ?? 0,
        boxscore_share: share(c?.games_with_boxscore ?? 0, finalGames),
        captured_share: share(c?.games_captured ?? 0, finalGames),
        position_share: share(c?.positioned_rows ?? 0, c?.captured_rows ?? 0),
        keeper_official_ga_share: share(c?.keeper_rows_official_ga ?? 0, c?.keeper_rows ?? 0),
        keeper_saves_share: share(c?.keeper_rows_with_saves ?? 0, c?.keeper_rows ?? 0),
        eligible: { GK: groups.GK.length, DEF: groups.DEF.length, MID: groups.MID.length, FWD: groups.FWD.length }
    };
}
