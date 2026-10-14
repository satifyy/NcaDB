/**
 * User accounts in the database: the upgrade path production will take, the permission
 * boundaries between the three application roles, and the worker's handling of admin
 * maintenance requests. Every boundary is checked by connecting as the role itself.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Pool } from 'pg';
import { createPool, loadSeason, migrate, MIGRATIONS_DIR } from '../src';
import { processMaintenanceRequests } from '../../../apps/worker/src/maintenance';
import { changeRole, parseAdminSubjects, RoleError, syncAdmins } from '../../../apps/worker/src/roles';
import { batch, count, game, skipWithoutDb, stat, TEST_DATABASE_URL } from './helpers';

const PASSWORD = 'test-only-password-not-a-secret-0123';

function poolAs(role: string): Pool {
    const url = new URL(TEST_DATABASE_URL!);
    url.username = role;
    url.password = PASSWORD;
    return createPool({ connectionString: url.toString(), max: 2, applicationName: `ncadb-test-${role}` });
}

const denied = async (pool: Pool, sql: string, params: unknown[] = []) => {
    await assert.rejects(pool.query(sql, params), (err: { code?: string }) => {
        // 42501 insufficient_privilege, 25006 read_only_sql_transaction
        assert.ok(['42501', '25006'].includes(err.code ?? ''), `${sql} failed with ${err.code}`);
        return true;
    });
};

describe('user accounts in the database', { skip: skipWithoutDb }, () => {
    let owner: Pool;
    let api: Pool;
    let worker: Pool;
    let accounts: Pool;

    before(async () => {
        owner = createPool({ connectionString: TEST_DATABASE_URL, max: 4, applicationName: 'ncadb-test' });
        await owner.query('DROP SCHEMA IF EXISTS accounts CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    });
    after(async () => {
        await Promise.all([api?.end(), worker?.end(), accounts?.end(), owner?.end()]);
    });

    test('003 and 004 apply on top of a populated 002 database, as production will, and keep its data', async () => {
        // Production today: 001 and 002 applied, a season loaded.
        const old = fs.mkdtempSync(path.join(os.tmpdir(), 'ncadb-mig-'));
        for (const f of ['001_initial_schema.sql', '002_least_privilege_roles.sql']) {
            fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(old, f));
        }
        await migrate(owner, old);
        fs.rmSync(old, { recursive: true, force: true });
        await loadSeason(owner, batch(2025, [game()], [stat('Ana Scorer', 'duke', { goals: 2 })]));
        const before = { games: await count(owner, 'games'), stats: await count(owner, 'player_game_stats') };

        const result = await migrate(owner);
        assert.deepEqual(result.applied, ['003_user_accounts.sql', '004_maintenance_requests.sql']);
        assert.deepEqual(
            { games: await count(owner, 'games'), stats: await count(owner, 'player_game_stats') },
            before,
            'sports data untouched'
        );
        // A re-run is a no-op.
        assert.deepEqual((await migrate(owner)).applied, []);

        for (const role of ['ncadb_api', 'ncadb_worker', 'ncadb_accounts']) await owner.query(`ALTER ROLE ${role} PASSWORD '${PASSWORD}'`);
        api = poolAs('ncadb_api');
        worker = poolAs('ncadb_worker');
        accounts = poolAs('ncadb_accounts');
    });

    test('no application role is a superuser or can create roles, databases or bypass RLS', async () => {
        const { rows } = await owner.query(
            `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
             FROM pg_roles WHERE rolname IN ('ncadb_api', 'ncadb_worker', 'ncadb_accounts') ORDER BY 1`
        );
        assert.equal(rows.length, 3);
        for (const r of rows) {
            assert.deepEqual(
                [r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls],
                [false, false, false, false, false],
                r.rolname
            );
        }
    });

    test('the public API and the worker cannot see user data at all', async () => {
        for (const pool of [api, worker]) {
            await denied(pool, 'SELECT * FROM accounts.user_profiles');
            await denied(pool, 'SELECT * FROM accounts.user_favorite_teams');
            await denied(pool, 'SELECT * FROM accounts.user_activity_audit');
            await denied(pool, `INSERT INTO accounts.user_profiles (auth_subject) VALUES ('user_x')`);
            await denied(pool, `UPDATE accounts.user_profiles SET role = 'admin'`);
        }
    });

    test('the public API stays read-only, including the new maintenance table', async () => {
        await api.query('SELECT count(*) FROM maintenance_requests');
        await denied(api, `INSERT INTO maintenance_requests (action, reason, requested_by) VALUES ('rebuild_analytics', 'xxxxxxxxxxxx', 'user_x')`);
    });

    test('the accounts identity manages profiles but cannot grant roles, touch the audit trail or the sports data', async () => {
        const { rows } = await accounts.query(
            `INSERT INTO accounts.user_profiles (auth_provider, auth_subject) VALUES ('clerk', 'user_alice') RETURNING id::int, role`
        );
        assert.equal(rows[0].role, 'user');
        const id = rows[0].id;
        await accounts.query(`UPDATE accounts.user_profiles SET display_name = 'Alice', last_seen_at = now() WHERE id = $1`, [id]);
        await accounts.query(`INSERT INTO accounts.user_activity_audit (user_id, auth_subject, action) VALUES ($1, 'user_alice', 'test.event')`, [id]);

        // Privilege escalation is refused by the database, not just the API.
        await denied(accounts, `UPDATE accounts.user_profiles SET role = 'admin' WHERE id = $1`, [id]);
        await denied(accounts, `INSERT INTO accounts.user_profiles (auth_subject, role) VALUES ('user_eve', 'admin')`);
        // The audit trail is append-only to it.
        await denied(accounts, 'SELECT * FROM accounts.user_activity_audit');
        await denied(accounts, 'UPDATE accounts.user_activity_audit SET action = $1', ['x.y']);
        await denied(accounts, 'DELETE FROM accounts.user_activity_audit');
        await denied(accounts, `INSERT INTO accounts.user_activity_audit (action, actor) VALUES ('role.changed', 'forged')`);
        // Sports data: read the two referenced tables, write nothing.
        await accounts.query('SELECT id FROM teams LIMIT 1');
        await accounts.query('SELECT id FROM players LIMIT 1');
        await denied(accounts, `UPDATE teams SET name = 'x'`);
        await denied(accounts, 'DELETE FROM games');
        await denied(accounts, 'SELECT * FROM games');
        await denied(accounts, 'SELECT error FROM ingestion_runs');
        await denied(accounts, `UPDATE maintenance_requests SET status = 'succeeded'`);
        // No DDL anywhere.
        await denied(accounts, 'CREATE TABLE accounts.x (y int)');
        await denied(accounts, 'DROP TABLE accounts.user_profiles');
        await denied(accounts, 'ALTER TABLE accounts.user_profiles ADD COLUMN x int');
        await denied(accounts, 'TRUNCATE accounts.user_favorite_teams');
    });

    test('duplicate favorites are refused by the schema', async () => {
        const user = (await owner.query(`SELECT id FROM accounts.user_profiles WHERE auth_subject = 'user_alice'`)).rows[0].id;
        const team = (await owner.query(`SELECT id FROM teams WHERE slug = 'duke'`)).rows[0].id;
        const player = (await owner.query(`SELECT id FROM players LIMIT 1`)).rows[0].id;
        await accounts.query('INSERT INTO accounts.user_favorite_teams (user_id, team_id) VALUES ($1, $2)', [user, team]);
        await accounts.query('INSERT INTO accounts.user_favorite_players (user_id, player_id) VALUES ($1, $2)', [user, player]);
        for (const [table, col, value] of [
            ['user_favorite_teams', 'team_id', team],
            ['user_favorite_players', 'player_id', player]
        ]) {
            await assert.rejects(
                accounts.query(`INSERT INTO accounts.${table} (user_id, ${col}) VALUES ($1, $2)`, [user, value]),
                (err: { code?: string }) => err.code === '23505'
            );
        }
        await assert.rejects(
            owner.query(`INSERT INTO accounts.user_profiles (auth_provider, auth_subject) VALUES ('clerk', 'user_alice')`),
            (err: { code?: string }) => err.code === '23505',
            'one profile per provider identity'
        );
    });

    test('administrators change only through the audited owner path, and sync-admins converges', async () => {
        await owner.query(`INSERT INTO accounts.user_profiles (auth_subject) VALUES ('user_bob'), ('user_carol')`);
        await assert.rejects(changeRole(owner, { subject: 'user_nobody', role: 'admin', reason: 'should fail here', actor: 't' }), RoleError);
        await assert.rejects(changeRole(owner, { subject: 'user_bob', role: 'admin', reason: 'short', actor: 't' }), RoleError);
        await changeRole(owner, { subject: 'user_bob', role: 'admin', reason: 'on-call this month', actor: 'ops' });

        // The list on the migrate service: Alice and Carol, plus Dave who has not signed in.
        assert.deepEqual(parseAdminSubjects(' user_alice, user_carol user_dave ,'), ['user_alice', 'user_carol', 'user_dave']);
        assert.equal(parseAdminSubjects(undefined), undefined, 'unset means "leave alone", never "demote all"');
        const result = await syncAdmins(owner, ['user_alice', 'user_carol', 'user_dave'], 'quarterly access review', 'migrate:dep_1');
        assert.deepEqual(result, { promoted: ['user_alice', 'user_carol'], demoted: ['user_bob'], pending: ['user_dave'] });
        const again = await syncAdmins(owner, ['user_alice', 'user_carol', 'user_dave'], 'quarterly access review', 'migrate:dep_2');
        assert.deepEqual(again, { promoted: [], demoted: [], pending: ['user_dave'] }, 'idempotent');

        const { rows } = await owner.query(
            `SELECT auth_subject, detail->>'from' AS f, detail->>'to' AS t, actor FROM accounts.user_activity_audit
             WHERE action = 'role.changed' ORDER BY id`
        );
        assert.deepEqual(
            rows.map(r => `${r.auth_subject} ${r.f}->${r.t} by ${r.actor}`),
            [
                'user_bob user->admin by ops',
                'user_bob admin->user by migrate:dep_1',
                'user_alice user->admin by migrate:dep_1',
                'user_carol user->admin by migrate:dep_1'
            ]
        );
        // And the API identity still cannot do any of this itself.
        await denied(accounts, `UPDATE accounts.user_profiles SET role = 'admin' WHERE auth_subject = 'user_bob'`);
    });

    test('the worker carries out maintenance requests, re-validating each, and records the outcome', async () => {
        const runs = await owner.query(
            `INSERT INTO ingestion_runs (kind, trigger, status, started_at, finished_at)
             VALUES ('nightly', 'cron', 'failed', now(), now()), ('nightly', 'cron', 'succeeded', now(), now())
             RETURNING id::int`
        );
        const [failed, succeeded] = runs.rows.map(r => r.id);
        await accounts.query(
            `INSERT INTO maintenance_requests (action, target_run_id, reason, requested_by) VALUES
                ('retry_run', $1, 'retry the failed nightly', 'user_alice'),
                ('retry_run', $2, 'this one already succeeded', 'user_alice'),
                ('rebuild_analytics', NULL, 'rebuild after a fix', 'user_alice')`,
            [failed, succeeded]
        );
        const calls: string[] = [];
        const processed = await processMaintenanceRequests(worker, {
            retryRun: async (runId, trigger) => {
                calls.push(`retry ${runId} ${trigger}`);
                return 0;
            },
            rebuildAnalytics: async () => {
                calls.push('analytics');
                return 1;
            }
        });
        assert.equal(processed, 3);
        assert.equal(calls.length, 2, 'the succeeded run is not retried');
        const { rows } = await owner.query(`SELECT action, target_run_id::int, status FROM maintenance_requests ORDER BY id`);
        assert.deepEqual(
            rows.map(r => r.status),
            ['succeeded', 'rejected', 'failed']
        );
        // Nothing left to do on a second pass.
        assert.equal(await processMaintenanceRequests(worker, { retryRun: async () => 0, rebuildAnalytics: async () => 0 }), 0);
    });
});
