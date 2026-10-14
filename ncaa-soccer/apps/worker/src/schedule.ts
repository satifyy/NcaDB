/**
 * When the nightly run actually does something.
 *
 * Railway's cron is UTC. 03:00 in Chicago is 08:00 UTC in summer and 09:00 UTC in
 * winter, so the service is scheduled at both (`0 8,9 * * *`) and this gate lets through
 * only the firing that lands on the configured local hour. Daylight saving changes which
 * firing that is; nothing has to be edited twice a year.
 *
 * A run that is overdue — the container was down, the 03:00 firing failed — goes ahead
 * at the next firing whatever the hour, which is how a missed night recovers on its own.
 */

export interface LocalTime {
    year: number;
    month: number;
    day: number;
    hour: number;
}

export function localTime(timezone: string, at: Date = new Date()): LocalTime {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        hourCycle: 'h23'
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') };
}

export interface GateDecision {
    run: boolean;
    reason: string;
}

export function nightlyGate(options: {
    now: Date;
    timezone: string;
    hour: number;
    lastSuccessAt: Date | null;
    recoveryAfterHours: number;
    force: boolean;
}): GateDecision {
    if (options.force) return { run: true, reason: 'forced' };
    const local = localTime(options.timezone, options.now);
    if (local.hour === options.hour) return { run: true, reason: `scheduled ${options.hour}:00 ${options.timezone}` };
    if (!options.lastSuccessAt) return { run: true, reason: 'no successful nightly run on record' };
    const hours = (options.now.getTime() - options.lastSuccessAt.getTime()) / 3_600_000;
    if (hours >= options.recoveryAfterHours) {
        return { run: true, reason: `recovery: last success ${hours.toFixed(1)}h ago` };
    }
    return {
        run: false,
        reason: `outside the ${options.hour}:00 ${options.timezone} window (local hour ${local.hour}) and last success ${hours.toFixed(1)}h ago`
    };
}

/**
 * The season a date falls in. Seasons are calendar years played August–December; from
 * January to July the most recent season is last year's.
 */
export function seasonFor(local: LocalTime): number {
    return local.month >= 8 ? local.year : local.year - 1;
}
