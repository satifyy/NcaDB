/**
 * Team of the Week persistence: computed as the worker role, read as the API role.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createPool, computeTeamOfWeek, loadSeason, MODEL_VERSION } from '../src';
import type { PlayerStatRecord } from '../src';
import { batch, freshDatabase, game, skipWithoutDb, stat, TEST_DATABASE_URL } from './helpers';

/** The fixtures hold one game; production needs twenty before a week gets an XI. */
const ONE_GAME = { minCapturedGames: 1 };
const PASSWORD = 'test-only-password-not-a-secret-0123';
const poolAs = (role: string) => {
    const url = new URL(TEST_DATABASE_URL!);
    url.username = role;
    url.password = PASSWORD;
    return createPool({ connectionString: url.toString(), max: 2, applicationName: `ncadb-test-${role}` });
};

/** Duke 2-1 Clemson on Friday 2025-09-05: a captured box score with every group present. */
function boxScore(overrides: Record<string, Partial<PlayerStatRecord>> = {}): PlayerStatRecord[] {
    const v2 = (name: string, team: string, group: 'GK' | 'DEF' | 'MID' | 'FWD', extra: Partial<PlayerStatRecord> = {}) =>
        stat(name, team, { position: group.toLowerCase(), positionGroup: group, started: true, captureVersion: 2, saves: null, ...extra, ...overrides[name] });
    return [
        v2('Kat Keeper', 'duke', 'GK', { jerseyNumber: '1', saves: 4, goalsAllowed: 1 }),
        v2('Dan Back', 'duke', 'DEF', { jerseyNumber: '4' }),
        v2('Mo Mid', 'duke', 'MID', { jerseyNumber: '8', assists: 1 }),
        v2('Fay Forward', 'duke', 'FWD', { jerseyNumber: '9', goals: 2, shotsOnGoal: 3 }),
        v2('Cal Keeper', 'clemson', 'GK', { jerseyNumber: '1', saves: 2, goalsAllowed: null }),
        v2('Cy Striker', 'clemson', 'FWD', { jerseyNumber: '9', goals: 1 }),
        // A version-1 row is not evidence about position, so it is never ranked.
        stat('Old Row', 'clemson', { jerseyNumber: '7', goals: 3 })
    ];
}

