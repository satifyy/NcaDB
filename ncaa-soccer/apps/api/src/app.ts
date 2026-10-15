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
import { Authenticator } from './auth';
import { ApiError } from './http';
import { adminRoutes } from './routes/admin';
import { gameRoutes } from './routes/games';
import { meRoutes } from './routes/me';
import { metaRoutes } from './routes/meta';
import { playerRoutes } from './routes/players';
import { teamRoutes } from './routes/teams';
import { teamOfWeekRoutes } from './routes/teamOfWeek';

/**
 * `pool` is the public, read-only sports connection (ncadb_api). `options.accounts` is the
 * separate ncadb_accounts connection for signed-in users' own data; without it, or without
 * Clerk settings, the user routes answer 503 and only the operator token reaches admin.
 */
export async function buildApp(
    pool: Pool,
    config: ApiConfig,
    options: { logger?: boolean; accounts?: Pool } = {}
): Promise<FastifyInstance> {
    const app = Fastify({
        logger: options.logger === false ? false : { level: process.env.LOG_LEVEL || 'info' },
        // Railway terminates TLS at its edge proxy, which overwrites X-Forwarded-For with the
        // real client address (verified: a spoofed header does not change the rate-limit
        // key), so the forwarded address can be trusted.
        trustProxy: true,
        // Only the signed-in routes take bodies, and those are a few small fields.
        bodyLimit: 4096,
        connectionTimeout: 30_000,
        requestTimeout: 30_000,
        keepAliveTimeout: 65_000,
        // During a deploy's shutdown, refuse new requests cleanly instead of hanging them.
        return503OnClosing: true,
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
                securitySchemes: {
                    admin: { type: 'http', scheme: 'bearer' },
                    session: { type: 'http', scheme: 'bearer', bearerFormat: 'Clerk session token (JWT)' }
                }
            }
        }
    });

    const allowed = originMatcher(config.corsOrigins);
    await app.register(cors, {
        origin: (origin, cb) => cb(null, !origin || allowed(origin)),
        // Writes exist only under /api/v1/me and /api/v1/admin, and need a bearer token.
        // No credentials mode: the API uses no cookies.
        methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type', 'If-None-Match'],
        exposedHeaders: ['ETag'],
        maxAge: 86400
    });
    await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });
    await app.register(rateLimit, {
        max: config.rateLimitPerMinute,
        timeWindow: '1 minute',
        allowList: (req: { url: string }) => req.url === '/health',
        onExceeded: req => {
            req.log.warn({ event: 'security.rate_limited', ip: req.ip, path: req.routeOptions?.url ?? req.url }, 'rate limit exceeded');
        }
    });

    // Headers for a JSON API: nothing it returns should ever be rendered, framed, sniffed
    // or loaded as a script, and HTTPS is the only way to reach it.
    app.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
        reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
        reply.removeHeader('X-Powered-By');
        return payload;
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
    await app.register(teamOfWeekRoutes, shared);
    const auth = config.auth && options.accounts ? new Authenticator(config.auth, options.accounts) : undefined;
    if (auth) {
        await app.register(meRoutes, { accounts: options.accounts!, auth });
    } else {
        app.all('/api/v1/me', { schema: { hide: true } }, async (_request, reply) => authUnavailable(reply));
        app.all('/api/v1/me/*', { schema: { hide: true } }, async (_request, reply) => authUnavailable(reply));
    }
    if (config.adminToken || auth) {
        await app.register(adminRoutes, { pool, token: config.adminToken, accounts: options.accounts, auth });
    }

    app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
    app.get('/', { schema: { hide: true } }, async () => ({
        service: 'ncadb-api',
        docs: '/api/v1/openapi.json',
        health: '/health'
    }));

    return app;
}

function authUnavailable(reply: import('fastify').FastifyReply) {
    return reply
        .code(503)
        .header('Cache-Control', 'no-store')
        .send({ error: { code: 'auth_unavailable', message: 'Sign-in is not available on this server' } });
}
