/**
 * Operational detail: full run records, task errors, per-team coverage, and audited
 * maintenance requests.
 *
 * Two ways in. Scripts present the operator token (ADMIN_API_TOKEN). People sign in, and
 * the role stored for them in accounts.user_profiles must be `admin`; the token's claims
 * and anything the browser says are never consulted for that. Absent entirely when
 * neither is configured. Nothing here starts a scrape: a maintenance request is recorded
 * and the worker carries it out after its next scheduled run (see OPERATIONS.md), so no
 * HTTP request can make the service hammer source sites.
 */

import { timingSafeEqual } from 'crypto';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { audit, Authenticator } from '../auth';
import { ApiError, idParam, notFound, offset, Page, paged, paginationQuery } from '../http';
import { seasonQuery } from './shared';

function tokensMatch(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export interface AdminOptions {
    pool: Pool;
    token?: string;
    accounts?: Pool;
    auth?: Authenticator;
}

export async function adminRoutes(app: FastifyInstance, opts: AdminOptions) {
    const { pool, token, accounts, auth } = opts;

    // Every admin route: tighter rate limit, hidden from the public OpenAPI document.
    app.addHook('onRoute', routeOptions => {
        routeOptions.config = { ...(routeOptions.config as object), rateLimit: { max: 30, timeWindow: '1 minute' } };
        routeOptions.schema = { ...routeOptions.schema, hide: true };
    });

    const denied = (request: FastifyRequest, presented: string, status = 401): never => {
        // Logged as a security event, distinguishable from ingestion noise; the
        // presented value never is.
        request.log.warn(
            { event: 'security.admin_auth_failed', ip: request.ip, path: request.url, presented },
            'admin authentication failed'
        );
        if (status === 403) throw new ApiError(403, 'forbidden', 'Administrator access is required');
        throw new ApiError(401, 'unauthorized', 'A valid admin token or administrator session is required');
    };

    app.addHook('onRequest', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const header = request.headers.authorization ?? '';
        const given = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!given) return denied(request, 'none');
        if (token && tokensMatch(given, token)) {
            request.log.info({ event: 'security.admin_access', ip: request.ip, path: request.url, via: 'token' }, 'admin access');
            return;
        }
        if (!auth || !accounts) return denied(request, 'wrong token');
        const principal = await auth.authenticate(request).catch(() => denied(request, 'invalid session'));
        if (principal.role !== 'admin') {
            await audit(accounts, request, principal, 'admin.denied', { path: request.routeOptions?.url ?? request.url });
            return denied(request, `role ${principal.role}`, 403);
        }
        request.principal = principal;
        request.log.info(
            { event: 'security.admin_access', ip: request.ip, path: request.url, via: 'session', subject: principal.subject },
            'admin access'
        );
        await audit(accounts, request, principal, 'admin.access', { method: request.method, path: request.routeOptions?.url ?? request.url });
    });

    app.get('/api/v1/admin/whoami', async request => ({
        data: request.principal ? { via: 'session', user_id: request.principal.subject, role: request.principal.role } : { via: 'token' }
    }));

    app.get<{ Querystring: Page }>(
        '/api/v1/admin/maintenance',
        { schema: { tags: ['admin'], summary: 'Maintenance requests', querystring: { type: 'object', properties: paginationQuery } } },
        async request => {
            const q = request.query;
            const { rows } = await pool.query(
                `SELECT id::int, action, target_run_id::int, reason, requested_by, status, result_run_id::int, note,
                        created_at, started_at, finished_at, count(*) OVER () AS total_count
                 FROM maintenance_requests ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
                [q.page_size, offset(q)]
            );
            return paged(rows, q);
        }
    );

    app.post<{ Body: { action: 'retry_run' | 'rebuild_analytics'; target_run_id?: number; reason: string; confirm: boolean } }>(
        '/api/v1/admin/maintenance',
        {
            config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
            schema: {
                tags: ['admin'],
                summary: 'Request maintenance (carried out by the worker after its next scheduled run)',
                body: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['action', 'reason', 'confirm'],
                    properties: {
                        action: { type: 'string', enum: ['retry_run', 'rebuild_analytics'] },
                        target_run_id: { type: 'integer', minimum: 1 },
                        reason: { type: 'string', minLength: 10, maxLength: 500 },
                        // Explicit, per request: the UI asks for it, and a replayed or scripted
                        // call without it does nothing.
                        confirm: { type: 'boolean', const: true }
                    }
                }
            }
        },
        async (request, reply) => {
            const principal = request.principal;
            // The operator token is for reading; a request must name the person who made it.
            if (!principal || !accounts) throw new ApiError(403, 'forbidden', 'Maintenance requests need an administrator session');
            const b = request.body;
            if (b.action === 'retry_run') {
                if (!b.target_run_id) throw new ApiError(400, 'invalid_request', 'retry_run needs target_run_id');
                const { rows } = await accounts.query('SELECT status FROM ingestion_runs WHERE id = $1', [b.target_run_id]);
                if (!rows[0]) throw notFound('Run');
                if (!['failed', 'abandoned'].includes(rows[0].status)) {
                    throw new ApiError(409, 'not_retryable', `Run ${b.target_run_id} is ${rows[0].status}; only failed or abandoned runs are retried`);
                }
            } else if (b.target_run_id !== undefined) {
                throw new ApiError(400, 'invalid_request', `${b.action} takes no target_run_id`);
            }
            try {
                await accounts.query(
                    `INSERT INTO maintenance_requests (action, target_run_id, reason, requested_by) VALUES ($1, $2, $3, $4)`,
                    [b.action, b.target_run_id ?? null, b.reason.trim(), principal.subject]
                );
            } catch (err) {
                if ((err as { code?: string }).code === '23505') {
                    throw new ApiError(409, 'already_requested', 'The same maintenance is already pending');
                }
                throw err;
            }
            await audit(accounts, request, principal, 'admin.maintenance_requested', {
                action: b.action,
                target_run_id: b.target_run_id ?? null,
                reason: b.reason.trim()
            });
            return reply.code(202).send({ data: { status: 'pending', action: b.action, target_run_id: b.target_run_id ?? null } });
        }
    );

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
