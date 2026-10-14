/**
 * Applies the SQL files in `migrations/` in name order, once each.
 *
 * Deliberately small: plain SQL files, one transaction per file, a checksum per applied
 * file so an edited migration is refused rather than silently diverging between
 * environments, and an advisory lock so two deploys starting together cannot both apply
 * the same file.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

export const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

/** Arbitrary, fixed: the advisory lock key the migrator holds while it runs. */
const MIGRATION_LOCK_KEY = 4_821_337;

export interface MigrationFile {
    name: string;
    sql: string;
    checksum: string;
}

export function readMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
    return fs
        .readdirSync(dir)
        .filter(file => /^\d{3}_.+\.sql$/.test(file))
        .sort()
        .map(name => {
            const sql = fs.readFileSync(path.join(dir, name), 'utf8');
            return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
        });
}

export interface MigrationResult {
    applied: string[];
    alreadyApplied: string[];
}

export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
    const files = readMigrations(dir);
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name        text PRIMARY KEY,
                checksum    text NOT NULL,
                applied_at  timestamptz NOT NULL DEFAULT now()
            )`);
        const { rows } = await client.query<{ name: string; checksum: string }>(
            'SELECT name, checksum FROM schema_migrations'
        );
        const applied = new Map(rows.map(row => [row.name, row.checksum]));

        const result: MigrationResult = { applied: [], alreadyApplied: [] };
        for (const file of files) {
            const previous = applied.get(file.name);
            if (previous !== undefined) {
                if (previous !== file.checksum) {
                    throw new Error(
                        `Migration ${file.name} was edited after it was applied (checksum mismatch). ` +
                            'Add a new migration instead of changing an applied one.'
                    );
                }
                result.alreadyApplied.push(file.name);
                continue;
            }
            await client.query('BEGIN');
            try {
                await client.query(file.sql);
                await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
                    file.name,
                    file.checksum
                ]);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`);
            }
            result.applied.push(file.name);
        }
        return result;
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
        client.release();
    }
}

/** Names of migrations on disk that the database has not applied. */
export async function pendingMigrations(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
    const exists = await pool.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS present`);
    const applied = new Set<string>();
    if (exists.rows[0].present) {
        const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
        rows.forEach(row => applied.add(row.name));
    }
    return readMigrations(dir)
        .map(file => file.name)
        .filter(name => !applied.has(name));
}
