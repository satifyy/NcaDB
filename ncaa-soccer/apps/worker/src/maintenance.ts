/**
 * Maintenance requested by an administrator from the admin dashboard.
 *
 * The API only records a request (table `maintenance_requests`); this carries it out,
 * after the scheduled run, with the same code paths as the `retry` and `analytics` CLI
 * commands. A request is re-validated here rather than trusted: the target must still be
 * a failed or abandoned run. Failures are recorded on the request and never change the
 * exit status of the scheduled run that triggered processing.
 */

import { Pool } from 'pg';
import { log } from './log';

export interface MaintenanceRequest {
    id: number;
    action: 'retry_run' | 'rebuild_analytics';
    target_run_id: number | null;
    requested_by: string;
}

export interface MaintenanceHandlers {
    retryRun(runId: number, trigger: string): Promise<number>;
    rebuildAnalytics(trigger: string): Promise<number>;
}

/** At most this many per pass, so a flood of requests cannot keep the worker busy all day. */
const MAX_PER_PASS = 3;

async function claimNext(pool: Pool): Promise<MaintenanceRequest | null> {
    const { rows } = await pool.query<MaintenanceRequest>(
        `UPDATE maintenance_requests SET status = 'running', started_at = now()
         WHERE id = (SELECT id FROM maintenance_requests WHERE status = 'pending'
                     ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id::int, action, target_run_id::int, requested_by`
    );
    return rows[0] ?? null;
}

async function finish(pool: Pool, id: number, status: string, note: string | null, resultRunId: number | null) {
    await pool.query(
        `UPDATE maintenance_requests SET status = $2, note = $3, result_run_id = $4, finished_at = now() WHERE id = $1`,
        [id, status, note, resultRunId]
    );
}

async function resultRun(pool: Pool, trigger: string): Promise<number | null> {
    const { rows } = await pool.query<{ id: number }>(
        `SELECT id::int FROM ingestion_runs WHERE trigger = $1 ORDER BY started_at DESC LIMIT 1`,
        [trigger]
    );
    return rows[0]?.id ?? null;
}

export async function processMaintenanceRequests(pool: Pool, handlers: MaintenanceHandlers): Promise<number> {
    let processed = 0;
    for (let i = 0; i < MAX_PER_PASS; i++) {
        const request = await claimNext(pool);
        if (!request) break;
        processed++;
        const trigger = `maintenance:${request.id}`;
        log.info('maintenance request started', { request_id: request.id, action: request.action, requested_by: request.requested_by });
        try {
            if (request.action === 'retry_run') {
                const { rows } = await pool.query<{ status: string }>('SELECT status FROM ingestion_runs WHERE id = $1', [
                    request.target_run_id
                ]);
                if (!rows[0] || !['failed', 'abandoned'].includes(rows[0].status)) {
                    await finish(pool, request.id, 'rejected', `Run ${request.target_run_id} is not failed or abandoned`, null);
                    continue;
                }
                const code = await handlers.retryRun(request.target_run_id!, trigger);
                await finish(pool, request.id, code === 0 ? 'succeeded' : 'failed', `exit ${code}`, await resultRun(pool, trigger));
            } else {
                const code = await handlers.rebuildAnalytics(trigger);
                await finish(pool, request.id, code === 0 ? 'succeeded' : 'failed', `exit ${code}`, await resultRun(pool, trigger));
            }
        } catch (err) {
            log.error('maintenance request failed', { request_id: request.id, error: (err as Error).message });
            await finish(pool, request.id, 'failed', (err as Error).message.slice(0, 500), null).catch(() => undefined);
        }
    }
    return processed;
}
