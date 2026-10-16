/**
 * Team of the Week. Read-only: every response comes from the tables the worker
 * precomputes after each load (migration 006), never from ranking on request.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { ApiError, cacheable, notFound } from '../http';
import { seasonQuery } from './shared';

const COMPETITIONS = ['ncaa-d1-msoc'];
const competitionQuery = { type: 'string', enum: COMPETITIONS, default: 'ncaa-d1-msoc' } as const;
const GROUPS = ['GK', 'DEF', 'MID', 'FWD'] as const;
/** Honorable mentions: this many per group, ranked just below the players in the XI. */
const MENTIONS = 2;

const MODEL_NOTE =
    'Each game a player is rated in (60+ minutes; keepers 80+) scores points for goals (worth more from deeper positions), ' +
    'assists, shots on target that were not goals, the result, and clean sheets; defenders lose a share of goals conceded ' +
    'while they played, keepers are charged goals allowed and credited saves where the box score reported them. A week ' +
    'scores 75% of the best game plus 25% of the average, so one great game is not outweighed by two ordinary ones. ' +
    'Players are ranked only against their own position group; the 0–10 rating is their standing within that group ' +
    'that week. Positions are the ones printed in each box score. Tackles, passes and other defensive actions are not ' +
    'published by the sources and are not used.';

interface WeekRow {
    id: string;
    season: number;
    week_start: string;
    week_end: string;
    status: string;
    revision: number;
    model_version: string;
    completeness: Record<string, unknown>;
    computed_at: Date;
    first_computed_at: Date;
}

const WEEK_COLUMNS = `w.id, s.year AS season, w.week_start::text, w.week_end::text, w.status, w.revision, w.model_version,
    w.completeness, w.computed_at, w.first_computed_at`;

/**
 * The week shown by default: the newest completed week (provisional or final) that has
 * at least one selected player. A week still being played is only a partial week, so it
 * is the default only before any week has completed; navigation reaches it either way.
 */
async function latestWeek(pool: Pool, season: number | null): Promise<WeekRow | undefined> {
    const { rows } = await pool.query<WeekRow>(
        `SELECT ${WEEK_COLUMNS} FROM totw_weeks w JOIN seasons s ON s.id = w.season_id
         WHERE ($1::int IS NULL OR s.year = $1)
           AND EXISTS (SELECT 1 FROM totw_selections x WHERE x.week_id = w.id AND x.player_id IS NOT NULL)
         ORDER BY (w.status = 'in_progress'), w.week_start DESC, w.model_version DESC LIMIT 1`,
        [season]
    );
    return rows[0];
}

async function weekContaining(pool: Pool, date: string, season: number | null): Promise<WeekRow | undefined> {
    const { rows } = await pool.query<WeekRow>(
        `SELECT ${WEEK_COLUMNS} FROM totw_weeks w JOIN seasons s ON s.id = w.season_id
         WHERE w.week_start = date_trunc('week', $1::date)::date AND ($2::int IS NULL OR s.year = $2)
         ORDER BY w.model_version DESC LIMIT 1`,
        [date, season]
    );
    return rows[0];
}

function player(r: Record<string, any>) {
    return {
        id: Number(r.player_id),
        name: r.name,
        team: { id: r.team_id, slug: r.team_slug, name: r.team_name },
        position_group: r.position_group,
        position: r.position,
        rating: Number(r.rating),
        score: Number(r.raw_score),
        best_game: Number(r.best_game),
        rank: r.group_rank,
        games: r.games,
        minutes: r.minutes,
        missing: r.missing,
        explanation: r.explanation,
        game_log: (r.detail as Record<string, unknown>[]).map(g => ({
            game_id: g.gameId,
            date: g.gameDate,
            opponent: g.opponentName,
            team_score: g.teamScore,
            opponent_score: g.opponentScore,
            minutes: g.minutes,
            goals: g.goals,
            assists: g.assists,
            shots_on_goal: g.shotsOnGoal,
            saves: g.saves,
            goals_allowed: g.goalsAllowed,
            goals_allowed_source: g.goalsAllowedSource,
            score: g.score,
            components: g.components
        }))
    };
}

const PLAYER_SQL = `
    SELECT pw.player_id, p.display_name AS name, pw.team_id, t.slug AS team_slug, t.name AS team_name, pw.position_group,
           pw.position, pw.rating, pw.raw_score, pw.best_game, pw.group_rank, pw.games, pw.minutes, pw.missing,
           pw.explanation, pw.detail
    FROM totw_player_weeks pw JOIN players p ON p.id = pw.player_id JOIN teams t ON t.id = pw.team_id`;

