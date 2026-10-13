import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { ApiError, cacheable, idParam, notFound, offset, orderBy, Page, paged, paginationQuery, sortEnum } from '../http';
import { seasonQuery } from './shared';

const DATE = { type: 'string', format: 'date' } as const;

const GAME_COLUMNS = `
    g.id, g.game_date::text AS date, s.year AS season, g.status, g.game_type, g.location_type,
    g.home_score, g.away_score, g.boxscore_status, g.quality_flags,
    h.id AS home_team_id, h.slug AS home_team_slug, h.name AS home_team_name, h.is_division_one AS home_division_one,
    a.id AS away_team_id, a.slug AS away_team_slug, a.name AS away_team_name, a.is_division_one AS away_division_one`;

export async function gameRoutes(app: FastifyInstance, opts: { pool: Pool; cacheSeconds: number }) {
    const { pool, cacheSeconds } = opts;

    app.get<{
        Querystring: Page & {
            season?: number;
            team?: string;
            date_from?: string;
            date_to?: string;
            status?: string;
            boxscore?: string;
            division_one?: string;
            sort?: string;
        };
    }>(
        '/api/v1/games',
        {
            schema: {
                tags: ['games'],
                summary: 'Games, filtered by season, team, date and status',
                querystring: {
                    type: 'object',
                    properties: {
                        ...paginationQuery,
                        season: seasonQuery,
                        team: { type: 'string', pattern: '^([0-9]+|[a-z0-9-]{1,80})$' },
                        date_from: DATE,
                        date_to: DATE,
                        status: { type: 'string', enum: ['scheduled', 'final', 'postponed', 'canceled', 'unknown', 'live'] },
                        boxscore: { type: 'string', enum: ['complete', 'partial', 'none'] },
                        division_one: { type: 'string', enum: ['both', 'either', 'all'], default: 'all' },
                        sort: sortEnum(['date'])
                    }
                }
            }
        },
        async (request, reply) => {
            const q = request.query;
            if (q.date_from && q.date_to && q.date_from > q.date_to) {
                throw new ApiError(400, 'invalid_range', 'date_from is after date_to');
            }
            const { rows } = await pool.query(
                `SELECT ${GAME_COLUMNS}, count(*) OVER () AS total_count
                 FROM games g
                 JOIN seasons s ON s.id = g.season_id
                 JOIN teams h ON h.id = g.home_team_id
                 JOIN teams a ON a.id = g.away_team_id
                 WHERE ($1::int IS NULL OR s.year = $1)
                   AND ($2::text IS NULL OR $2 IN (h.slug, a.slug, h.id::text, a.id::text))
                   AND ($3::date IS NULL OR g.game_date >= $3)
                   AND ($4::date IS NULL OR g.game_date <= $4)
                   AND ($5::text IS NULL OR g.status = $5)
                   AND ($6::text IS NULL OR g.boxscore_status = $6)
                   AND ($7 = 'all' OR ($7 = 'both' AND h.is_division_one AND a.is_division_one)
                        OR ($7 = 'either' AND (h.is_division_one OR a.is_division_one)))
                 ORDER BY ${orderBy(q.sort, { date: 'g.game_date' }, 'g.game_date DESC')}, g.id
                 LIMIT $8 OFFSET $9`,
                [
                    q.season ?? null,
                    q.team ?? null,
                    q.date_from ?? null,
                    q.date_to ?? null,
                    q.status ?? null,
                    q.boxscore ?? null,
                    q.division_one ?? 'all',
                    q.page_size,
                    offset(q)
                ]
            );
            cacheable(reply, cacheSeconds);
            return paged(rows, q);
        }
    );

    async function loadGame(id: number) {
        const { rows } = await pool.query(
            `SELECT ${GAME_COLUMNS}, g.home_team_ranked, g.away_team_ranked, g.schedule_url, g.boxscore_url,
                    g.boxscore_url_alt, g.first_seen_at, g.updated_at, g.last_verified_at
             FROM games g
             JOIN seasons s ON s.id = g.season_id
             JOIN teams h ON h.id = g.home_team_id
             JOIN teams a ON a.id = g.away_team_id
             WHERE g.id = $1`,
            [id]
        );
        if (!rows[0]) throw notFound('Game');
        return rows[0];
    }

    app.get<{ Params: { id: number } }>(
        '/api/v1/games/:id',
        { schema: { tags: ['games'], summary: 'One game, with its sources and team totals', params: idParam } },
        async (request, reply) => {
            const game = await loadGame(request.params.id);
            const [totals, sources] = await Promise.all([
                pool.query(
                    `SELECT team_id, players, minutes, goals, assists, shots, shots_on_goal, saves, reported_score,
                            goals_reconciliation
                     FROM team_game_stats WHERE game_id = $1`,
                    [game.id]
                ),
                pool.query(
                    `SELECT source_game_id, payload->>'boxscore_url' AS boxscore_url, first_seen_at, last_seen_at
                     FROM game_sources WHERE game_id = $1 ORDER BY id`,
                    [game.id]
                )
            ]);
            cacheable(reply, cacheSeconds);
            return { data: { ...game, team_totals: totals.rows, sources: sources.rows } };
        }
    );

    app.get<{ Params: { id: number } }>(
        '/api/v1/games/:id/boxscore',
        { schema: { tags: ['games'], summary: 'Player lines for both sides of a game', params: idParam } },
        async (request, reply) => {
            const game = await loadGame(request.params.id);
            const [lines, totals] = await Promise.all([
                pool.query(
                    `SELECT pgs.team_id, p.id AS player_id, p.display_name AS name, pgs.jersey_number, pgs.minutes,
                            pgs.goals, pgs.assists, pgs.shots, pgs.shots_on_goal, pgs.saves
                     FROM player_game_stats pgs JOIN players p ON p.id = pgs.player_id
                     WHERE pgs.game_id = $1
                     ORDER BY pgs.team_id, pgs.minutes DESC NULLS LAST, p.display_name`,
                    [game.id]
                ),
                pool.query(
                    `SELECT team_id, players, minutes, goals, assists, shots, shots_on_goal, saves, reported_score,
                            goals_reconciliation
                     FROM team_game_stats WHERE game_id = $1`,
                    [game.id]
                )
            ]);
            const side = (teamId: number, slug: string, name: string) => ({
                team_id: teamId,
                team_slug: slug,
                team_name: name,
                totals: totals.rows.find(t => t.team_id === teamId) ?? null,
                players: lines.rows.filter(l => l.team_id === teamId).map(({ team_id: _t, ...rest }) => rest)
            });
            // Rows whose team label could not be placed on either side are returned, not
            // hidden, so the page can say the box score has them.
            const unattributed = lines.rows.filter(l => l.team_id !== game.home_team_id && l.team_id !== game.away_team_id);
            cacheable(reply, cacheSeconds);
            return {
                data: {
                    game,
                    available: game.boxscore_status !== 'none',
                    home: side(game.home_team_id, game.home_team_slug, game.home_team_name),
                    away: side(game.away_team_id, game.away_team_slug, game.away_team_name),
                    unattributed
                }
            };
        }
    );
}
