import { Pool } from 'pg';

export const seasonQuery = { type: 'integer', minimum: 1990, maximum: 2100 } as const;

/** `term` -> `%term%` with LIKE's own metacharacters escaped, or null. */
export function likePattern(term: string | undefined): string | null {
    const trimmed = term?.trim();
    return trimmed ? `%${trimmed.replace(/[\\%_]/g, '\\$&')}%` : null;
}

let latest: { value: number; at: number } | null = null;

/** The newest season with games. Cached for a minute; it changes once a year. */
export async function latestSeason(pool: Pool): Promise<number> {
    if (latest && Date.now() - latest.at < 60_000) return latest.value;
    const { rows } = await pool.query<{ year: number | null }>(
        `SELECT max(s.year) AS year FROM seasons s WHERE EXISTS (SELECT 1 FROM games g WHERE g.season_id = s.id)`
    );
    const value = rows[0].year ?? new Date().getFullYear();
    latest = { value, at: Date.now() };
    return value;
}
