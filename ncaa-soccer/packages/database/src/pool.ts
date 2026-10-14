/**
 * One connection pool per process, configured from the environment.
 *
 * The API and the worker share this, with different pool sizes: the API serves
 * concurrent reads, the worker writes one season at a time and needs a spare connection
 * for the advisory lock it holds for the length of a run.
 */

import { Pool, PoolClient, PoolConfig, types } from 'pg';

// bigint ids come back as strings by default. Every id here is far below 2^53, and the
// API's clients expect numbers.
types.setTypeParser(types.builtins.INT8, value => Number(value));

export interface DatabaseOptions {
    connectionString?: string;
    max?: number;
    /** Application name shown in pg_stat_activity, so a stuck query names its owner. */
    applicationName?: string;
    /** Per-statement limit; overrides DATABASE_STATEMENT_TIMEOUT_MS. */
    statementTimeoutMs?: number;
}

/** Strips the password from a connection string, for logs. */
export function redactConnectionString(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.password) parsed.password = '***';
        return parsed.toString();
    } catch {
        return '<unparseable DATABASE_URL>';
    }
}

export function poolConfig(options: DatabaseOptions = {}): PoolConfig {
    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL is not set.');
    }
    // Railway's private network is plaintext inside the project; its public TCP proxy
    // presents a certificate that does not chain to a public root. DATABASE_SSL opts in
    // for the latter rather than guessing from the hostname.
    const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
    return {
        connectionString,
        ssl,
        max: options.max ?? Number(process.env.DATABASE_POOL_MAX || 10),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        // A runaway query should fail, not hold a connection until the platform kills it.
        // Only when asked for: otherwise the role's own default applies (ncadb_api 5s,
        // ncadb_worker 10min — see migration 002), which a pool-wide value would override.
        statement_timeout:
            options.statementTimeoutMs ??
            (process.env.DATABASE_STATEMENT_TIMEOUT_MS ? Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS) : undefined),
        application_name: options.applicationName ?? 'ncadb'
    };
}

export function createPool(options: DatabaseOptions = {}): Pool {
    const pool = new Pool(poolConfig(options));
    // An idle client that loses its connection emits here; unhandled, it crashes the
    // process. The next checkout reconnects.
    pool.on('error', err => {
        console.error(JSON.stringify({ level: 'error', msg: 'idle database client error', error: err.message }));
    });
    return pool;
}

const TRANSIENT_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    '57P01', // admin_shutdown
    '57P03', // cannot_connect_now (starting up)
    '53300', // too_many_connections
    '08006', // connection_failure
    '08001' // unable to establish connection
]);

export function isTransientError(err: unknown): boolean {
    const code = (err as { code?: string })?.code;
    return code !== undefined && TRANSIENT_CODES.has(code);
}

/**
 * Waits for the database to accept a connection.
 *
 * A deploy commonly starts the API while Postgres is restarting or still provisioning;
 * failing the first query there turns a ten-second blip into a crash loop.
 */
export async function waitForDatabase(pool: Pool, attempts = 8): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await pool.query('SELECT 1');
            return;
        } catch (err) {
            if (attempt >= attempts || !isTransientError(err)) throw err;
            const delay = Math.min(15_000, 500 * 2 ** attempt);
            console.warn(
                JSON.stringify({ level: 'warn', msg: 'database not ready, retrying', attempt, delay_ms: delay, code: (err as { code?: string }).code })
            );
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/** Runs `work` in a transaction, rolling back on any throw. */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}
