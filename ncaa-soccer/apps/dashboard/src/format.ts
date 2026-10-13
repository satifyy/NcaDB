/** Formatting shared by the views, so a date or a percentage reads the same everywhere. */

const DAY = { month: 'short', day: 'numeric' } as const;

/** `2026-09-04` → `Sep 4`. Parsed as UTC so the day never shifts by timezone. */
export function shortDate(iso: string): string {
    const date = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString(undefined, { ...DAY, timeZone: 'UTC' });
}

/** The week beginning `2026-08-31` → `Aug 31 – Sep 6`. */
export function weekLabel(iso: string): string {
    const start = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(start.getTime())) return iso;
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { ...DAY, timeZone: 'UTC' });
    return `${fmt(start)} – ${fmt(end)}`;
}

export function percent(value: number, places = 0): string {
    return `${(value * 100).toFixed(places)}%`;
}

export function signed(value: number): string {
    return value > 0 ? `+${value}` : String(value);
}

/** `1834` → `1,834`, and always the same width in a column. */
export function count(value: number): string {
    return value.toLocaleString();
}
