import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { ApiError, cacheable, notFound, offset, orderBy, Page, paged, paginationQuery, sortEnum, teamIdParam } from '../http';
import { latestSeason, likePattern, seasonQuery } from './shared';

export interface TeamRow {
    id: number;
    slug: string;
    name: string;
}

/** A team by numeric id or slug. */
export async function findTeam(pool: Pool, idOrSlug: string): Promise<TeamRow & Record<string, unknown>> {
    const byId = /^[0-9]+$/.test(idOrSlug);
    const { rows } = await pool.query(
        `SELECT t.id, t.slug, t.name, t.is_division_one, c.name AS conference, t.schedule_url, t.platform,
                t.timezone, t.aliases
         FROM teams t LEFT JOIN conferences c ON c.id = t.conference_id
         WHERE ${byId ? 't.id = $1::int' : 't.slug = $1'}`,
        [idOrSlug]
    );
    if (!rows[0]) throw notFound('Team');
    return rows[0];
}

export const result = (teamScore: number | null, opponentScore: number | null, status: string) =>
    status !== 'final' || teamScore === null || opponentScore === null
        ? null
        : teamScore > opponentScore
          ? 'W'
          : teamScore < opponentScore
            ? 'L'
            : 'D';

const TEAM_SORT = { name: 't.name', wins: 'r.wins', played: 'r.played', goals_for: 'r.goals_for' };
const ROSTER_SORT = {
    name: 'p.display_name',
    goals: 'pss.goals',
    assists: 'pss.assists',
    points: '(COALESCE(pss.goals, 0) + COALESCE(pss.assists, 0))',
    minutes: 'pss.minutes',
    games: 'pss.games_played',
    saves: 'pss.saves',
    shots: 'pss.shots'
};

