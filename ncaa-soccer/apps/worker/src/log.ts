/**
 * Structured logs: one JSON object per line, which Railway's log view indexes by field.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

/** Keys whose values never reach a log line. */
const SECRET = /password|secret|token|database_url|webhook|authorization/i;

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
        out[key] = SECRET.test(key) ? '[redacted]' : value instanceof Error ? value.message : value;
    }
    return out;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVELS[level] < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...scrub(fields) });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const log = {
    debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields)
};
