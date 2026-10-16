/**
 * Removing identities no data refers to any more, after team names re-resolved
 * (issue #42): orphans found, users' favorites carried to the surviving identity or
 * removed with an audit row, and nothing left for a second run.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { IngestionLock, loadSeason } from '@ncaa/database';
import type { GameSourceRecord, PlayerStatRecord, SeasonBatch, TeamRecord } from '@ncaa/database';
import { freshDatabase, game, skipWithoutDb, stat } from '../../../packages/database/test/helpers';
import { SchoolIndex } from '../../scraper/src/utils/school_names';
import type { TeamConfig } from '../../scraper/src/utils/teams';
import { TeamResolver } from '../src/normalize';
import { reconcileIdentities } from '../src/reconcile';

const inventoryTeams: TeamConfig[] = [
    { team_id: 'CORNELL', name_canonical: 'Cornell', conference: 'Ivy', schedule_url: 'https://cornellbigred.com/sports/mens-soccer/schedule' },
    { team_id: 'DARTMOUTH', name_canonical: 'Dartmouth', conference: 'Ivy', schedule_url: 'https://dartmouthsports.com/sports/mens-soccer/schedule' }
];
function resolver(): TeamResolver {
    const index = new SchoolIndex<TeamConfig>();
    inventoryTeams.forEach(t => index.add(t));
    return new TeamResolver({ teams: inventoryTeams, index, unscraped: [] });
}

const teams: TeamRecord[] = [
    { slug: 'cornell', name: 'Cornell', inventoryId: 'CORNELL', isDivisionOne: true, conference: 'Ivy' },
    { slug: 'dartmouth', name: 'Dartmouth', inventoryId: 'DARTMOUTH', isDivisionOne: true, conference: 'Ivy' },
    { slug: '19-cornell', name: '19 Cornell', isDivisionOne: false },
    { slug: 'elite-8', name: 'ELITE 8', isDivisionOne: false }
];
const season = (games: GameSourceRecord[], stats: PlayerStatRecord[]): SeasonBatch =>
    ({ season: 2026, teams, teamSpellings: new Map(), games, stats, complete: true });
const fixture = (home: string) => game({
    dedupeKey: '2026-10-24-19-Cornell-Dartmouth', sourceGameId: 'cornell-1024', date: '2026-10-24',
    homeSlug: home, awaySlug: 'dartmouth', homeName: '19 Cornell', awayName: 'Dartmouth', homeScore: 1, awayScore: 0
});
const placeholder = game({
    dedupeKey: '2026-12-05-Dartmouth-ELITE-8', sourceGameId: 'dartmouth-1205', date: '2026-12-05',
    homeSlug: 'dartmouth', awaySlug: 'elite-8', homeName: 'Dartmouth', awayName: 'ELITE 8', homeScore: null, awayScore: null, status: 'scheduled'
});
const box = (cornell: string) => [
    stat('Ann Ace', cornell, { sourceGameId: 'cornell-1024', goals: 1 }),
    stat('Dee Dart', 'dartmouth', { sourceGameId: 'cornell-1024' })
];

describe('reconcile-identities', { skip: skipWithoutDb }, () => {
    let pool: Pool;
    before(async () => {
        pool = await freshDatabase();
        // As stored before the fix, then as the fixed rules load it.
        await loadSeason(pool, season([fixture('19-cornell'), placeholder], box('19-cornell')));
        const { rows: [old] } = await pool.query(`SELECT id FROM players WHERE identity_key = '19-cornell:annace'`);
        const { rows: [user] } = await pool.query(
            `INSERT INTO accounts.user_profiles (auth_provider, auth_subject, display_name) VALUES ('clerk', 'user_a', 'A') RETURNING id`);
        await pool.query(`INSERT INTO accounts.user_favorite_teams (user_id, team_id) SELECT $1, id FROM teams WHERE slug IN ('19-cornell', 'elite-8')`, [user.id]);
        await pool.query('INSERT INTO accounts.user_favorite_players (user_id, player_id) VALUES ($1, $2)', [user.id, old.id]);
        await loadSeason(pool, season([fixture('cornell')], box('cornell')));
    });
    after(async () => {
        await pool?.end();
    });

    test('a dry run reports orphans and their successors, and changes nothing', async () => {
        const report = await reconcileIdentities(pool, resolver(), false);
        assert.equal(report.applied, false);
        assert.deepEqual(report.teams.map(t => [t.slug, t.successor?.slug ?? null, t.favorites]).sort(),
            [['19-cornell', 'cornell', 1], ['elite-8', null, 1]]);
        assert.deepEqual(report.players.map(p => [p.identity_key, p.successor?.identity_key ?? null, p.favorites]),
            [['19-cornell:annace', 'cornell:annace', 1]]);
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM teams WHERE slug IN ('19-cornell', 'elite-8')`);
        assert.equal(rows[0].n, 2);
    });

    test('refuses to run while an ingestion run holds the lock', async () => {
        const lock = await IngestionLock.tryAcquire(pool);
        assert.ok(lock);
        try {
            await assert.rejects(reconcileIdentities(pool, resolver(), true), /holds the lock/);
        } finally {
            await lock?.release();
        }
    });

    test('applying moves favorites to the successor, removes the placeholder’s, audits each, and deletes the orphans', async () => {
        const report = await reconcileIdentities(pool, resolver(), true);
        assert.deepEqual(report.favorites, { teams_moved: 1, teams_removed: 1, players_moved: 1, players_removed: 0 });
        const { rows: favTeams } = await pool.query('SELECT t.slug FROM accounts.user_favorite_teams f JOIN teams t ON t.id = f.team_id');
        assert.deepEqual(favTeams.map(r => r.slug), ['cornell']);
        const { rows: favPlayers } = await pool.query('SELECT p.identity_key FROM accounts.user_favorite_players f JOIN players p ON p.id = f.player_id');
        assert.deepEqual(favPlayers.map(r => r.identity_key), ['cornell:annace']);
        const { rows: audit } = await pool.query(`SELECT action, actor FROM accounts.user_activity_audit ORDER BY action`);
        assert.deepEqual(audit.map(a => a.action), ['favorite.moved', 'favorite.moved', 'favorite.removed']);
        assert.ok(audit.every(a => a.actor === 'reconcile-identities'));
        const { rows: left } = await pool.query(`SELECT count(*)::int AS n FROM teams WHERE slug IN ('19-cornell', 'elite-8')`);
        assert.equal(left[0].n, 0);
        const { rows: spellings } = await pool.query(
            `SELECT count(*)::int AS n FROM source_identifiers s WHERE s.entity_type = 'team' AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = s.entity_id)`);
        assert.equal(spellings[0].n, 0, 'no spelling points at a deleted team');
    });

    test('a second run finds nothing to do', async () => {
        const report = await reconcileIdentities(pool, resolver(), true);
        assert.deepEqual([report.teams.length, report.players.length], [0, 0]);
    });
});
