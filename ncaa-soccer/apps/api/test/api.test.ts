import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadSeason, refreshReadModels, saveArtifacts } from '@ncaa/database';
import { batch, freshDatabase, game, skipWithoutDb, stat } from '../../../packages/database/test/helpers';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

const TOKEN = 'test-admin-token-0123456789abcdef';

describe('API', { skip: skipWithoutDb }, () => {
    let pool: Pool;
    let app: FastifyInstance;

    before(async () => {
        pool = await freshDatabase();
        await loadSeason(
            pool,
            batch(2025, [game()], [
                stat('Ana Scorer', 'duke', { goals: 2, assists: 1 }),
                stat('Bo Keeper', 'duke', { saves: 4, jerseyNumber: '1', minutes: null }),
                stat('Cy Striker', 'clemson', { goals: 1 })
            ])
        );
        await refreshReadModels(pool);
        await saveArtifacts(pool, null, [{ key: 'analytics/index.json', content: '{"seasons":["2025"]}' }]);
        app = await buildApp(
            pool,
            loadConfig({ ADMIN_API_TOKEN: TOKEN, CORS_ALLOWED_ORIGINS: 'https://ncadb.vercel.app,https://ncadb-*.vercel.app' }),
            { logger: false }
        );
    });
    after(async () => {
        await app?.close();
        await pool?.end();
    });

    const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

    test('health reports the database', async () => {
        const res = await get('/health');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json(), { ok: true, database: 'up' });
    });

    test('teams list with season records, by slug or id', async () => {
        const res = await get('/api/v1/teams?search=duk');
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.data.length, 1);
        assert.deepEqual([body.data[0].slug, body.data[0].wins, body.data[0].losses], ['duke', 1, 0]);
        const bySlug = (await get('/api/v1/teams/duke')).json();
        const byId = (await get(`/api/v1/teams/${bySlug.data.id}`)).json();
        assert.equal(byId.data.slug, 'duke');
        assert.equal(bySlug.data.seasons[0].season, 2025);
    });

    test('team games carry the result from the team’s side', async () => {
        const res = (await get('/api/v1/teams/clemson/games?season=2025')).json();
        assert.deepEqual(
            [res.data[0].opponent_slug, res.data[0].team_score, res.data[0].opponent_score, res.data[0].result, res.data[0].venue],
            ['duke', 1, 2, 'L', 'away']
        );
    });

    test('roster and leaderboard come from persisted box scores, NULLs intact', async () => {
        const roster = (await get('/api/v1/teams/duke/players?season=2025')).json();
        const bo = roster.data.find((p: { name: string }) => p.name === 'Bo Keeper');
        assert.equal(bo.minutes, null);
        assert.equal(bo.saves, 4);
        const leaders = (await get('/api/v1/players?season=2025&sort=-goals')).json();
        assert.equal(leaders.data[0].name, 'Ana Scorer');
        assert.equal(leaders.data[0].points, 3);
        assert.equal(typeof leaders.data[0].id, 'number');
    });

    test('box score has both sides and the reconciliation', async () => {
        const list = (await get('/api/v1/games?season=2025')).json();
        assert.equal(list.pagination.total, 1);
        const box = (await get(`/api/v1/games/${list.data[0].id}/boxscore`)).json().data;
        assert.equal(box.home.team_slug, 'duke');
        assert.equal(box.home.players.length, 2);
        assert.equal(box.home.totals.goals_reconciliation, 'ok');
        assert.equal(box.away.players.length, 1);
    });

    test('player profile and game log', async () => {
        const leaders = (await get('/api/v1/players?season=2025&search=ana')).json();
        const id = leaders.data[0].id;
        const profile = (await get(`/api/v1/players/${id}`)).json().data;
        assert.equal(profile.career.goals, 2);
        const log = (await get(`/api/v1/players/${id}/games`)).json();
        assert.equal(log.data[0].result, 'W');
    });

    test('inputs are validated, and errors have stable shapes without internals', async () => {
        assert.equal((await get('/api/v1/games?date_from=2025-13-01')).statusCode, 400);
        assert.equal((await get('/api/v1/players?sort=password')).statusCode, 400);
        assert.equal((await get('/api/v1/games?page_size=1000')).statusCode, 400);
        assert.equal((await get("/api/v1/teams/duke';drop")).statusCode, 400);
        const missing = await get('/api/v1/games/999999');
        assert.equal(missing.statusCode, 404);
        assert.deepEqual(missing.json(), { error: { code: 'not_found', message: 'Game not found' } });
    });

    test('data status reports freshness and coverage', async () => {
        const body = (await get('/api/v1/data-status')).json();
        assert.equal(body.coverage[0].season, 2025);
        assert.equal(body.coverage[0].boxscore_complete, 1);
    });

    test('artifacts are served with an ETag and honour If-None-Match', async () => {
        const first = await get('/api/v1/artifacts/analytics/index.json');
        assert.equal(first.statusCode, 200);
        assert.deepEqual(first.json(), { seasons: ['2025'] });
        const again = await get('/api/v1/artifacts/analytics/index.json', { 'if-none-match': String(first.headers.etag) });
        assert.equal(again.statusCode, 304);
        assert.equal((await get('/api/v1/artifacts/../secret.json')).statusCode, 404);
    });

    test('admin routes require the token', async () => {
        assert.equal((await get('/api/v1/admin/runs')).statusCode, 401);
        assert.equal((await get('/api/v1/admin/runs', { authorization: 'Bearer wrong' })).statusCode, 401);
        assert.equal((await get('/api/v1/admin/runs', { authorization: `Bearer ${TOKEN}` })).statusCode, 200);
    });

    test('CORS allows configured origins and preview patterns only', async () => {
        const ok = await get('/api/v1/seasons', { origin: 'https://ncadb-git-main-me.vercel.app' });
        assert.equal(ok.headers['access-control-allow-origin'], 'https://ncadb-git-main-me.vercel.app');
        const no = await get('/api/v1/seasons', { origin: 'https://evil.example' });
        assert.equal(no.headers['access-control-allow-origin'], undefined);
    });

    test('OpenAPI document lists the public routes', async () => {
        const doc = (await get('/api/v1/openapi.json')).json();
        for (const route of ['/api/v1/teams', '/api/v1/games/{id}/boxscore', '/api/v1/players/{id}/games', '/api/v1/data-status']) {
            assert.ok(doc.paths[route], `missing ${route}`);
        }
    });
});
