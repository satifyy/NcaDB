/**
 * Test database helpers. Database tests need `TEST_DATABASE_URL` and are skipped
 * without it; each file resets the schema, so they must not run in parallel against
 * the same database (`npm run test:db` runs them one at a time).
 */

import { Pool } from 'pg';
import { createPool, migrate } from '../src';
import type { GameSourceRecord, PlayerStatRecord, SeasonBatch, TeamRecord } from '../src';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const skipWithoutDb = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

export async function freshDatabase(): Promise<Pool> {
    const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 4, applicationName: 'ncadb-test' });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    return pool;
}

export const TEAMS: TeamRecord[] = [
    { slug: 'duke', name: 'Duke', inventoryId: 'DUKE', isDivisionOne: true, conference: 'ACC' },
    { slug: 'clemson', name: 'Clemson', inventoryId: 'CLEMSON', isDivisionOne: true, conference: 'ACC' },
    { slug: 'indiana', name: 'Indiana', inventoryId: 'INDIANA', isDivisionOne: true, conference: 'Big Ten' }
];

export function game(overrides: Partial<GameSourceRecord> = {}): GameSourceRecord {
    const base: GameSourceRecord = {
        dedupeKey: '2025-09-05-Clemson-Duke',
        sourceGameId: 'sidearm-2025-09-05-Duke-Clemson',
        date: '2025-09-05',
        homeSlug: 'duke',
        awaySlug: 'clemson',
        homeName: 'Duke',
        awayName: 'Clemson',
        homeRanked: false,
        awayRanked: true,
        homeScore: 2,
        awayScore: 1,
        status: 'final',
        locationType: 'home',
        gameType: 'regular',
        scheduleUrl: null,
        boxscoreUrl: 'https://goduke.com/boxscore/1',
        boxscoreUrlAlt: null,
        payload: {}
    };
    const merged = { ...base, ...overrides };
    merged.payload = {
        game_id: merged.sourceGameId,
        date: merged.date,
        home_team_name: merged.homeName,
        away_team_name: merged.awayName,
        home_score: merged.homeScore === null ? '' : String(merged.homeScore),
        away_score: merged.awayScore === null ? '' : String(merged.awayScore),
        status: merged.status,
        dedupe_key: merged.dedupeKey,
        ...overrides.payload
    };
    return merged;
}

export function stat(name: string, teamSlug: string, overrides: Partial<PlayerStatRecord> = {}): PlayerStatRecord {
    const letters = name.toLowerCase().replace(/[^a-z]/g, '');
    return {
        sourceGameId: 'sidearm-2025-09-05-Duke-Clemson',
        teamSlug,
        identityKey: `${teamSlug}:${letters}`,
        playerName: name,
        displayName: name,
        jerseyNumber: '9',
        minutes: 90,
        goals: 0,
        assists: 0,
        shots: 1,
        shotsOnGoal: 0,
        saves: 0,
        sourceTeamName: teamSlug,
        sourcePlayerName: name,
        sourcePlayerKey: `${teamSlug}:${letters}`,
        ...overrides
    };
}

export function batch(season: number, games: GameSourceRecord[], stats: PlayerStatRecord[], complete = true): SeasonBatch {
    return { season, teams: TEAMS, teamSpellings: new Map(), games, stats, complete };
}

export async function count(pool: Pool, table: string): Promise<number> {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0].n;
}
