/**
 * API security regression tests: injection, unsafe content, auth, limits, headers, CORS,
 * error hygiene. Run against a real database with hostile inputs.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadSeason, refreshReadModels } from '@ncaa/database';
import { batch, count, freshDatabase, game, skipWithoutDb, stat } from '../../../packages/database/test/helpers';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

const TOKEN = 'test-admin-token-0123456789abcdef';
const XSS = `<img src=x onerror="alert(1)">`;

describe('API security', { skip: skipWithoutDb }, () => {
    let pool: Pool;
    let app: FastifyInstance;

    before(async () => {
        pool = await freshDatabase();
        await loadSeason(pool, batch(2025, [game()], [stat(XSS, 'duke', { goals: 1 }), stat('Bo Keeper', 'duke')]));
        await refreshReadModels(pool);
        app = await buildApp(
            pool,
            loadConfig({ ADMIN_API_TOKEN: TOKEN, CORS_ALLOWED_ORIGINS: 'https://satifyy.com', RATE_LIMIT_PER_MINUTE: '40' }),
            { logger: false }
        );
    });
    after(async () => {
        await app?.close();
        await pool?.end();
    });

    const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

    test('SQL injection payloads are treated as data, not SQL', async () => {
        const gamesBefore = await count(pool, 'games');
        const payloads = [`' OR 1=1 --`, `'; DROP TABLE games; --`, `%' UNION SELECT password FROM pg_shadow --`, `\\'; SELECT pg_sleep(10); --`];
        for (const p of payloads) {
            const q = encodeURIComponent(p);
            const teams = await get(`/api/v1/teams?search=${q}`);
            assert.equal(teams.statusCode, 200, p);
            assert.equal(teams.json().data.length, 0, `search "${p}" must match nothing`);
            assert.equal((await get(`/api/v1/players?search=${q}&season=2025`)).json().data.length, 0, p);
            assert.equal((await get(`/api/v1/teams/${q}`)).statusCode, 400, 'id/slug pattern rejects it');
            assert.equal((await get(`/api/v1/games?team=${q}`)).statusCode, 400);
            assert.equal((await get(`/api/v1/players?sort=${q}`)).statusCode, 400);
            assert.equal((await get(`/api/v1/conferences?x=${q}`)).statusCode, 200);
        }
        assert.equal(await count(pool, 'games'), gamesBefore);
    });

    test('LIKE wildcards in a search are literal', async () => {
        assert.equal((await get('/api/v1/teams?search=%25')).json().data.length, 0);
        assert.equal((await get('/api/v1/teams?search=_')).json().data.length, 0);
    });

    test('scraped markup comes back as inert JSON text', async () => {
        const res = await get('/api/v1/players?season=2025&search=onerror');
        assert.match(String(res.headers['content-type']), /^application\/json/);
        assert.equal(res.json().data[0].name, XSS, 'stored verbatim, escaped by JSON');
        assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
    });

    test('security headers are on every response, including errors', async () => {
        for (const url of ['/health', '/api/v1/teams', '/api/v1/nope', '/api/v1/teams/999999']) {
            const res = await get(url);
            assert.match(String(res.headers['strict-transport-security']), /max-age=31536000/, url);
            assert.equal(res.headers['x-frame-options'], 'DENY', url);
            assert.equal(res.headers['referrer-policy'], 'no-referrer', url);
            assert.ok(res.headers['permissions-policy'], url);
            assert.equal(res.headers['x-powered-by'], undefined, url);
        }
    });

    test('admin routes refuse missing, wrong and malformed tokens, and are not advertised', async () => {
        for (const auth of [undefined, 'Bearer wrong', `Bearer ${TOKEN}x`, TOKEN, `Basic ${TOKEN}`, 'Bearer ']) {
            const res = await get('/api/v1/admin/runs', auth ? { authorization: auth } : {});
            assert.equal(res.statusCode, 401, String(auth));
            assert.equal(res.headers['cache-control'], 'no-store');
        }
        assert.equal((await get('/api/v1/admin/runs', { authorization: `Bearer ${TOKEN}` })).statusCode, 200);
        const doc = (await get('/api/v1/openapi.json')).json();
        assert.ok(!Object.keys(doc.paths).some(p => p.includes('/admin/')), 'admin routes hidden from OpenAPI');
    });

    test('there is no way to start ingestion or write anything over HTTP', async () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
            for (const url of ['/api/v1/teams', '/api/v1/admin/runs', '/api/v1/games/1']) {
                const res = await app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` } });
                assert.ok([404, 405].includes(res.statusCode), `${method} ${url} -> ${res.statusCode}`);
            }
        }
    });

    test('oversized and malformed input is rejected', async () => {
        const body = await app.inject({ method: 'POST', url: '/api/v1/teams', payload: 'x'.repeat(5000), headers: { 'content-type': 'text/plain' } });
        assert.ok([404, 413].includes(body.statusCode));
        assert.equal((await get('/api/v1/teams?search=' + 'a'.repeat(500))).statusCode, 400);
        assert.equal((await get('/api/v1/games?page_size=101')).statusCode, 400);
        assert.equal((await get('/api/v1/games?page=501')).statusCode, 400, 'deep pagination is bounded');
        assert.equal((await get('/api/v1/games?date_from=2025-02-30')).statusCode, 400);
        assert.equal((await get('/api/v1/games/abc')).statusCode, 400);
        assert.equal((await get('/api/v1/artifacts/..%2F..%2Fetc%2Fpasswd')).statusCode, 400);
    });

    test('errors never leak internals', async () => {
        const broken = await buildApp(
            new Pool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMillis: 500 }),
            loadConfig({}),
            { logger: false }
        );
        const res = await broken.inject({ method: 'GET', url: '/api/v1/teams' });
        await broken.close();
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.json(), { error: { code: 'internal', message: 'Internal error' } });
        assert.doesNotMatch(res.body, /127\.0\.0\.1|ECONNREFUSED|stack|nobody/);
    });

    test('CORS answers only the configured origin', async () => {
        assert.equal((await get('/api/v1/seasons', { origin: 'https://satifyy.com' })).headers['access-control-allow-origin'], 'https://satifyy.com');
        for (const origin of ['https://evil.example', 'https://satifyy.com.evil.example', 'null']) {
            assert.equal((await get('/api/v1/seasons', { origin })).headers['access-control-allow-origin'], undefined, origin);
        }
    });

    test('rate limiting cuts off a single client', async () => {
        let limited = false;
        for (let i = 0; i < 60 && !limited; i++) {
            const res = await get('/api/v1/conferences', { 'x-forwarded-for': '203.0.113.9' });
            limited = res.statusCode === 429;
            if (limited) assert.deepEqual(res.json(), { error: { code: 'rate_limited', message: 'Too many requests' } });
        }
        assert.ok(limited, 'expected a 429 within 60 requests at a limit of 40/min');
    });
});