describe('team of the week store', { skip: skipWithoutDb }, () => {
    let owner: Pool;
    let worker: Pool;
    let api: Pool;
    const final = new Date('2025-09-20T12:00:00Z');

    before(async () => {
        owner = await freshDatabase();
        for (const role of ['ncadb_api', 'ncadb_worker']) await owner.query(`ALTER ROLE ${role} PASSWORD '${PASSWORD}'`);
        worker = poolAs('ncadb_worker');
        api = poolAs('ncadb_api');
        await loadSeason(worker, batch(2025, [game()], boxScore()));
    });
    after(async () => {
        await Promise.all([api?.end(), worker?.end(), owner?.end()]);
    });

    const selections = async () =>
        (await owner.query(
            `SELECT s.slot, s.position_group, p.display_name AS name FROM totw_selections s
             LEFT JOIN players p ON p.id = s.player_id ORDER BY s.slot`
        )).rows;

    test('the worker computes a week: eleven slots, filled where players qualify, empty where not', async () => {
        const result = await computeTeamOfWeek(worker, 2025, final, ONE_GAME);
        assert.deepEqual(result, { season: 2025, weeks: 1, computed: 1, unchanged: 0 });
        const xi = await selections();
        assert.equal(xi.length, 11);
        assert.deepEqual(xi.filter(s => s.name).map(s => [s.position_group, s.name]), [
            ['GK', 'Kat Keeper'], ['DEF', 'Dan Back'], ['MID', 'Mo Mid'], ['FWD', 'Fay Forward'], ['FWD', 'Cy Striker']
        ]);
        const { rows: [week] } = await owner.query('SELECT week_start::text, week_end::text, status, revision, model_version, completeness FROM totw_weeks');
        assert.deepEqual([week.week_start, week.week_end, week.status, week.revision, week.model_version],
            ['2025-09-01', '2025-09-07', 'final', 0, MODEL_VERSION]);
        assert.equal(week.completeness.final_games, 1);
        assert.equal(week.completeness.games_captured, 1);
        const { rows: names } = await owner.query(
            `SELECT p.display_name FROM totw_player_weeks w JOIN players p ON p.id = w.player_id WHERE p.display_name = 'Old Row'`);
        assert.equal(names.length, 0, 'a version-1 row is not ranked');
    });

    test('the losing keeper’s goals allowed are inferred from the score, and labelled so', async () => {
        const { rows: [cal] } = await owner.query(
            `SELECT w.detail, w.missing, w.explanation FROM totw_player_weeks w JOIN players p ON p.id = w.player_id
             WHERE p.display_name = 'Cal Keeper'`);
        assert.equal(cal.detail[0].goalsAllowedSource, 'inferred');
        assert.equal(cal.detail[0].goalsAllowed, 2);
        assert.deepEqual(cal.missing, ['goals_allowed_official']);
        assert.match(cal.explanation, /from the score/);
    });

    test('running again with nothing changed writes nothing', async () => {
        const before = (await owner.query('SELECT computed_at FROM totw_weeks')).rows[0].computed_at;
        const result = await computeTeamOfWeek(worker, 2025, final, ONE_GAME);
        assert.deepEqual([result.computed, result.unchanged], [0, 1]);
        assert.deepEqual((await owner.query('SELECT computed_at FROM totw_weeks')).rows[0].computed_at, before);
    });

    test('a corrected box score recomputes its week and raises the revision', async () => {
        await loadSeason(worker, batch(2025, [game()], boxScore({ 'Cy Striker': { goals: 0 }, 'Mo Mid': { goals: 3 } })));
        const result = await computeTeamOfWeek(worker, 2025, final, ONE_GAME);
        assert.equal(result.computed, 1);
        const { rows: [week] } = await owner.query('SELECT revision FROM totw_weeks');
        assert.equal(week.revision, 1);
        const { rows: [mid] } = await owner.query(
            `SELECT w.detail->0->>'goals' AS goals FROM totw_player_weeks w JOIN players p ON p.id = w.player_id WHERE p.display_name = 'Mo Mid'`);
        assert.equal(mid.goals, '3');
    });

    test('a week inside the correction window is provisional, and the status change alone is recorded', async () => {
        await owner.query('DELETE FROM totw_weeks');
        await computeTeamOfWeek(worker, 2025, new Date('2025-09-10T12:00:00Z'), ONE_GAME);
        assert.equal((await owner.query('SELECT status FROM totw_weeks')).rows[0].status, 'provisional');
        const later = await computeTeamOfWeek(worker, 2025, final, ONE_GAME);
        assert.equal(later.computed, 1);
        const { rows: [week] } = await owner.query('SELECT status, revision FROM totw_weeks');
        assert.deepEqual([week.status, week.revision], ['final', 0], 'a status change is not a revision');
    });

    test('a week with too few captured games is stored without an XI, and says why', async () => {
        await computeTeamOfWeek(worker, 2025, final);
        const { rows: [week] } = await owner.query('SELECT completeness FROM totw_weeks');
        assert.deepEqual([week.completeness.published, week.completeness.reason], [false, 'too_few_games']);
        const { rows: [n] } = await owner.query('SELECT count(player_id)::int AS filled FROM totw_selections');
        assert.equal(n.filled, 0);
        await computeTeamOfWeek(worker, 2025, final, ONE_GAME);
    });

    test('the API role can read the tables and cannot write them', async () => {
        const { rows } = await api.query('SELECT count(*)::int AS n FROM totw_selections');
        assert.equal(rows[0].n, 11);
        for (const sql of ['DELETE FROM totw_selections', 'UPDATE totw_weeks SET status = \'final\'',
            "INSERT INTO totw_model_versions (version, weights, rules) VALUES ('x', '{}', '{}')"]) {
            await assert.rejects(api.query(sql), (err: { code?: string }) => ['42501', '25006'].includes(err.code ?? ''));
        }
    });
});