async function weekBody(pool: Pool, week: WeekRow) {
    const [xi, mentions, nav, model] = await Promise.all([
        pool.query(
            `SELECT x.slot, x.position_group AS slot_group, pl.*
             FROM totw_selections x
             LEFT JOIN (${PLAYER_SQL} WHERE pw.week_id = $1) pl ON pl.player_id = x.player_id
             WHERE x.week_id = $1 ORDER BY x.slot`,
            [week.id]
        ),
        pool.query(
            `${PLAYER_SQL} WHERE pw.week_id = $1 AND pw.group_rank > CASE pw.position_group
                 WHEN 'GK' THEN 1 WHEN 'DEF' THEN 4 ELSE 3 END
               AND pw.group_rank <= CASE pw.position_group WHEN 'GK' THEN 1 WHEN 'DEF' THEN 4 ELSE 3 END + $2
             ORDER BY pw.position_group, pw.group_rank`,
            [week.id, MENTIONS]
        ),
        pool.query<{ previous: string | null; next: string | null }>(
            `SELECT (SELECT max(week_start)::text FROM totw_weeks WHERE week_start < $1 AND model_version = $2) AS previous,
                    (SELECT min(week_start)::text FROM totw_weeks WHERE week_start > $1 AND model_version = $2) AS next`,
            [week.week_start, week.model_version]
        ),
        pool.query('SELECT version, weights, rules FROM totw_model_versions WHERE version = $1', [week.model_version])
    ]);
    const selected = xi.rows.map(r => ({ slot: r.slot, position_group: r.slot_group, player: r.player_id ? player(r) : null }));
    const best = Object.fromEntries(GROUPS.map(g => [g, selected.find(s => s.position_group === g && s.player)?.player ?? null]));
    const honorable = Object.fromEntries(GROUPS.map(g => [g, mentions.rows.filter(r => r.position_group === g).map(player)]));
    return {
        week: {
            start: week.week_start,
            end: week.week_end,
            season: week.season,
            competition: { code: 'ncaa-d1-msoc', name: "NCAA Division I Men's Soccer" },
            status: week.status,
            revision: week.revision,
            computed_at: week.computed_at,
            first_computed_at: week.first_computed_at,
            completeness: week.completeness,
            previous: nav.rows[0].previous,
            next: nav.rows[0].next
        },
        formation: '4-3-3',
        xi: selected,
        filled: selected.filter(s => s.player).length,
        best,
        honorable_mentions: honorable,
        model: {
            version: week.model_version,
            summary: MODEL_NOTE,
            weights: model.rows[0]?.weights ?? null,
            rules: model.rows[0]?.rules ?? null
        }
    };
}

/** ETag from the week's identity and revision: it changes exactly when the content does. */
function sendWeek(request: FastifyRequest, reply: FastifyReply, week: WeekRow, cacheSeconds: number, body: unknown) {
    const etag = `"totw-${week.id}-${week.revision}-${new Date(week.computed_at).getTime()}"`;
    reply.header('ETag', etag);
    cacheable(reply, cacheSeconds);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return body;
}

export async function teamOfWeekRoutes(app: FastifyInstance, opts: { pool: Pool; cacheSeconds: number }) {
    const { pool, cacheSeconds } = opts;
    const filters = { season: seasonQuery, competition: competitionQuery };

    app.get<{ Querystring: { season?: number; competition?: string } }>(
        '/api/v1/team-of-week',
        {
            schema: {
                tags: ['team-of-week'],
                summary: 'The latest Team of the Week (4-3-3), with positional bests, honorable mentions and the model used',
                querystring: { type: 'object', properties: filters }
            }
        },
        async (request, reply) => {
            const week = await latestWeek(pool, request.query.season ?? null);
            if (!week) throw notFound('Team of the Week');
            return sendWeek(request, reply, week, cacheSeconds, await weekBody(pool, week));
        }
    );

    app.get<{ Querystring: { season?: number; competition?: string } }>(
        '/api/v1/team-of-week/weeks',
        {
            schema: {
                tags: ['team-of-week'],
                summary: 'Every computed week, newest first, for navigation',
                querystring: { type: 'object', properties: filters }
            }
        },
        async (request, reply) => {
            const { rows } = await pool.query(
                `SELECT w.week_start::text AS start, w.week_end::text AS "end", s.year AS season, w.status, w.revision,
                        w.model_version, w.computed_at,
                        (SELECT count(*)::int FROM totw_selections x WHERE x.week_id = w.id AND x.player_id IS NOT NULL) AS filled
                 FROM totw_weeks w JOIN seasons s ON s.id = w.season_id
                 WHERE ($1::int IS NULL OR s.year = $1)
                 ORDER BY w.week_start DESC, w.model_version DESC`,
                [request.query.season ?? null]
            );
            cacheable(reply, cacheSeconds);
            return { data: rows };
        }
    );

    app.get<{ Params: { week: string }; Querystring: { season?: number; competition?: string } }>(
        '/api/v1/team-of-week/:week',
        {
            schema: {
                tags: ['team-of-week'],
                summary: 'The Team of the Week for the Monday-Sunday week containing a date (YYYY-MM-DD)',
                params: {
                    type: 'object',
                    properties: { week: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' } },
                    required: ['week']
                },
                querystring: { type: 'object', properties: filters }
            }
        },
        async (request, reply) => {
            const date = request.params.week;
            if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new ApiError(400, 'bad_request', 'Not a calendar date');
            const week = await weekContaining(pool, date, request.query.season ?? null);
            if (!week) throw notFound('Team of the Week for that week');
            return sendWeek(request, reply, week, cacheSeconds, await weekBody(pool, week));
        }
    );
}
