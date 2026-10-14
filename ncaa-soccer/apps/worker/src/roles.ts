/**
 * Account roles. The only code that makes anyone an administrator.
 *
 * Runs with owner credentials: the API's database identity (ncadb_accounts) has no UPDATE
 * on `role`, and nothing promotes the first user to sign up. Every change is written to
 * accounts.user_activity_audit, with who made it and why, in the same transaction.
 *
 * Two ways to use it:
 *   set-role     one change, by hand (local, or break-glass).
 *   sync-admins  on every migrate deploy: makes the administrators exactly the subjects in
 *                NCADB_ADMIN_SUBJECTS, a variable on the migrate service, so the list is
 *                changed by people with Railway access and Railway logs that too.
 */

import { Pool, PoolClient } from 'pg';
import { log } from './log';

export type Role = 'user' | 'admin';

const SUBJECT = /^[A-Za-z0-9_-]{1,128}$/;

export class RoleError extends Error {}

export interface RoleChange {
    subject: string;
    role: Role;
    reason: string;
    actor: string;
}

function validate(change: RoleChange): void {
    if (!SUBJECT.test(change.subject)) throw new RoleError(`Not a provider user id: ${JSON.stringify(change.subject)}`);
    if (change.role !== 'user' && change.role !== 'admin') throw new RoleError('Role must be user or admin');
    if (!change.reason || change.reason.trim().length < 10) throw new RoleError('A reason of at least 10 characters is required');
    if (!change.actor?.trim()) throw new RoleError('An actor is required');
}

/** Applies one change inside `client`'s transaction. Returns the previous role, or null if no profile. */
async function apply(client: PoolClient, change: RoleChange): Promise<Role | null> {
    const { rows } = await client.query<{ id: number; previous: Role }>(
        `UPDATE accounts.user_profiles p SET role = $2, updated_at = now()
         FROM (SELECT id, role AS previous FROM accounts.user_profiles
               WHERE auth_provider = 'clerk' AND auth_subject = $1 FOR UPDATE) old
         WHERE p.id = old.id
         RETURNING p.id::int, old.previous`,
        [change.subject, change.role]
    );
    if (!rows[0]) return null;
    if (rows[0].previous !== change.role) {
        await client.query(
            `INSERT INTO accounts.user_activity_audit (user_id, auth_subject, action, detail, actor)
             VALUES ($1, $2, 'role.changed', $3, $4)`,
            [rows[0].id, change.subject, JSON.stringify({ from: rows[0].previous, to: change.role, reason: change.reason.trim() }), change.actor]
        );
        log.info('role changed', { subject: change.subject, from: rows[0].previous, to: change.role, actor: change.actor });
    }
    return rows[0].previous;
}

async function inTransaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await body(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

/** One change. The person must have signed in once, so that the profile exists. */
export async function changeRole(pool: Pool, change: RoleChange): Promise<{ from: Role }> {
    validate(change);
    const previous = await inTransaction(pool, client => apply(client, change));
    if (previous === null) {
        throw new RoleError(`No profile for ${change.subject}. The person must sign in once before a role can be set.`);
    }
    return { from: previous };
}

/**
 * Makes the administrators exactly `subjects`: promotes those listed, demotes any other
 * admin. All or nothing. A listed subject without a profile yet (has not signed in) is
 * reported and skipped, and is promoted by a later run once it has one.
 */
export async function syncAdmins(
    pool: Pool,
    subjects: string[],
    reason: string,
    actor: string
): Promise<{ promoted: string[]; demoted: string[]; pending: string[] }> {
    for (const subject of subjects) validate({ subject, role: 'admin', reason, actor });
    const wanted = new Set(subjects);
    return inTransaction(pool, async client => {
        // Serialize concurrent syncs (two deploys at once).
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('ncadb:sync-admins'))`);
        const promoted: string[] = [];
        const demoted: string[] = [];
        const pending: string[] = [];
        const { rows } = await client.query<{ auth_subject: string }>(
            `SELECT auth_subject FROM accounts.user_profiles WHERE auth_provider = 'clerk' AND role = 'admin'`
        );
        for (const { auth_subject } of rows) {
            if (!wanted.has(auth_subject)) {
                await apply(client, { subject: auth_subject, role: 'user', reason, actor });
                demoted.push(auth_subject);
            }
        }
        const current = new Set(rows.map(r => r.auth_subject));
        for (const subject of wanted) {
            if (current.has(subject)) continue;
            const previous = await apply(client, { subject, role: 'admin', reason, actor });
            if (previous === null) pending.push(subject);
            else promoted.push(subject);
        }
        return { promoted, demoted, pending };
    });
}

/** NCADB_ADMIN_SUBJECTS: comma- or space-separated provider user ids. Undefined if unset. */
export function parseAdminSubjects(value: string | undefined): string[] | undefined {
    if (value === undefined) return undefined;
    return [...new Set(value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean))];
}
