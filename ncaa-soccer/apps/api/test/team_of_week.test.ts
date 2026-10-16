import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { computeTeamOfWeek, loadSeason } from '@ncaa/database';
import type { PlayerStatRecord } from '@ncaa/database';
import { batch, freshDatabase, game, skipWithoutDb, stat } from '../../../packages/database/test/helpers';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

/** The fixture holds one game; production needs twenty before a week gets an XI. */
const ONE_GAME = { minCapturedGames: 1, firstSeason: 2025 };

const v2 = (name: string, team: string, group: 'GK' | 'DEF' | 'MID' | 'FWD', extra: Partial<PlayerStatRecord> = {}) =>
    stat(name, team, { position: group, positionGroup: group, started: true, captureVersion: 2, saves: null, ...extra });

describe('Team of the Week API', { skip: skipWithoutDb }, () => {
    let pool: Pool;
    let app: FastifyInstance;

    before(async () => {
        pool = await freshDatabase();
        // Duke 2-1 Clemson, Friday 2025-09-05 (week of Monday 2025-09-01).
        await loadSeason(pool, batch(2025, [game()], [
            v2('Kat Keeper', 'duke', 'GK', { jerseyNumber: '1', saves: 4, goalsAllowed: 1 }),
            v2('Dan Back', 'duke', 'DEF', { jerseyNumber: '4' }),
            v2('Mo Mid', 'duke', 'MID', { jerseyNumber: '8', assists: 1 }),
            v2('Fay Forward', 'duke', 'FWD', { jerseyNumber: '9', goals: 2, shotsOnGoal: 3 }),
            v2('Cal Keeper', 'clemson', 'GK', { jerseyNumber: '1', saves: 2 }),
            v2('Cy Striker', 'clemson', 'FWD', { jerseyNumber: '9', goals: 1 }),
            v2('Ed Bench', 'clemson', 'FWD', { jerseyNumber: '19', minutes: 20 })
        ]));
        await computeTeamOfWeek(pool, 2025, new Date('2025-09-20T12:00:00Z'), ONE_GAME);
        app = await buildApp(pool, loadConfig({ ADMIN_API_TOKEN: 'test-admin-token-0123456789abcdef' }), { logger: false });
    });
    after(async () => {
        await app?.close();
        await pool?.end();
    });

    const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

    test('the latest week: eleven slots in 4-3-3 order, an honest partial XI, public and cacheable', async () => {
        const res = await get('/api/v1/team-of-week');
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers['cache-control']), /public/);
        const body = res.json();
        assert.equal(body.formation, '4-3-3');
        assert.equal(body.xi.length, 11);
        assert.deepEqual(body.xi.map((s: any) => s.position_group), ['GK', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD']);
        assert.equal(body.filled, 5);
        assert.deepEqual(
            body.xi.filter((s: any) => s.player).map((s: any) => s.player.name),
            ['Kat Keeper', 'Dan Back', 'Mo Mid', 'Fay Forward', 'Cy Striker']
        );
        assert.deepEqual([body.week.start, body.week.end, body.week.status, body.week.season], ['2025-09-01', '2025-09-07', 'final', 2025]);
        assert.equal(body.model.version, 'totw-1');
        assert.ok(body.model.weights.goal.DEF);
        assert.equal(body.best.GK.name, 'Kat Keeper');
        assert.deepEqual(body.honorable_mentions.GK.map((p: any) => p.name), ['Cal Keeper']);
        const fay = body.best.FWD;
        assert.deepEqual([fay.team.slug, fay.games, fay.game_log[0].goals, fay.game_log[0].opponent], ['duke', 1, 2, 'Clemson']);
        assert.ok(fay.rating >= 0 && fay.rating <= 10);
        assert.match(fay.explanation, /2 goals/);
        const benched = body.xi.some((s: any) => s.player?.name === 'Ed Bench');
        assert.equal(benched, false, 'twenty minutes is not a rated game');
    });

    test('an inferred goals-allowed figure is labelled as such', async () => {
        const body = (await get('/api/v1/team-of-week')).json();
        const cal = body.honorable_mentions.GK[0];
        assert.equal(cal.game_log[0].goals_allowed_source, 'inferred');
        assert.ok(cal.missing.includes('goals_allowed_official'));
        assert.equal(body.best.GK.game_log[0].goals_allowed_source, 'official');
    });

    test('any date finds its Monday-Sunday week; a week with no data is a 404', async () => {
        assert.equal((await get('/api/v1/team-of-week/2025-09-07')).json().week.start, '2025-09-01');
        assert.equal((await get('/api/v1/team-of-week/2025-09-01')).json().week.start, '2025-09-01');
        assert.equal((await get('/api/v1/team-of-week/2025-09-08')).statusCode, 404);
        assert.equal((await get('/api/v1/team-of-week/2025-13-40')).statusCode, 400);
        assert.equal((await get('/api/v1/team-of-week/latest')).statusCode, 400);
    });

    test('weeks are listed for navigation; filters are validated', async () => {
        const weeks = (await get('/api/v1/team-of-week/weeks?season=2025')).json().data;
        assert.deepEqual(weeks.map((w: any) => [w.start, w.status, w.filled]), [['2025-09-01', 'final', 5]]);
        assert.deepEqual((await get('/api/v1/team-of-week/weeks?season=2024')).json().data, []);
        assert.equal((await get('/api/v1/team-of-week?competition=ncaa-d2-wsoc')).statusCode, 400);
        assert.equal((await get('/api/v1/team-of-week?season=2024')).statusCode, 404);
    });

    test('an unchanged week answers a conditional request with 304', async () => {
        const first = await get('/api/v1/team-of-week');
        const etag = String(first.headers.etag);
        assert.ok(etag.startsWith('"totw-'));
        assert.equal((await get('/api/v1/team-of-week', { 'if-none-match': etag })).statusCode, 304);
    });

    test('the API cannot be used to write', async () => {
        for (const method of ['POST', 'PUT', 'DELETE'] as const) {
            const res = await app.inject({ method, url: '/api/v1/team-of-week' });
            assert.ok([404, 405].includes(res.statusCode), `${method} -> ${res.statusCode}`);
        }
    });
});
