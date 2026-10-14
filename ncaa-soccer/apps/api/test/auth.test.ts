/**
 * Signed-in routes: token verification, per-user isolation, favorites, preferences, admin
 * roles and maintenance requests.
 *
 * Tokens are signed with a throwaway RSA key in the shape Clerk issues (RS256, `iss`,
 * `sub`, `sid`, `azp`, `exp`, `nbf`, `iat`, `v`, `sts`) and verified by the same
 * `@clerk/backend` verifier production uses, given the matching public key as CLERK_JWT_KEY.
 * The app connects as the real least-privileged roles: ncadb_api for public data and
 * ncadb_accounts for user data, so the grants in migration 003 are exercised too.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'crypto';
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { signJwt } from '@clerk/backend/jwt';
import { createPool, loadSeason, refreshReadModels } from '@ncaa/database';
import { batch, freshDatabase, game, skipWithoutDb, stat, TEST_DATABASE_URL } from '../../../packages/database/test/helpers';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { MAX_FAVORITES } from '../src/routes/me';

const PASSWORD = 'test-only-password-not-a-secret-0123';
const ISSUER = 'https://clerk.example.test';
const SITE = 'https://satifyy.com';
const OPS_TOKEN = 'test-admin-token-0123456789abcdef';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER_PRIVATE_PEM = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function poolAs(role: string): Pool {
    const url = new URL(TEST_DATABASE_URL!);
    url.username = role;
    url.password = PASSWORD;
    return createPool({ connectionString: url.toString(), max: 3, applicationName: `ncadb-test-${role}` });
}

interface TokenOptions {
    sub?: string;
    claims?: Record<string, unknown>;
    key?: string;
    algorithm?: string;
}

async function token({ sub = 'user_alice', claims = {}, key = PRIVATE_PEM, algorithm = 'RS256' }: TokenOptions = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return signJwt(
        { iss: ISSUER, sub, sid: `sess_${sub}`, azp: SITE, iat: now - 5, nbf: now - 5, exp: now + 60, v: 2, sts: 'active', ...claims },
        key,
        { algorithm, header: { kid: 'ins_test' } }
    );
}

describe('signed-in routes', { skip: skipWithoutDb }, () => {
    let owner: Pool;
    let api: Pool;
    let accounts: Pool;
    let app: FastifyInstance;
    let alice: string;
    let bob: string;
    let playerId: number;

    before(async () => {
        owner = await freshDatabase();
        await loadSeason(owner, batch(2025, [game()], [stat('Ana Scorer', 'duke', { goals: 2 }), stat('Bo Keeper', 'duke')]));
        await refreshReadModels(owner);
        await owner.query(
            `INSERT INTO ingestion_runs (kind, trigger, status, started_at, finished_at, error)
             VALUES ('nightly', 'cron', 'failed', now() - interval '1 hour', now(), 'boom'),
                    ('nightly', 'cron', 'succeeded', now() - interval '2 hours', now() - interval '1 hour', NULL)`
        );
        for (const role of ['ncadb_api', 'ncadb_accounts']) await owner.query(`ALTER ROLE ${role} PASSWORD '${PASSWORD}'`);
        api = poolAs('ncadb_api');
        accounts = poolAs('ncadb_accounts');
        app = await buildApp(
            api,
            loadConfig({
                ADMIN_API_TOKEN: OPS_TOKEN,
                CORS_ALLOWED_ORIGINS: SITE,
                RATE_LIMIT_PER_MINUTE: '1000',
                CLERK_JWT_KEY: PUBLIC_PEM,
                CLERK_ISSUER: ISSUER,
                CLERK_AUTHORIZED_PARTIES: SITE
            }),
            { logger: false, accounts }
        );
        alice = await token({ sub: 'user_alice' });
        bob = await token({ sub: 'user_bob' });
        playerId = (await owner.query(`SELECT id::int FROM players WHERE name = 'Ana Scorer'`)).rows[0].id;
    });
    after(async () => {
        await app?.close();
        await Promise.all([api?.end(), accounts?.end(), owner?.end()]);
    });

    const call = (method: string, url: string, bearer?: string, payload?: unknown) =>
        app.inject({
            method: method as 'GET',
            url,
            headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
            ...(payload === undefined ? {} : { payload: payload as object })
        });

    test('public statistics stay available without signing in', async () => {
        assert.equal((await call('GET', '/api/v1/teams')).statusCode, 200);
        assert.equal((await call('GET', '/api/v1/players?season=2025')).statusCode, 200);
        assert.equal((await call('GET', '/api/v1/data-status')).statusCode, 200);
    });

    test('user routes refuse missing, malformed, forged, expired and misdirected tokens', async () => {
        const now = Math.floor(Date.now() / 1000);
        const bad: [string, string | undefined][] = [
            ['none', undefined],
            ['garbage', 'not-a-jwt'],
            ['ops token is not a session', OPS_TOKEN],
            ['signed by another key', await token({ key: OTHER_PRIVATE_PEM })],
            ['expired', await token({ claims: { exp: now - 30, iat: now - 120, nbf: now - 120 } })],
            ['not yet valid', await token({ claims: { nbf: now + 600, iat: now } })],
            ['other issuer', await token({ claims: { iss: 'https://evil.clerk.accounts.dev' } })],
            ['other site (azp)', await token({ claims: { azp: 'https://evil.example' } })],
            ['no azp', await token({ claims: { azp: undefined } })],
            ['no session id', await token({ claims: { sid: undefined } })],
            ['pending session', await token({ claims: { sts: 'pending' } })],
            ['subject with SQL in it', await token({ sub: "user_x'; DROP TABLE games; --" })],
            ['HS256 (alg confusion)', await token({ key: PUBLIC_PEM, algorithm: 'HS256' }).catch(() => 'eyJhbGciOiJIUzI1NiJ9.e30.x')]
        ];
        // alg "none"
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const body = Buffer.from(JSON.stringify({ iss: ISSUER, sub: 'user_alice', sid: 's', azp: SITE, exp: now + 60 })).toString('base64url');
        bad.push(['alg none', `${header}.${body}.`]);
        for (const [label, bearer] of bad) {
            const res = await call('GET', '/api/v1/me', bearer);
            assert.equal(res.statusCode, 401, label);
            assert.equal(res.json().error.code, 'unauthenticated', label);
            assert.equal(res.headers['cache-control'], 'no-store', label);
        }
        const profiles = await owner.query('SELECT count(*)::int AS n FROM accounts.user_profiles');
        assert.equal(profiles.rows[0].n, 0, 'no rejected token creates a profile');
    });

    test('a first signed-in request creates a plain user profile, audited', async () => {
        const res = await call('GET', '/api/v1/me', alice);
        assert.equal(res.statusCode, 200);
        const me = res.json().data;
        assert.equal(me.user_id, 'user_alice');
        assert.equal(me.role, 'user', 'nobody becomes admin by signing up, not even the first user');
        const { rows } = await owner.query(`SELECT action FROM accounts.user_activity_audit WHERE auth_subject = 'user_alice'`);
        assert.deepEqual(rows.map(r => r.action), ['account.created']);
    });

    test('a role claim in the token is ignored; the stored role decides', async () => {
        const forged = await token({ sub: 'user_alice', claims: { role: 'admin', metadata: { role: 'admin' }, org_role: 'admin' } });
        assert.equal((await call('GET', '/api/v1/me', forged)).json().data.role, 'user');
        assert.equal((await call('GET', '/api/v1/admin/runs', forged)).statusCode, 403);
    });

    test('profile and preferences update and validate', async () => {
        const res = await call('PATCH', '/api/v1/me', alice, { display_name: '  Alice  ' });
        assert.equal(res.json().data.display_name, 'Alice');
        assert.equal((await call('PATCH', '/api/v1/me', alice, { display_name: '<script>' })).statusCode, 400);
        // Unknown fields are stripped by the schema (removeAdditional), so this changes nothing.
        assert.equal((await call('PATCH', '/api/v1/me', alice, { role: 'admin' })).json().data.role, 'user');
        assert.equal((await call('GET', '/api/v1/me', alice)).json().data.role, 'user');

        const prefs = await call('PUT', '/api/v1/me/preferences', alice, { default_season: 2025, default_view: 'rankings', favorites_first: false });
        assert.equal(prefs.statusCode, 200);
        assert.deepEqual(prefs.json().data, { default_season: 2025, default_view: 'rankings', favorites_first: false });
        assert.equal((await call('PUT', '/api/v1/me/preferences', alice, { default_season: 1066 })).statusCode, 400);
    });

    test('favorite teams persist, are idempotent and cannot duplicate', async () => {
        assert.equal((await call('PUT', '/api/v1/me/favorites/teams/duke', alice)).statusCode, 201);
        assert.equal((await call('PUT', '/api/v1/me/favorites/teams/duke', alice)).statusCode, 200, 'second save is a no-op');
        assert.equal((await call('PUT', '/api/v1/me/favorites/teams/no-such-team', alice)).statusCode, 404);
        assert.equal((await call('PUT', `/api/v1/me/favorites/teams/${encodeURIComponent("duke' OR 1=1")}`, alice)).statusCode, 400);
        const list = (await call('GET', '/api/v1/me/favorites/teams', alice)).json().data;
        assert.deepEqual(list.map((t: { slug: string }) => t.slug), ['duke']);
        // The constraint, not just the API, refuses a duplicate.
        await assert.rejects(
            owner.query(
                `INSERT INTO accounts.user_favorite_teams (user_id, team_id)
                 SELECT user_id, team_id FROM accounts.user_favorite_teams LIMIT 1`
            ),
            (err: { code?: string }) => err.code === '23505'
        );
    });

    test('favorite players persist and cannot duplicate', async () => {
        assert.equal((await call('PUT', `/api/v1/me/favorites/players/${playerId}`, alice)).statusCode, 201);
        assert.equal((await call('PUT', `/api/v1/me/favorites/players/${playerId}`, alice)).statusCode, 200);
        assert.equal((await call('PUT', '/api/v1/me/favorites/players/999999', alice)).statusCode, 404);
        const list = (await call('GET', '/api/v1/me/favorites/players', alice)).json().data;
        // The same display name as the public player routes.
        const shown = (await call('GET', `/api/v1/players/${playerId}`)).json().data.name;
        assert.deepEqual(list.map((p: { name: string }) => p.name), [shown]);
        // A fresh token (as after a renewal) sees the same saved data.
        const renewed = await token({ sub: 'user_alice' });
        assert.equal((await call('GET', '/api/v1/me/favorites/players', renewed)).json().data.length, 1);
    });

    test('one user cannot see or change another user’s data', async () => {
        assert.equal((await call('GET', '/api/v1/me', bob)).json().data.user_id, 'user_bob');
        assert.deepEqual((await call('GET', '/api/v1/me/favorites/teams', bob)).json().data, []);
        assert.deepEqual((await call('GET', '/api/v1/me/favorites/players', bob)).json().data, []);
        // Bob deleting "Duke" removes nothing of Alice's.
        assert.equal((await call('DELETE', '/api/v1/me/favorites/teams/duke', bob)).statusCode, 204);
        assert.equal((await call('DELETE', `/api/v1/me/favorites/players/${playerId}`, bob)).statusCode, 204);
        assert.equal((await call('GET', '/api/v1/me/favorites/teams', alice)).json().data.length, 1);
        assert.equal((await call('GET', '/api/v1/me/favorites/players', alice)).json().data.length, 1);
        assert.equal((await call('GET', '/api/v1/me', alice)).json().data.display_name, 'Alice');
        // There is no route that takes a user id.
        assert.equal((await call('GET', '/api/v1/users/user_alice', bob)).statusCode, 404);
        assert.equal((await call('GET', '/api/v1/me?user_id=user_alice', bob)).json().data.user_id, 'user_bob');
    });

    test('favorites are bounded per user', async () => {
        const { rows } = await owner.query(`SELECT id FROM accounts.user_profiles WHERE auth_subject = 'user_bob'`);
        await owner.query(
            `INSERT INTO teams (sport_id, slug, name, is_division_one)
             SELECT 1, 'bulk-' || g, 'Bulk ' || g, false FROM generate_series(1, $1) g`,
            [MAX_FAVORITES]
        );
        await owner.query(
            `INSERT INTO accounts.user_favorite_teams (user_id, team_id) SELECT $1, id FROM teams WHERE slug LIKE 'bulk-%'`,
            [rows[0].id]
        );
        const res = await call('PUT', '/api/v1/me/favorites/teams/duke', bob);
        assert.equal(res.statusCode, 409);
        assert.equal(res.json().error.code, 'too_many_favorites');
    });

    test('admin routes: users are forbidden, administrators are allowed and audited', async () => {
        assert.equal((await call('GET', '/api/v1/admin/runs', alice)).statusCode, 403);
        assert.equal((await call('GET', '/api/v1/admin/errors', bob)).statusCode, 403);
        assert.equal((await call('GET', '/api/v1/admin/runs')).statusCode, 401);

        // The only way to become an admin: the owner changes the stored role.
        await owner.query(`UPDATE accounts.user_profiles SET role = 'admin' WHERE auth_subject = 'user_alice'`);
        const runs = await call('GET', '/api/v1/admin/runs', alice);
        assert.equal(runs.statusCode, 200);
        assert.equal(runs.json().pagination.total, 2);
        assert.equal((await call('GET', '/api/v1/admin/whoami', alice)).json().data.via, 'session');
        assert.equal((await call('GET', '/api/v1/admin/runs', bob)).statusCode, 403, 'still forbidden for others');
        // The operator token keeps working for scripts.
        assert.equal((await call('GET', '/api/v1/admin/runs', OPS_TOKEN)).statusCode, 200);

        const { rows } = await owner.query(
            `SELECT auth_subject, action FROM accounts.user_activity_audit WHERE action LIKE 'admin.%' ORDER BY id`
        );
        assert.ok(rows.some(r => r.auth_subject === 'user_bob' && r.action === 'admin.denied'));
        assert.ok(rows.some(r => r.auth_subject === 'user_alice' && r.action === 'admin.access'));
    });

    test('maintenance requests: admin only, explicit, validated, deduplicated and audited', async () => {
        const failed = (await owner.query(`SELECT id::int FROM ingestion_runs WHERE status = 'failed'`)).rows[0].id;
        const ok = (await owner.query(`SELECT id::int FROM ingestion_runs WHERE status = 'succeeded'`)).rows[0].id;
        const body = { action: 'retry_run', target_run_id: failed, reason: 'Box-score stage failed on a timeout', confirm: true };

        assert.equal((await call('POST', '/api/v1/admin/maintenance', bob, body)).statusCode, 403, 'users cannot');
        assert.equal((await call('POST', '/api/v1/admin/maintenance', OPS_TOKEN, body)).statusCode, 403, 'a request names a person');
        assert.equal((await call('POST', '/api/v1/admin/maintenance', alice, { ...body, confirm: false })).statusCode, 400);
        assert.equal((await call('POST', '/api/v1/admin/maintenance', alice, { ...body, reason: 'short' })).statusCode, 400);
        assert.equal((await call('POST', '/api/v1/admin/maintenance', alice, { ...body, target_run_id: ok })).statusCode, 409);
        assert.equal((await call('POST', '/api/v1/admin/maintenance', alice, body)).statusCode, 202);
        assert.equal((await call('POST', '/api/v1/admin/maintenance', alice, body)).statusCode, 409, 'one open request per target');

        const list = (await call('GET', '/api/v1/admin/maintenance', alice)).json();
        assert.equal(list.data.length, 1);
        assert.equal(list.data[0].requested_by, 'user_alice');
        assert.equal(list.data[0].status, 'pending');
        const audited = await owner.query(`SELECT detail FROM accounts.user_activity_audit WHERE action = 'admin.maintenance_requested'`);
        assert.equal(audited.rows[0].detail.target_run_id, failed);
    });

    test('deleting one’s profile removes their data and keeps the audit trail', async () => {
        assert.equal((await call('DELETE', '/api/v1/me', bob)).statusCode, 204);
        const left = await owner.query(`SELECT count(*)::int AS n FROM accounts.user_favorite_teams f
                                        JOIN accounts.user_profiles p ON p.id = f.user_id WHERE p.auth_subject = 'user_bob'`);
        assert.equal(left.rows[0].n, 0);
        const trail = await owner.query(`SELECT user_id, action FROM accounts.user_activity_audit WHERE auth_subject = 'user_bob' ORDER BY id`);
        assert.ok(trail.rows.some(r => r.action === 'account.deleted'));
        assert.ok(trail.rows.every(r => r.user_id === null), 'rows survive with the link removed');
        // Signing in again starts a fresh, plain profile.
        assert.equal((await call('GET', '/api/v1/me', bob)).json().data.role, 'user');
    });

    test('CORS lets the site send authenticated writes, and nobody else', async () => {
        const preflight = await app.inject({
            method: 'OPTIONS',
            url: '/api/v1/me/favorites/teams/duke',
            headers: { origin: SITE, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization' }
        });
        assert.equal(preflight.headers['access-control-allow-origin'], SITE);
        assert.match(String(preflight.headers['access-control-allow-methods']), /PUT/);
        assert.equal(preflight.headers['access-control-allow-credentials'], undefined, 'no cookie credentials');
        const evil = await app.inject({
            method: 'OPTIONS',
            url: '/api/v1/me',
            headers: { origin: 'https://evil.example', 'access-control-request-method': 'DELETE' }
        });
        assert.equal(evil.headers['access-control-allow-origin'], undefined);
    });
});

describe('signed-in routes without Clerk settings', { skip: skipWithoutDb }, () => {
    test('answer 503 rather than pretending, and admin falls back to the operator token', async () => {
        const pool = await freshDatabase();
        const app = await buildApp(pool, loadConfig({ ADMIN_API_TOKEN: OPS_TOKEN }), { logger: false });
        try {
            const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
            assert.equal(res.statusCode, 503);
            assert.equal(res.json().error.code, 'auth_unavailable');
            assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/me/favorites/teams/duke' })).statusCode, 503);
            const runs = await app.inject({ method: 'GET', url: '/api/v1/admin/runs', headers: { authorization: `Bearer ${OPS_TOKEN}` } });
            assert.equal(runs.statusCode, 200);
        } finally {
            await app.close();
            await pool.end();
        }
    });

    test('a half-configured verifier refuses to start', () => {
        assert.throws(() => loadConfig({ CLERK_JWT_KEY: PUBLIC_PEM, CLERK_AUTHORIZED_PARTIES: SITE }), /CLERK_ISSUER/);
        assert.throws(() => loadConfig({ CLERK_JWT_KEY: PUBLIC_PEM, CLERK_ISSUER: ISSUER }), /CLERK_AUTHORIZED_PARTIES/);
        assert.throws(
            () => loadConfig({ CLERK_JWT_KEY: PUBLIC_PEM, CLERK_ISSUER: 'http://insecure', CLERK_AUTHORIZED_PARTIES: SITE }),
            /CLERK_ISSUER/
        );
    });
});
