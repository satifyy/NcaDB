/**
 * Builds the HTTP app. Separate from `server.ts` so tests can drive it with `inject()`
 * against a real database and no open port.
 */

import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { Pool } from 'pg';
import { ApiConfig, originMatcher } from './config';
import { ApiError } from './http';
import { adminRoutes } from './routes/admin';
import { gameRoutes } from './routes/games';
import { metaRoutes } from './routes/meta';
import { playerRoutes } from './routes/players';
import { teamRoutes } from './routes/teams';

export async function buildApp(pool: Pool, config: ApiConfig, options: { logger?: boolean } = {}): Promise<FastifyInstance> {
    const app = Fastify({
        logger: options.logger === false ? false : { level: process.env.LOG_LEVEL || 'info' },
        // Railway terminates TLS at its edge proxy; the client address is in X-Forwarded-For.
        trustProxy: true,
        ajv: { customOptions: { coerceTypes: true, removeAdditional: true, useDefaults: true } }
    });

    await app.register(swagger, {
        openapi: {
            info: {
                title: 'NCADB API',
                version: config.version,
                description:
                    'Read-only NCAA Division I men’s soccer data: teams, players, games, box scores and data freshness.'
            },
            components: {
                securitySchemes: { admin: { type: 'http', scheme: 'bearer' } }
            }
        }
    });

    const allowed = originMatcher(config.corsOrigins);
    await app.register(cors, {
        origin: (origin, cb) => cb(null, !origin || allowed(origin)),
        methods: ['GET', 'HEAD', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'Content-Type', 'If-None-Match'],
        exposedHeaders: ['ETag'],
        maxAge: 86400
    });
    await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });
    await app.register(rateLimit, {
        max: config.rateLimitPerMinute,
        timeWindow: '1 minute',
        allowList: (req: { url: string }) => req.url === '/health'
    });

    app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
        if (error instanceof ApiError) {
            return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
        }
        if ((error as FastifyError).validation) {
            return reply.code(400).send({ error: { code: 'invalid_request', message: error.message } });
        }
        const status = (error as FastifyError).statusCode ?? 500;
        if (status === 429) {
            return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests' } });
        }
        if (status < 500) {
            return reply.code(status).send({ error: { code: 'bad_request', message: error.message } });
        }
        // Internals are logged, never returned.
        request.log.error({ err: error }, 'request failed');
        return reply.code(500).send({ error: { code: 'internal', message: 'Internal error' } });
    });
    app.setNotFoundHandler((_request, reply) => {
        reply.code(404).send({ error: { code: 'not_found', message: 'No such route' } });
    });

    const shared = { pool, cacheSeconds: config.cacheSeconds };
    await app.register(metaRoutes, { ...shared, version: config.version });
    await app.register(teamRoutes, shared);
    await app.register(playerRoutes, shared);
    await app.register(gameRoutes, shared);
    if (config.adminToken) await app.register(adminRoutes, { pool, token: config.adminToken });

    app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
    app.get('/', { schema: { hide: true } }, async () => ({
        service: 'ncadb-api',
        docs: '/api/v1/openapi.json',
        health: '/health'
    }));

    return app;
}
