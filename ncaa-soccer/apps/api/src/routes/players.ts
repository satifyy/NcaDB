import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { cacheable, idParam, notFound, offset, orderBy, Page, paged, paginationQuery, sortEnum } from '../http';
import { latestSeason, likePattern, seasonQuery } from './shared';
import { result } from './teams';

const PLAYER_SORT = {
    name: 'name',
    goals: 'goals',
    assists: 'assists',
    points: 'points',
    minutes: 'minutes',
    games: 'games_played',
    shots: 'shots',
    shots_on_goal: 'shots_on_goal',
    saves: 'saves'
};

export async function playerRoutes(app: FastifyInstance, opts: { pool: Pool; cacheSeconds: number }) {
    const { pool, cacheSeconds } = opts;

    app.get<{
        Querystring: Page & { search?: string; team?: string; conference?: string; season?: string; division_one: string; sort?: string };
    }>(
        '/api/v1/players',
        {
            schema: {
                tags: ['players'],
                summary: 'Search players and rank them by season (or career) totals',
                querystring: {
                    type: 'object',
                    properties: {
                        ...paginationQuery,
                        search: { type: 'string', minLength: 1, maxLength: 80 },
                        team: { type: 'string', pattern: '^([0-9]+|[a-z0-9-]{1,80})$' },
                        conference: { type: 'string', maxLength: 80 },
                        season: { type: 'string', pattern: '^(all|[0-9]{4})$', description: 'A year, or "all" for career totals' },
                        division_one: { type: 'string', enum: ['true', 'false', 'all'], default: 'all' },
                        sort: sortEnum(Object.keys(PLAYER_SORT))
                    }
                }
            }
        },
        async (request, reply) => {
            const q = request.query;
            const allSeasons = q.season === 'all';
            const season = allSeasons ? null : q.season ? Number(q.season) : await latestSeason(pool);
            const team = q.team ?? null;
            const d1 = q.division_one === 'all' ? null : q.division_one === 'true';
            const order = orderBy(q.sort, PLAYER_SORT, 'goals DESC NULLS LAST, assists DESC NULLS LAST');
            const { rows } = await pool.query(
                `WITH totals AS (
                     SELECT pss.player_id, pss.team_id,
                            ${allSeasons ? 'NULL::int' : 'max(s.year)'} AS season,
                            sum(pss.games_played)::int AS games_played, sum(pss.minutes)::int AS minutes,
                            sum(pss.goals)::int AS goals, sum(pss.assists)::int AS assists,
                            sum(pss.shots)::int AS shots, sum(pss.shots_on_goal)::int AS shots_on_goal,
                            sum(pss.saves)::int AS saves
                     FROM player_season_stats pss JOIN seasons s ON s.id = pss.season_id
                     WHERE ($1::int IS NULL OR s.year = $1)
                     GROUP BY pss.player_id, pss.team_id
                 )
                 SELECT p.id, p.display_name AS name, t.id AS team_id, t.slug AS team_slug, t.name AS team_name,
                        c.name AS conference, x.season, x.games_played, x.minutes, x.goals, x.assists,
                        COALESCE(x.goals, 0) + COALESCE(x.assists, 0) AS points,
                        x.shots, x.shots_on_goal, x.saves, count(*) OVER () AS total_count
                 FROM totals x
                 JOIN players p ON p.id = x.player_id
                 JOIN teams t ON t.id = x.team_id
                 LEFT JOIN conferences c ON c.id = t.conference_id
                 WHERE ($2::text IS NULL OR p.display_name ILIKE $2 OR p.name ILIKE $2)
                   AND ($3::text IS NULL OR t.slug = $3 OR t.id::text = $3)
                   AND ($4::text IS NULL OR c.name = $4)
                   AND ($5::boolean IS NULL OR t.is_division_one = $5)
                 ORDER BY ${order.replace(/^name /, 'p.display_name ')}, p.id
                 LIMIT $6 OFFSET $7`,
                [season, likePattern(q.search), team, q.conference ?? null, d1, q.page_size, offset(q)]
            );
            cacheable(reply, cacheSeconds);
            return { season: allSeasons ? 'all' : season, ...paged(rows, q) };
        }
    );

    app.get<{ Params: { id: number } }>(
        '/api/v1/players/:id',
        { schema: { tags: ['players'], summary: 'One player, with every season they played', params: idParam } },
        async (request, reply) => {
            const { rows } = await pool.query(
                `SELECT p.id, p.display_name AS name, p.name AS source_name, t.id AS team_id, t.slug AS team_slug,
                        t.name AS team_name, c.name AS conference, split_part(p.identity_key, ':', 2) AS letters
                 FROM players p JOIN teams t ON t.id = p.team_id LEFT JOIN conferences c ON c.id = t.conference_id
                 WHERE p.id = $1`,
                [request.params.id]
            );
            const player = rows[0];
            if (!player) throw notFound('Player');
            const [seasons, others] = await Promise.all([
                pool.query(
                    `SELECT s.year AS season, t.id AS team_id, t.slug AS team_slug, t.name AS team_name, pts.jersey_number,
                            pss.games_played, pss.minutes, pss.goals, pss.assists, pss.shots, pss.shots_on_goal, pss.saves
                     FROM player_team_seasons pts
                     JOIN seasons s ON s.id = pts.season_id
                     JOIN teams t ON t.id = pts.team_id
                     LEFT JOIN player_season_stats pss
                            ON pss.player_id = pts.player_id AND pss.team_id = pts.team_id AND pss.season_id = pts.season_id
                     WHERE pts.player_id = $1 ORDER BY s.year`,
                    [player.id]
                ),
                // Same name at other schools. Shown as a lead, never merged: a name is not
                // a person, and nothing in a box score says these are the same player.
                pool.query(
                    `SELECT p.id, p.display_name AS name, t.slug AS team_slug, t.name AS team_name,
                            array_agg(DISTINCT s.year ORDER BY s.year) AS seasons
                     FROM players p JOIN teams t ON t.id = p.team_id
                     JOIN player_team_seasons pts ON pts.player_id = p.id JOIN seasons s ON s.id = pts.season_id
                     WHERE split_part(p.identity_key, ':', 2) = $1 AND p.id <> $2
                     GROUP BY p.id, p.display_name, t.slug, t.name
                     LIMIT 10`,
                    [player.letters, player.id]
                )
            ]);
            const sum = (k: string) =>
                seasons.rows.some(r => r[k] !== null) ? seasons.rows.reduce((n, r) => n + (r[k] ?? 0), 0) : null;
            const { letters: _letters, ...data } = player;
            cacheable(reply, cacheSeconds);
            return {
                data: {
                    ...data,
                    seasons: seasons.rows,
                    career: {
                        seasons: seasons.rows.length,
                        games_played: sum('games_played'),
                        minutes: sum('minutes'),
                        goals: sum('goals'),
                        assists: sum('assists'),
                        shots: sum('shots'),
                        shots_on_goal: sum('shots_on_goal'),
                        saves: sum('saves')
                    },
                    same_name_elsewhere: others.rows
                }
            };
        }
    );

    app.get<{ Params: { id: number }; Querystring: Page & { season?: number } }>(
        '/api/v1/players/:id/games',
        {
            schema: {
                tags: ['players'],
                summary: 'A player’s game log',
                params: idParam,
                querystring: {
                    type: 'object',
                    properties: { ...paginationQuery, page_size: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, season: seasonQuery }
                }
            }
        },
        async (request, reply) => {
            const exists = await pool.query('SELECT 1 FROM players WHERE id = $1', [request.params.id]);
            if (!exists.rowCount) throw notFound('Player');
            const q = request.query;
            const { rows } = await pool.query(
                `SELECT g.id AS game_id, g.game_date::text AS date, s.year AS season, g.status, g.game_type,
                        t.id AS team_id, t.slug AS team_slug, t.name AS team_name,
                        opp.id AS opponent_id, opp.slug AS opponent_slug, opp.name AS opponent_name,
                        CASE WHEN g.home_team_id = pgs.team_id THEN g.home_score ELSE g.away_score END AS team_score,
                        CASE WHEN g.home_team_id = pgs.team_id THEN g.away_score ELSE g.home_score END AS opponent_score,
                        pgs.jersey_number, pgs.minutes, pgs.goals, pgs.assists, pgs.shots, pgs.shots_on_goal, pgs.saves,
                        count(*) OVER () AS total_count
                 FROM player_game_stats pgs
                 JOIN games g ON g.id = pgs.game_id
                 JOIN seasons s ON s.id = g.season_id
                 JOIN teams t ON t.id = pgs.team_id
                 LEFT JOIN teams opp ON opp.id = CASE WHEN g.home_team_id = pgs.team_id THEN g.away_team_id
                                                      WHEN g.away_team_id = pgs.team_id THEN g.home_team_id END
                 WHERE pgs.player_id = $1 AND ($2::int IS NULL OR s.year = $2)
                 ORDER BY g.game_date DESC, g.id
                 LIMIT $3 OFFSET $4`,
                [request.params.id, q.season ?? null, q.page_size, offset(q)]
            );
            cacheable(reply, cacheSeconds);
            const page = paged(rows, q);
            return { ...page, data: page.data.map(g => ({ ...g, result: result(g.team_score, g.opponent_score, g.status) })) };
        }
    );

    app.get<{ Params: { id: number } }>(
        '/api/v1/players/:id/stats',
        { schema: { tags: ['players'], summary: 'A player’s totals by season', params: idParam } },
        async (request, reply) => {
            const { rows } = await pool.query(
                `SELECT s.year AS season, t.id AS team_id, t.slug AS team_slug, t.name AS team_name,
                        pss.games_played, pss.minutes, pss.goals, pss.assists,
                        COALESCE(pss.goals, 0) + COALESCE(pss.assists, 0) AS points,
                        pss.shots, pss.shots_on_goal, pss.saves
                 FROM player_season_stats pss JOIN seasons s ON s.id = pss.season_id JOIN teams t ON t.id = pss.team_id
                 WHERE pss.player_id = $1 ORDER BY s.year`,
                [request.params.id]
            );
            if (rows.length === 0) {
                const exists = await pool.query('SELECT 1 FROM players WHERE id = $1', [request.params.id]);
                if (!exists.rowCount) throw notFound('Player');
            }
            cacheable(reply, cacheSeconds);
            return { data: rows };
        }
    );
}
