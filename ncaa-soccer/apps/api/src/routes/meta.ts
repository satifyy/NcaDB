/**
 * Health, status, data freshness, reference lists, and the analytics files.
 */

import { gzipSync } from 'zlib';
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { ARTIFACT_KEY, freshness, pendingMigrations, seasonCoverage } from '@ncaa/database';
import { ApiError, cacheable, notFound } from '../http';

export async function metaRoutes(app: FastifyInstance, opts: { pool: Pool; cacheSeconds: number; version: string }) {
    const { pool, cacheSeconds, version } = opts;
    const started = Date.now();

    const ping = async () => {
        const t = process.hrtime.bigint();
        try {
            await pool.query('SELECT 1');
            return { ok: true, latency_ms: Number(process.hrtime.bigint() - t) / 1e6 };
        } catch {
            return { ok: false, latency_ms: null };
        }
    };

    app.get('/health', { schema: { tags: ['meta'], summary: 'Liveness and database connectivity' } }, async (_req, reply) => {
        const db = await ping();
        reply.header('Cache-Control', 'no-store').code(db.ok ? 200 : 503);
        return { ok: db.ok, database: db.ok ? 'up' : 'down' };
    });

    app.get('/api/v1/status', { schema: { tags: ['meta'], summary: 'Service version, database latency, latest run' } }, async (_req, reply) => {
        const db = await ping();
        const [pending, fresh] = db.ok
            ? await Promise.all([pendingMigrations(pool), freshness(pool)])
            : [null, null];
        reply.header('Cache-Control', 'no-store');
        return {
            service: 'ncadb-api',
            version,
            uptime_seconds: Math.round((Date.now() - started) / 1000),
            database: db,
            pending_migrations: pending,
            latest_run: fresh?.latest_run ?? null
        };
    });

    app.get('/api/v1/data-status', { schema: { tags: ['meta'], summary: 'Freshness, coverage by season, recent ingestion runs' } }, async (_req, reply) => {
        const [fresh, coverage, runs, issues] = await Promise.all([
            freshness(pool),
            seasonCoverage(pool),
            pool.query(
                `SELECT id::int, kind, trigger, status, started_at, finished_at,
                        stats->'totals' AS totals, (stats->>'seconds')::int AS seconds
                 FROM ingestion_runs ORDER BY started_at DESC LIMIT 10`
            ),
            pool.query(
                `SELECT category, severity, code, sum(count)::int AS rows
                 FROM ingestion_errors e JOIN ingestion_runs r ON r.id = e.run_id
                 WHERE r.id = (SELECT id FROM ingestion_runs WHERE status IN ('succeeded', 'failed')
                               AND kind IN ('nightly', 'backfill') ORDER BY started_at DESC LIMIT 1)
                 GROUP BY category, severity, code ORDER BY rows DESC`
            )
        ]);
        reply.header('Cache-Control', 'public, max-age=60');
        return { freshness: fresh, coverage, recent_runs: runs.rows, latest_run_issues: issues.rows };
    });

    app.get('/api/v1/seasons', { schema: { tags: ['meta'], summary: 'Seasons with games' } }, async (_req, reply) => {
        const { rows } = await pool.query(
            `SELECT s.year AS season, count(g.*)::int AS games,
                    count(g.*) FILTER (WHERE g.status = 'final')::int AS completed,
                    min(g.game_date)::text AS first_date, max(g.game_date)::text AS last_date
             FROM seasons s JOIN games g ON g.season_id = s.id
             GROUP BY s.year ORDER BY s.year DESC`
        );
        cacheable(reply, cacheSeconds);
        return { data: rows };
    });

    app.get('/api/v1/conferences', { schema: { tags: ['meta'], summary: 'Conferences and their Division I teams' } }, async (_req, reply) => {
        const { rows } = await pool.query(
            `SELECT c.id, c.name, count(t.id)::int AS teams
             FROM conferences c JOIN teams t ON t.conference_id = c.id AND t.is_division_one
             GROUP BY c.id, c.name ORDER BY c.name`
        );
        cacheable(reply, cacheSeconds);
        return { data: rows };
    });

    /**
     * The analytics files, as the worker stored them. Bytes are served exactly as written,
     * gzipped once per version and kept in memory — the largest is ~15 MB of JSON — with
     * the content hash as a strong ETag, so a revisit costs a 304.
     */
    const compressed = new Map<string, Buffer>();
    let compressedBytes = 0;
    const CACHE_LIMIT = 192 * 1024 * 1024;

    app.get<{ Params: { '*': string } }>(
        '/api/v1/artifacts/*',
        { schema: { tags: ['meta'], summary: 'Derived analytics files (ratings, forecasts, impact, season tables)' } },
        async (request, reply) => {
            const key = request.params['*'];
            if (!ARTIFACT_KEY.test(key)) throw new ApiError(400, 'invalid_key', 'Not an artifact path');
            const head = await pool.query<{ content_hash: string; generated_at: Date }>(
                'SELECT content_hash, generated_at FROM derived_artifacts WHERE key = $1',
                [key]
            );
            if (!head.rows[0]) throw notFound('Artifact');
            const { content_hash: hash, generated_at } = head.rows[0];
            const etag = `"${hash}"`;
            reply.header('ETag', etag);
            reply.header('Last-Modified', generated_at.toUTCString());
            reply.header('Cache-Control', `public, max-age=${cacheSeconds}, stale-while-revalidate=86400`);
            reply.header('Vary', 'Accept-Encoding');
            if (request.headers['if-none-match'] === etag) return reply.code(304).send();

            const cacheKey = `${key}:${hash}`;
            let gz = compressed.get(cacheKey);
            if (!gz) {
                const { rows } = await pool.query<{ content: string }>('SELECT content FROM derived_artifacts WHERE key = $1', [key]);
                if (!rows[0]) throw notFound('Artifact');
                gz = gzipSync(rows[0].content, { level: 6 });
                if (compressedBytes + gz.length > CACHE_LIMIT) {
                    compressed.clear();
                    compressedBytes = 0;
                }
                compressed.set(cacheKey, gz);
                compressedBytes += gz.length;
            }
            reply.type('application/json; charset=utf-8');
            if (/\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) {
                reply.header('Content-Encoding', 'gzip');
                return reply.send(gz);
            }
            const { rows } = await pool.query<{ content: string }>('SELECT content FROM derived_artifacts WHERE key = $1', [key]);
            return reply.send(rows[0].content);
        }
    );
}