export async function teamRoutes(app: FastifyInstance, opts: { pool: Pool; cacheSeconds: number }) {
    const { pool, cacheSeconds } = opts;

    app.get<{ Querystring: Page & { search?: string; conference?: string; season?: number; division_one: string; sort?: string } }>(
        '/api/v1/teams',
        {
            schema: {
                tags: ['teams'],
                summary: 'List teams, with each team’s record for the season',
                querystring: {
                    type: 'object',
                    properties: {
                        ...paginationQuery,
                        search: { type: 'string', minLength: 1, maxLength: 80 },
                        conference: { type: 'string', maxLength: 80 },
                        season: seasonQuery,
                        division_one: { type: 'string', enum: ['true', 'false', 'all'], default: 'true' },
                        sort: sortEnum(Object.keys(TEAM_SORT))
                    }
                }
            }
        },
        async (request, reply) => {
            const q = request.query;
            const season = q.season ?? (await latestSeason(pool));
            const d1 = q.division_one === 'all' ? null : q.division_one === 'true';
            const { rows } = await pool.query(
                `SELECT t.id, t.slug, t.name, t.is_division_one, c.name AS conference,
                        r.played, r.wins, r.draws, r.losses, r.goals_for, r.goals_against,
                        count(*) OVER () AS total_count
                 FROM teams t
                 LEFT JOIN conferences c ON c.id = t.conference_id
                 LEFT JOIN seasons s ON s.year = $4
                 LEFT JOIN team_season_records r ON r.team_id = t.id AND r.season_id = s.id
                 WHERE ($1::text IS NULL OR t.name ILIKE $1 OR EXISTS (SELECT 1 FROM unnest(t.aliases) a WHERE a ILIKE $1))
                   AND ($2::text IS NULL OR c.name = $2)
                   AND ($3::boolean IS NULL OR t.is_division_one = $3)
                   AND ($5::boolean IS FALSE OR EXISTS (
                        SELECT 1 FROM team_seasons ts WHERE ts.team_id = t.id AND ts.season_id = s.id))
                 ORDER BY ${orderBy(q.sort, TEAM_SORT, 't.name ASC')}, t.id
                 LIMIT $6 OFFSET $7`,
                [likePattern(q.search), q.conference ?? null, d1, season, q.season !== undefined, q.page_size, offset(q)]
            );
            cacheable(reply, cacheSeconds);
            return { season, ...paged(rows, q) };
        }
    );

    app.get<{ Params: { id: string } }>(
        '/api/v1/teams/:id',
        { schema: { tags: ['teams'], summary: 'One team, with its record in every season', params: teamIdParam } },
        async (request, reply) => {
            const team = await findTeam(pool, request.params.id);
            const { rows: seasons } = await pool.query(
                `SELECT s.year AS season, c.name AS conference, ts.conference_source,
                        r.played, r.wins, r.draws, r.losses, r.goals_for, r.goals_against
                 FROM team_seasons ts
                 JOIN seasons s ON s.id = ts.season_id
                 LEFT JOIN conferences c ON c.id = ts.conference_id
                 LEFT JOIN team_season_records r ON r.team_id = ts.team_id AND r.season_id = ts.season_id
                 WHERE ts.team_id = $1
                 ORDER BY s.year DESC`,
                [team.id]
            );
            cacheable(reply, cacheSeconds);
            return { data: { ...team, seasons } };
        }
    );

    app.get<{ Params: { id: string }; Querystring: Page & { season?: number; status?: string; sort?: string } }>(
        '/api/v1/teams/:id/games',
        {
            schema: {
                tags: ['teams'],
                summary: 'A team’s schedule and results',
                params: teamIdParam,
                querystring: {
                    type: 'object',
                    properties: {
                        ...paginationQuery,
                        page_size: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
                        season: seasonQuery,
                        status: { type: 'string', enum: ['scheduled', 'final', 'postponed', 'canceled', 'unknown', 'live'] },
                        sort: sortEnum(['date'])
                    }
                }
            }
        },
        async (request, reply) => {
            const team = await findTeam(pool, request.params.id);
            const q = request.query;
            const { rows } = await pool.query(
                `SELECT g.id, g.game_date::text AS date, s.year AS season, g.status, g.game_type,
                        CASE WHEN g.location_type = 'neutral' THEN 'neutral'
                             WHEN g.home_team_id = $1 THEN 'home' ELSE 'away' END AS venue,
                        opp.id AS opponent_id, opp.slug AS opponent_slug, opp.name AS opponent_name,
                        opp.is_division_one AS opponent_division_one,
                        CASE WHEN g.home_team_id = $1 THEN g.home_score ELSE g.away_score END AS team_score,
                        CASE WHEN g.home_team_id = $1 THEN g.away_score ELSE g.home_score END AS opponent_score,
                        g.boxscore_status, count(*) OVER () AS total_count
                 FROM games g
                 JOIN seasons s ON s.id = g.season_id
                 JOIN teams opp ON opp.id = CASE WHEN g.home_team_id = $1 THEN g.away_team_id ELSE g.home_team_id END
                 WHERE (g.home_team_id = $1 OR g.away_team_id = $1)
                   AND ($2::int IS NULL OR s.year = $2)
                   AND ($3::text IS NULL OR g.status = $3)
                 ORDER BY ${orderBy(q.sort, { date: 'g.game_date' }, 'g.game_date DESC')}, g.id
                 LIMIT $4 OFFSET $5`,
                [team.id, q.season ?? null, q.status ?? null, q.page_size, offset(q)]
            );
            cacheable(reply, cacheSeconds);
            const page = paged(rows, q);
            return {
                team: { id: team.id, slug: team.slug, name: team.name },
                ...page,
                data: page.data.map(g => ({ ...g, result: result(g.team_score, g.opponent_score, g.status) }))
            };
        }
    );

    app.get<{ Params: { id: string }; Querystring: { season?: number; sort?: string } }>(
        '/api/v1/teams/:id/players',
        {
            schema: {
                tags: ['teams'],
                summary: 'A team’s roster for a season, with season totals',
                params: teamIdParam,
                querystring: {
                    type: 'object',
                    properties: { season: seasonQuery, sort: sortEnum(Object.keys(ROSTER_SORT)) }
                }
            }
        },
        async (request, reply) => {
            const team = await findTeam(pool, request.params.id);
            const season =
                request.query.season ??
                (
                    await pool.query<{ year: number }>(
                        `SELECT max(s.year) AS year FROM player_team_seasons pts JOIN seasons s ON s.id = pts.season_id
                         WHERE pts.team_id = $1`,
                        [team.id]
                    )
                ).rows[0].year;
            const { rows } = await pool.query(
                `SELECT p.id, p.display_name AS name, pts.jersey_number,
                        pss.games_played, pss.minutes, pss.goals, pss.assists,
                        COALESCE(pss.goals, 0) + COALESCE(pss.assists, 0) AS points,
                        pss.shots, pss.shots_on_goal, pss.saves
                 FROM player_team_seasons pts
                 JOIN players p ON p.id = pts.player_id
                 JOIN seasons s ON s.id = pts.season_id
                 LEFT JOIN player_season_stats pss
                        ON pss.player_id = pts.player_id AND pss.team_id = pts.team_id AND pss.season_id = pts.season_id
                 WHERE pts.team_id = $1 AND s.year = $2
                 ORDER BY ${orderBy(request.query.sort, ROSTER_SORT, 'pss.minutes DESC NULLS LAST')}, p.display_name
                 LIMIT 200`,
                [team.id, season]
            );
            cacheable(reply, cacheSeconds);
            return { team: { id: team.id, slug: team.slug, name: team.name }, season, data: rows };
        }
    );

    app.get<{ Params: { id: string }; Querystring: { season?: number } }>(
        '/api/v1/teams/:id/stats',
        {
            schema: {
                tags: ['teams'],
                summary: 'A team’s season records and box-score totals',
                params: teamIdParam,
                querystring: { type: 'object', properties: { season: seasonQuery } }
            }
        },
        async (request, reply) => {
            const team = await findTeam(pool, request.params.id);
            const { rows } = await pool.query(
                `SELECT s.year AS season, r.played, r.wins, r.draws, r.losses, r.goals_for, r.goals_against,
                        r.exhibitions, agg.games_with_boxscore, agg.shots, agg.shots_on_goal, agg.assists, agg.saves,
                        agg.shots_against, agg.shots_on_goal_against
                 FROM team_seasons ts
                 JOIN seasons s ON s.id = ts.season_id
                 LEFT JOIN team_season_records r ON r.team_id = ts.team_id AND r.season_id = ts.season_id
                 LEFT JOIN LATERAL (
                     SELECT count(*)::int AS games_with_boxscore,
                            sum(mine.shots)::int AS shots, sum(mine.shots_on_goal)::int AS shots_on_goal,
                            sum(mine.assists)::int AS assists, sum(mine.saves)::int AS saves,
                            sum(theirs.shots)::int AS shots_against,
                            sum(theirs.shots_on_goal)::int AS shots_on_goal_against
                     FROM team_game_stats mine
                     JOIN games g ON g.id = mine.game_id
                     LEFT JOIN team_game_stats theirs
                            ON theirs.game_id = mine.game_id
                           AND theirs.team_id = CASE WHEN g.home_team_id = mine.team_id THEN g.away_team_id ELSE g.home_team_id END
                     WHERE mine.team_id = ts.team_id AND g.season_id = ts.season_id AND g.status = 'final'
                 ) agg ON true
                 WHERE ts.team_id = $1 AND ($2::int IS NULL OR s.year = $2)
                 ORDER BY s.year DESC`,
                [team.id, request.query.season ?? null]
            );
            if (request.query.season !== undefined && rows.length === 0) {
                throw new ApiError(404, 'not_found', `${team.name} has no games in ${request.query.season}`);
            }
            cacheable(reply, cacheSeconds);
            return { team: { id: team.id, slug: team.slug, name: team.name }, data: rows };
        }
    );
}
