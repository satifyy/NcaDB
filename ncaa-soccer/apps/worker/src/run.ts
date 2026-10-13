/**
 * The lifecycle every ingestion command shares: take the lock, record the run, keep a
 * heartbeat, survive termination signals, record the outcome, alert on failure, and
 * always give the lock and the connections back.
 */

import { Pool } from 'pg';
import {
    IngestionLock,
    abandonOrphanedRuns,
    finishRun,
    finishTask,
    heartbeat,
    recordError,
    startRun,
    startTask
} from '@ncaa/database';
import { WorkerConfig } from './config';
import { log } from './log';
import { notify } from './notify';
import { killRunningStages } from './stages';

export interface RunContext {
    pool: Pool;
    config: WorkerConfig;
    runId: number;
    kind: string;
    /** Totals across the run, written to `ingestion_runs.stats`. */
    stats: Record<string, unknown>;
    failures: string[];
}

export interface RunOptions {
    kind: string;
    trigger: string;
    params: Record<string, unknown>;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/**
 * Runs `body` as one recorded ingestion run. Returns the process exit code.
 *
 * A second run that finds the lock held does not wait: it records itself as skipped and
 * exits cleanly. The scheduler fires again tomorrow, and an overdue nightly run recovers
 * at the next firing (see schedule.ts), so queueing would only stack runs up.
 */
export async function executeRun(
    pool: Pool,
    config: WorkerConfig,
    options: RunOptions,
    body: (ctx: RunContext) => Promise<void>
): Promise<number> {
    const lock = await IngestionLock.tryAcquire(pool);
    if (!lock) {
        const runId = await startRun(pool, options.kind, options.trigger, options.params);
        await finishRun(pool, runId, 'skipped', {}, 'Another ingestion run holds the lock.');
        log.warn('another ingestion run is in progress; skipping', { kind: options.kind, run_id: runId });
        return EXIT_OK;
    }

    const orphaned = await abandonOrphanedRuns(pool);
    if (orphaned > 0) {
        log.warn('marked orphaned runs as abandoned', { count: orphaned });
        await notify(config.alertWebhookUrl, `${orphaned} earlier run(s) never finished and were marked abandoned`, {
            hint: 'The process was killed or redeployed mid-run. Data is consistent (loads are transactional).'
        });
    }

    const runId = await startRun(pool, options.kind, options.trigger, options.params);
    const ctx: RunContext = { pool, config, runId, kind: options.kind, stats: {}, failures: [] };
    const started = Date.now();
    log.info('run started', { run_id: runId, kind: options.kind, trigger: options.trigger, params: options.params });

    const beat = setInterval(() => {
        heartbeat(pool, runId).catch(err => log.warn('heartbeat failed', { error: err }));
    }, 60_000);

    let terminating = false;
    const onSignal = async (signal: NodeJS.Signals) => {
        if (terminating) return;
        terminating = true;
        log.error('received termination signal; stopping run', { signal, run_id: runId });
        killRunningStages();
        clearInterval(beat);
        try {
            await finishRun(pool, runId, 'failed', { ...ctx.stats, seconds: secondsSince(started) }, `Terminated by ${signal}`);
            await notify(config.alertWebhookUrl, `Run ${runId} (${options.kind}) was terminated by ${signal}`);
            await lock.release();
            await pool.end();
        } finally {
            process.exit(143);
        }
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);

    try {
        await body(ctx);
        const status = ctx.failures.length === 0 ? 'succeeded' : 'failed';
        const stats = { ...ctx.stats, seconds: secondsSince(started) };
        await finishRun(pool, runId, status, stats, ctx.failures.join('; ') || undefined);
        log.info('run finished', { run_id: runId, kind: options.kind, status, stats });
        if (status === 'failed') {
            await notify(config.alertWebhookUrl, `Run ${runId} (${options.kind}) failed`, {
                failures: ctx.failures.join('; '),
                inspect: `npm run worker -- status --run ${runId}`
            });
            return EXIT_FAILED;
        }
        return EXIT_OK;
    } catch (err) {
        const message = (err as Error).stack || String(err);
        log.error('run crashed', { run_id: runId, error: message });
        await recordError(pool, { runId, category: 'internal', code: 'run_crashed', message }).catch(() => undefined);
        await finishRun(pool, runId, 'failed', { ...ctx.stats, seconds: secondsSince(started) }, (err as Error).message);
        await notify(config.alertWebhookUrl, `Run ${runId} (${options.kind}) crashed`, { error: (err as Error).message });
        return EXIT_FAILED;
    } finally {
        clearInterval(beat);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGINT', onSignal);
        if (!terminating) await lock.release().catch(err => log.warn('lock release failed', { error: err }));
    }
}

const secondsSince = (start: number) => Math.round((Date.now() - start) / 1000);

/**
 * One recorded task. Resolves to its value, or to `undefined` after recording the
 * failure on the run — so one season failing does not stop the next from being tried.
 */
export async function task<T>(
    ctx: RunContext,
    stage: string,
    season: number | null,
    params: Record<string, unknown>,
    work: (taskId: number) => Promise<{ value: T; stats?: Record<string, unknown>; failed?: string }>
): Promise<T | undefined> {
    const taskId = await startTask(ctx.pool, ctx.runId, stage, season, params);
    try {
        const { value, stats, failed } = await work(taskId);
        await finishTask(ctx.pool, taskId, failed ? 'failed' : 'succeeded', stats ?? {}, failed);
        if (failed) {
            ctx.failures.push(`${season ?? 'all'}/${stage}: ${failed}`);
            log.error('task failed', { run_id: ctx.runId, stage, season, error: failed });
        }
        return value;
    } catch (err) {
        const message = (err as Error).message;
        await finishTask(ctx.pool, taskId, 'failed', {}, message);
        await recordError(ctx.pool, {
            runId: ctx.runId,
            taskId,
            category: /database|relation|constraint|violates|connect/i.test(message) ? 'database' : 'internal',
            code: `${stage}_error`,
            message: (err as Error).stack || message,
            context: { season }
        });
        ctx.failures.push(`${season ?? 'all'}/${stage}: ${message}`);
        log.error('task crashed', { run_id: ctx.runId, stage, season, error: message });
        return undefined;
    }
}
