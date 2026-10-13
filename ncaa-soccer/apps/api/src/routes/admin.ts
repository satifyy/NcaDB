/**
 * Read-only operational detail: full run records, task errors, per-team coverage.
 *
 * Behind a bearer token, and absent entirely when ADMIN_API_TOKEN is unset. Nothing here
 * starts a scrape — ingestion is triggered only from the worker CLI (see OPERATIONS.md),
 * so no HTTP request can make the service hammer source sites.
 */

import { timingSafeEqual } from 'crypto';
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { ApiError, idParam, notFound, offset, Page, paged, paginationQuery } from '../http';
import { seasonQuery } from './shared';

function tokensMatch(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export async function adminRoutes(app: FastifyInstance, opts: { pool: Pool; token: string }) {
    const { pool, token } = opts;

    app.addHook('onRequest', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const header = request.headers.authorization ?? '';
        const given = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!given || !tokensMatch(given, token)) {
            throw new ApiError(401, 'unauthorized', 'A valid admin token is required');
        }
    });

    app.get<{ Querystring: Page & { kind?: string; status?: string } }>(
        '/api/v1/admin/runs',
        {
            schema: {
                tags: ['admin'],
                summary: 'Ingestion runs',
                querystring: {
                    type: 'object',
                    properties: {
                        ...paginationQuery,
                        kind: { type: 'string', maxLength: 40 },
                        status: { type: 'string', enum: ['running', 'succeeded', 'failed', 'skipped', 'abandoned'] }
                    }
                }
            }
        },
        async request => {
            const q = request.query;
            const { rows } = await pool.query(
                `SELECT id::int, kind, trigger, status, params, stats, error, host, started_at, heartbeat_at, finished_at,
                        count(*) OVER () AS total_count
                 FROM ingestion_runs
                 WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR status = $2)
                 ORDER BY started_at DESC LIMIT $3 OFFSET $4`,
                [q.kind ?? null, q.status ?? null, q.page_size, offset(q)]
            );
            return paged(rows, q);
        }
    );

    app.get<{ Params: { id: number } }>(
        '/api/v1/admin/runs/:id',
        { schema: { tags: ['admin'], summary: 'One run with its tasks and errors', params: idParam } },
        async request => {
            const id = request.params.id;
            const [run, tasks, errors] = await Promise.all([
                pool.query('SELECT * FROM ingestion_runs WHERE id = $1', [id]),
                pool.query(
                    `SELECT id::int, season, stage, status, params, stats, error, started_at, finished_at
                     FROM ingestion_tasks WHERE run_id = $1 ORDER BY id`,
                    [id]
                ),
                pool.query(
                    `SELECT id::int, task_id::int, category, severity, code, message, count, context, created_at
                     FROM ingestion_errors WHERE run_id = $1 ORDER BY id`,
                    [id]
                )
            ]);
            if (!run.rows[0]) throw notFound('Run');
            return { data: { ...run.rows[0], tasks: tasks.rows, errors: errors.rows } };
        }
    );

    app.get<{ Querystring: Page & { days: number; category?: string } }>(
        '/api/v1/admin/errors',
        {
            schema: {
                tags: ['admin'],
                summary: 'Recent ingestion errors and data-quality issues',
                querystring: {
                    type: 'object',
                    properties: {
                        ...paginationQuery,
                        days: { type: 'integer', minimum: 1, maximum: 365, default: 7 },
                        category: { type: 'string', enum: ['source', 'parse', 'validation', 'reconciliation', 'database', 'internal'] }
                    }
                }
            }
        },
        async request => {
            const q = request.query;
            const { rows } = await pool.query(
                `SELECT id::int, run_id::int, task_id::int, category, severity, code, message, count, context, created_at,
                        count(*) OVER () AS total_count
                 FROM ingestion_errors
                 WHERE created_at > now() - make_interval(days => $1) AND ($2::text IS NULL OR category = $2)
                 ORDER BY id DESC LIMIT $3 OFFSET $4`,
                [q.days, q.category ?? null, q.page_size, offset(q)]
            );
            return paged(rows, q);
        }
    );

    app.get<{ Querystring: { season: number } }>(
        '/api/v1/admin/coverage/teams',
        {
            schema: {
                tags: ['admin'],
                summary: 'Box-score coverage per Division I team for a season',
                querystring: { type: 'object', properties: { season: seasonQuery }, required: ['season'] }
            }
        },
        async request => {
            const { rows } = await pool.query(
                `SELECT t.id, t.slug, t.name, c.name AS conference, t.platform,
                        count(g.id)::int AS games,
                        count(g.id) FILTER (WHERE g.status = 'final')::int AS completed,
                        count(tg.game_id)::int AS with_boxscore,
                        count(g.id) FILTER (WHERE g.status = 'final' AND tg.game_id IS NULL)::int AS missing_boxscore,
                        max(g.game_date) FILTER (WHERE g.status = 'final')::text AS last_completed
                 FROM teams t
                 LEFT JOIN conferences c ON c.id = t.conference_id
                 JOIN seasons s ON s.year = $1
                 LEFT JOIN games g ON g.season_id = s.id AND t.id IN (g.home_team_id, g.away_team_id)
                 LEFT JOIN team_game_stats tg ON tg.game_id = g.id AND tg.team_id = t.id
                 WHERE t.is_division_one
                 GROUP BY t.id, t.slug, t.name, c.name, t.platform
                 ORDER BY missing_boxscore DESC, t.name`,
                [request.query.season]
            );
            return { season: request.query.season, data: rows };
        }
    );
}
