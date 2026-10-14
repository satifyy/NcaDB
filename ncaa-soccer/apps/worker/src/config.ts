/**
 * Worker configuration, read once from the environment.
 *
 * The scraper knobs (SCRAPER_*) are not read here: they are inherited by the stage
 * processes the worker spawns and read where they are used, in `@ncaa/parsers`'s
 * politeness module and the stage scripts.
 */

import * as os from 'os';
import * as path from 'path';

function num(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
    return value;
}

function bool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** "8-12" or "8,9,10,11,12" -> [8, 9, 10, 11, 12]. */
export function parseMonths(spec: string): number[] {
    const months = new Set<number>();
    for (const part of spec.split(',').map(p => p.trim()).filter(Boolean)) {
        const [a, b] = part.split('-').map(Number);
        const end = b ?? a;
        if (!Number.isInteger(a) || !Number.isInteger(end) || a < 1 || end > 12 || end < a) {
            throw new Error(`Bad month range "${part}" in INGESTION_ACTIVE_MONTHS`);
        }
        for (let m = a; m <= end; m++) months.add(m);
    }
    return [...months].sort((x, y) => x - y);
}

export interface WorkerConfig {
    /** Where the code checkout is: scripts and the team inventory are read from here. */
    codeRoot: string;
    /** Scratch tree the scrapers read and write; rebuilt from the database each run. */
    workDir: string;
    mode: 'incremental' | 'full';
    /** Days back a stored box score is still re-fetched for corrections. */
    lookbackDays: number;
    timezone: string;
    nightlyHour: number;
    /** Months the season is played in; outside them the nightly run does not scrape. */
    activeMonths: number[];
    /** A nightly run this many hours overdue runs whatever the local time. */
    recoveryAfterHours: number;
    /** No successful sync for this long is reported as stale. */
    staleAfterHours: number;
    analyticsEnabled: boolean;
    alertWebhookUrl?: string;
    /** Max share of a season a scrape may lose before it counts as failed (row guard). */
    maxDropPct: number;
}

export function loadConfig(): WorkerConfig {
    const codeRoot = path.resolve(__dirname, '../../..');
    const mode = (process.env.INGESTION_MODE || 'incremental') as WorkerConfig['mode'];
    if (mode !== 'incremental' && mode !== 'full') throw new Error(`INGESTION_MODE must be incremental or full`);
    return {
        codeRoot,
        workDir: path.resolve(process.env.WORK_DIR || path.join(os.tmpdir(), 'ncadb-work')),
        mode,
        lookbackDays: num('INGESTION_LOOKBACK_DAYS', 7),
        timezone: process.env.NIGHTLY_TIMEZONE || 'America/Chicago',
        nightlyHour: num('NIGHTLY_LOCAL_HOUR', 3),
        activeMonths: parseMonths(process.env.INGESTION_ACTIVE_MONTHS || '8-12'),
        recoveryAfterHours: num('NIGHTLY_RECOVERY_AFTER_HOURS', 26),
        staleAfterHours: num('STALE_AFTER_HOURS', 36),
        analyticsEnabled: bool('ANALYTICS_ENABLED', true),
        alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || undefined,
        maxDropPct: num('INGESTION_MAX_DROP_PCT', 3)
    };
}
