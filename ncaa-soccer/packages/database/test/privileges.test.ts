/**
 * The least-privileged roles, exercised by connecting as them.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createPool, loadSeason, MassDeletionError, refreshReadModels } from '../src';
import { batch, freshDatabase, game, skipWithoutDb, stat, TEST_DATABASE_URL } from './helpers';

const PASSWORD = 'test-only-password-not-a-secret-0123';

function poolAs(role: string): Pool {
    const url = new URL(TEST_DATABASE_URL!);
    url.username = role;
    url.password = PASSWORD;
    return createPool({ connectionString: url.toString(), max: 2, applicationName: `ncadb-test-${role}` });
}

describe('database privilege separation', { skip: skipWithoutDb }, () => {
    let owner: Pool;
    let api: Pool;
    let worker: Pool;

    before(async () => {
        owner = await freshDatabase();
        for (const role of ['ncadb_api', 'ncadb_worker']) {
            await owner.query(`ALTER ROLE ${role} PASSWORD '${PASSWORD}'`);
        }
        api = poolAs('ncadb_api');
        worker = poolAs('ncadb_worker');
    });
    after(async () => {
        await Promise.all([api?.end(), worker?.end(), owner?.end()]);
    });

    test('the worker can run a full season load and refresh the read models', async () => {
        const result = await loadSeason(worker, batch(2025, [game()], [stat('Ana Scorer', 'duke', { goals: 2 })]));
        assert.equal(result.games.inserted, 1);
        await refreshReadModels(worker);
    });

    test('the API role can read', async () => {
        const { rows } = await api.query('SELECT count(*)::int AS n FROM games');
        assert.equal(rows[0].n, 1);
        await api.query('SELECT name FROM schema_migrations LIMIT 1');
    });

    const denied = async (pool: Pool, sql: string) => {
        await assert.rejects(pool.query(sql), (err: { code?: string }) => {
            // 42501 insufficient_privilege, 25006 read_only_sql_transaction, 42809 wrong_object_type
            assert.ok(['42501', '25006', '42809'].includes(err.code ?? ''), `${sql} failed with ${err.code}`);
            return true;
        });
    };

    test('the API role cannot write, create or drop anything', async () => {
        await denied(api, `INSERT INTO conferences (sport_id, name) VALUES (1, 'x')`);
        await denied(api, `UPDATE games SET home_score = 9`);
        await denied(api, `DELETE FROM games`);
        await denied(api, `CREATE TABLE t (x int)`);
        await denied(api, `DROP TABLE games`);
        await denied(api, `SELECT ncadb_refresh_read_models()`);
        // The role's own default, which the API's pool does not override.
        const fresh = poolAs('ncadb_api');
        const { rows } = await fresh.query(`SHOW statement_timeout`);
        await fresh.end();
        assert.equal(rows[0].statement_timeout, '5s');
    });

    test('the worker cannot change the schema, the migration ledger, or reference data', async () => {
        await denied(worker, `CREATE TABLE t (x int)`);
        await denied(worker, `DROP TABLE games`);
        await denied(worker, `ALTER TABLE games ADD COLUMN x int`);
        await denied(worker, `TRUNCATE games`);
        await denied(worker, `DELETE FROM schema_migrations`);
        await denied(worker, `INSERT INTO sports (code, name) VALUES ('x', 'x')`);
        await denied(worker, `CREATE ROLE intruder`);
    });

    test('a whole-season load that would erase most of a season is refused and rolled back', async () => {
        // Sixty distinct fixtures: Duke v Indiana on sixty different days.
        const unique = Array.from({ length: 60 }, (_, i) =>
            game({
                dedupeKey: `k-${i}`,
                sourceGameId: `g-${i}`,
                date: new Date(Date.UTC(2024, 7, 1 + i)).toISOString().slice(0, 10),
                awaySlug: 'indiana',
                awayName: 'Indiana'
            })
        );
        await loadSeason(worker, batch(2024, unique, []));
        const before = await owner.query(`SELECT count(*)::int AS n FROM game_sources gs JOIN seasons s ON s.id = gs.season_id WHERE s.year = 2024`);

        // A "complete" batch holding a handful of rows: a truncated file, a broken scrape.
        await assert.rejects(loadSeason(worker, batch(2024, unique.slice(0, 3), [])), MassDeletionError);
        const afterRefusal = await owner.query(`SELECT count(*)::int AS n FROM game_sources gs JOIN seasons s ON s.id = gs.season_id WHERE s.year = 2024`);
        assert.equal(afterRefusal.rows[0].n, before.rows[0].n, 'nothing was deleted');

        // The explicit override is what a deliberate rebuild uses.
        await loadSeason(worker, { ...batch(2024, unique.slice(0, 3), []), allowMassDelete: true });
        const afterOverride = await owner.query(`SELECT count(*)::int AS n FROM game_sources gs JOIN seasons s ON s.id = gs.season_id WHERE s.year = 2024`);
        assert.equal(afterOverride.rows[0].n, 3);
    });
});
