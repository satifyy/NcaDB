/**
 * Ingestion bookkeeping: runs, their tasks, their errors, the lock that keeps two runs
 * from overlapping, and the per-scope sync state the freshness checks read.
 */

import * as os from 'os';
import { Pool, PoolClient } from 'pg';
import { QualityIssue } from './types';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'abandoned';
export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

/** Fixed key for the advisory lock every ingestion run holds. */
export const INGESTION_LOCK_KEY = 7_340_211;

/**
 * Session-level advisory lock, held on a dedicated connection for the whole run.
 *
 * Postgres releases it when that connection ends, so a worker that crashes or is killed
 * mid-run can never leave a stale lock behind — the next run simply acquires it.
 */
export class IngestionLock {
    /** Set when the lock's connection died; the lock is gone with it. */
    lost = false;

    private constructor(private client: PoolClient) {
        // A checked-out client reports a dropped connection as an 'error' event, and an
        // unhandled one would crash the run. The lock is released by Postgres either way.
        client.on('error', err => {
            this.lost = true;
            console.error(JSON.stringify({ level: 'error', msg: 'ingestion lock connection lost', error: err.message }));
        });
    }

    static async tryAcquire(pool: Pool): Promise<IngestionLock | null> {
        const client = await pool.connect();
        try {
            const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
                INGESTION_LOCK_KEY
            ]);
            if (rows[0].ok) return new IngestionLock(client);
        } catch (err) {
            client.release();
            throw err;
        }
        client.release();
        return null;
    }

    async release(): Promise<void> {
        try {
            if (!this.lost) await this.client.query('SELECT pg_advisory_unlock($1)', [INGESTION_LOCK_KEY]);
        } finally {
            // A dead connection must not go back into the pool.
            this.client.release(this.lost);
        }
    }
}

export async function startRun(
    pool: Pool,
    kind: string,
    trigger: string,
    params: Record<string, unknown>
): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO ingestion_runs (kind, trigger, status, params, host)
         VALUES ($1, $2, 'running', $3, $4) RETURNING id`,
        [kind, trigger, JSON.stringify(params), os.hostname()]
    );
    return Number(rows[0].id);
}

export async function heartbeat(pool: Pool, runId: number): Promise<void> {
    await pool.query('UPDATE ingestion_runs SET heartbeat_at = now() WHERE id = $1', [runId]);
}

export async function finishRun(
    pool: Pool,
    runId: number,
    status: RunStatus,
    stats: Record<string, unknown>,
    error?: string
): Promise<void> {
    await pool.query(
        `UPDATE ingestion_runs
         SET status = $2, stats = $3, error = $4, finished_at = now(), heartbeat_at = now()
         WHERE id = $1`,
        [runId, status, JSON.stringify(stats), error ?? null]
    );
}

/**
 * Marks runs that died without finishing.
 *
 * Called only while holding the ingestion lock: if we hold it, no other run is alive,
 * so anything still marked `running` was a process that was killed.
 */
export async function abandonOrphanedRuns(pool: Pool): Promise<number> {
    const { rowCount } = await pool.query(
        `UPDATE ingestion_runs
         SET status = 'abandoned', finished_at = now(),
             error = COALESCE(error, 'Process ended without recording a result (killed, crashed or redeployed).')
         WHERE status = 'running'`
    );
    await pool.query(
        `UPDATE ingestion_tasks SET status = 'failed', finished_at = now(),
             error = COALESCE(error, 'Run abandoned')
         WHERE status = 'running'`
    );
    return rowCount ?? 0;
}

export async function startTask(
    pool: Pool,
    runId: number,
    stage: string,
    season: number | null,
    params: Record<string, unknown> = {}
): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO ingestion_tasks (run_id, season, stage, status, params)
         VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
        [runId, season, stage, JSON.stringify(params)]
    );
    return Number(rows[0].id);
}

export async function finishTask(
    pool: Pool,
    taskId: number,
    status: TaskStatus,
    stats: Record<string, unknown> = {},
    error?: string
): Promise<void> {
    await pool.query(
        `UPDATE ingestion_tasks SET status = $2, stats = $3, error = $4, finished_at = now() WHERE id = $1`,
        [taskId, status, JSON.stringify(stats), error ?? null]
    );
}

export async function recordError(
    pool: Pool,
    entry: {
        runId?: number | null;
        taskId?: number | null;
        category: 'source' | 'parse' | 'validation' | 'reconciliation' | 'database' | 'internal';
        severity?: 'warning' | 'error';
        code: string;
        message: string;
        count?: number;
        context?: Record<string, unknown>;
    }
): Promise<void> {
    await pool.query(
        `INSERT INTO ingestion_errors (run_id, task_id, category, severity, code, message, count, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            entry.runId ?? null,
            entry.taskId ?? null,
            entry.category,
            entry.severity ?? 'error',
            entry.code,
            entry.message.slice(0, 4000),
            entry.count ?? 1,
            JSON.stringify(entry.context ?? {})
        ]
    );
}

export async function recordIssues(pool: Pool, runId: number, taskId: number, season: number, issues: QualityIssue[]) {
    for (const i of issues) {
        await recordError(pool, {
            runId,
            taskId,
            category: i.category,
            severity: i.severity,
            code: i.code,
            message: i.message,
            count: i.count,
            context: { season, samples: i.samples }
        });
    }
}

export async function markSync(
    pool: Pool,
    scope: string,
    runId: number,
    succeeded: boolean,
    details: Record<string, unknown> = {}
): Promise<void> {
    await pool.query(
        `INSERT INTO data_sync_state (scope, last_attempt_at, last_attempt_run_id, last_status, details,
                                      last_success_at, last_success_run_id, updated_at)
         VALUES ($1, now(), $2, $3, $4, CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN $2::bigint END, now())
         ON CONFLICT (scope) DO UPDATE SET
             last_attempt_at = now(),
             last_attempt_run_id = $2,
             last_status = $3,
             details = $4,
             last_success_at = CASE WHEN $5 THEN now() ELSE data_sync_state.last_success_at END,
             last_success_run_id = CASE WHEN $5 THEN $2::bigint ELSE data_sync_state.last_success_run_id END,
             updated_at = now()`,
        [scope, runId, succeeded ? 'succeeded' : 'failed', JSON.stringify(details), succeeded]
    );
}

export interface RunSummary {
    id: number;
    kind: string;
    trigger: string;
    status: RunStatus;
    params: Record<string, unknown>;
    stats: Record<string, unknown>;
    error: string | null;
    started_at: string;
    finished_at: string | null;
    heartbeat_at: string;
}

export async function latestRuns(pool: Pool, limit = 10, kind?: string): Promise<RunSummary[]> {
    const { rows } = await pool.query(
        `SELECT id::int, kind, trigger, status, params, stats, error, started_at, finished_at, heartbeat_at
         FROM ingestion_runs ${kind ? 'WHERE kind = $2' : ''}
         ORDER BY started_at DESC LIMIT $1`,
        kind ? [limit, kind] : [limit]
    );
    return rows;
}

/** The last run of `kinds` that finished successfully, or null. */
export async function lastSuccess(pool: Pool, kinds: string[]): Promise<RunSummary | null> {
    const { rows } = await pool.query(
        `SELECT id::int, kind, trigger, status, params, stats, error, started_at, finished_at, heartbeat_at
         FROM ingestion_runs WHERE kind = ANY($1::text[]) AND status = 'succeeded'
         ORDER BY finished_at DESC LIMIT 1`,
        [kinds]
    );
    return rows[0] ?? null;
}
