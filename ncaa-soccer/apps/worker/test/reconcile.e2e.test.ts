/**
 * Removing identities no data refers to any more, after team names re-resolved
 * (issue #42). An apply touches only the reviewed targets: other orphans, rows in other
 * seasons and anything that drifted since the review stop it. Favorites move to the
 * surviving identity (or are removed) with an audit row, and a second run does nothing.
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
import { parseTargets, reconcileIdentities } from '../src/reconcile';
import type { ReconcileTargets } from '../src/reconcile';

const inventoryTeams: TeamConfig[] = [
    { team_id: 'CORNELL', name_canonical: 'Cornell', conference: 'Ivy', schedule_url: 'https://cornellbigred.com/sports/mens-soccer/schedule' },
    { team_id: 'DARTMOUTH', name_canonical: 'Dartmouth', conference: 'Ivy', schedule_url: 'https://dartmouthsports.com/sports/mens-soccer/schedule' }
];
function resolver(): TeamResolver {
    const index = new SchoolIndex<TeamConfig>();
    inventoryTeams.forEach(t => index.add(t));
    return new TeamResolver({ teams: inventoryTeams, index, unscraped: [], ambiguous: new Map() });
}

const teams: TeamRecord[] = [
    { slug: 'cornell', name: 'Cornell', inventoryId: 'CORNELL', isDivisionOne: true, conference: 'Ivy' },
    { slug: 'dartmouth', name: 'Dartmouth', inventoryId: 'DARTMOUTH', isDivisionOne: true, conference: 'Ivy' },
    { slug: '19-cornell', name: '19 Cornell', isDivisionOne: false },
    { slug: 'elite-8', name: 'ELITE 8', isDivisionOne: false },
    // An orphan from before the 2026 correction: out of scope, must survive.
    { slug: 'fpu', name: 'FPU', isDivisionOne: false }
];
const season = (year: number, games: GameSourceRecord[], stats: PlayerStatRecord[]): SeasonBatch =>
    ({ season: year, teams, teamSpellings: new Map(), games, stats, complete: true });
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
    const ids: Record<string, number> = {};
    let targets: ReconcileTargets;
    const count = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0].n as number;

    before(async () => {
        pool = await freshDatabase();
        // As stored before the fix, then as the fixed rules load it.
        await loadSeason(pool, season(2026, [fixture('19-cornell'), placeholder], box('19-cornell')));
        // A pre-existing orphan player, on a live team, from 2025.
        await loadSeason(pool, season(2025, [game({ dedupeKey: '2025-x', sourceGameId: 'old-1', date: '2025-09-05', homeSlug: 'cornell', awaySlug: 'dartmouth' })], [
            stat('Old Timer', 'cornell', { sourceGameId: 'old-1' })
        ]));
        await pool.query(`DELETE FROM player_game_stats WHERE player_id = (SELECT id FROM players WHERE identity_key = 'cornell:oldtimer')`);
        await pool.query(`INSERT INTO teams (sport_id, slug, name) SELECT sport_id, 'fpu', 'FPU' FROM teams LIMIT 1 ON CONFLICT DO NOTHING`);
        for (const [k, sql] of Object.entries({
            team19: `SELECT id FROM teams WHERE slug = '19-cornell'`, elite: `SELECT id FROM teams WHERE slug = 'elite-8'`,
            fpu: `SELECT id FROM teams WHERE slug = 'fpu'`, cornell: `SELECT id FROM teams WHERE slug = 'cornell'`,
            oldAnn: `SELECT id FROM players WHERE identity_key = '19-cornell:annace'`, oldTimer: `SELECT id FROM players WHERE identity_key = 'cornell:oldtimer'`
        })) ids[k] = Number((await pool.query(sql)).rows[0].id);

        const { rows: [user] } = await pool.query(
            `INSERT INTO accounts.user_profiles (auth_provider, auth_subject, display_name) VALUES ('clerk', 'user_a', 'A') RETURNING id`);
        await pool.query('INSERT INTO accounts.user_favorite_teams (user_id, team_id) VALUES ($1, $2), ($1, $3), ($1, $4)', [user.id, ids.team19, ids.elite, ids.fpu]);
        await pool.query('INSERT INTO accounts.user_favorite_players (user_id, player_id) VALUES ($1, $2), ($1, $3)', [user.id, ids.oldAnn, ids.oldTimer]);
        await loadSeason(pool, season(2026, [fixture('cornell')], box('cornell')));
        ids.newAnn = Number((await pool.query(`SELECT id FROM players WHERE identity_key = 'cornell:annace'`)).rows[0].id);
        targets = parseTargets(JSON.stringify({
            teams: [{ id: ids.team19, successor: ids.cornell }, { id: ids.elite, successor: null }],
            players: [{ id: ids.oldAnn, successor: ids.newAnn }]
        }));
    });
    after(async () => {
        await pool?.end();
    });

    test('without targets a dry run lists every orphan, and an apply is refused', async () => {
        const report = await reconcileIdentities(pool, resolver(), { apply: false });
        assert.deepEqual(report.teams.map(t => t.slug).sort(), ['19-cornell', 'elite-8', 'fpu']);
        assert.deepEqual(report.players.map(p => p.identity_key).sort(), ['19-cornell:annace', 'cornell:oldtimer']);
        await assert.rejects(reconcileIdentities(pool, resolver(), { apply: true }), /needs --targets/);
        await assert.rejects(reconcileIdentities(pool, resolver(), { apply: true, targets }), /needs --targets/, 'a season is required too');
    });

    test('with targets only the reviewed identities are in scope; other orphans are reported and untouched', async () => {
        const report = await reconcileIdentities(pool, resolver(), { apply: false, targets, season: 2026 });
        assert.deepEqual(report.problems, []);
        assert.deepEqual(report.teams.map(t => [t.slug, t.successor?.slug ?? null]).sort(), [['19-cornell', 'cornell'], ['elite-8', null]]);
        assert.deepEqual(report.players.map(p => [p.identity_key, p.successor?.identity_key]), [['19-cornell:annace', 'cornell:annace']]);
        assert.deepEqual(report.out_of_scope.teams.map(t => t.slug), ['fpu']);
        assert.deepEqual(report.out_of_scope.players.map(p => p.identity_key), ['cornell:oldtimer']);
        assert.ok(report.cascades.every(c => c.season === 2026));
    });

    test('a successor other than the reviewed one stops the apply and changes nothing', async () => {
        const drifted = { ...targets, teams: [{ id: ids.team19, successor: null }, targets.teams[1]] };
        const report = await reconcileIdentities(pool, resolver(), { apply: false, targets: drifted, season: 2026 });
        assert.match(report.problems.join('\n'), /would now map to/);
        await assert.rejects(reconcileIdentities(pool, resolver(), { apply: true, targets: drifted, season: 2026 }), /Refusing to apply/);
        assert.equal(await count(`SELECT count(*)::int AS n FROM teams WHERE id = $1`, [ids.team19]), 1);
    });

    test('a target that is in use is refused', async () => {
        const inUse = { ...targets, teams: [...targets.teams, { id: ids.cornell, successor: null }] };
        await assert.rejects(reconcileIdentities(pool, resolver(), { apply: true, targets: inUse, season: 2026 }), /team \d+ is a target but is in use/);
    });

    test('a row the delete would cascade to in another season is refused', async () => {
        const { rows: [s2025] } = await pool.query(`SELECT id FROM seasons WHERE year = 2025`);
        await pool.query('INSERT INTO player_team_seasons (player_id, team_id, season_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [ids.oldAnn, ids.team19, s2025.id]);
        try {
            const report = await reconcileIdentities(pool, resolver(), { apply: false, targets, season: 2026 });
            assert.match(report.problems.join('\n'), /player_team_seasons row\(s\) from 2025, outside 2026/);
            await assert.rejects(reconcileIdentities(pool, resolver(), { apply: true, targets, season: 2026 }), /Refusing to apply/);
        } finally {
            await pool.query('DELETE FROM player_team_seasons WHERE player_id = $1 AND season_id = $2', [ids.oldAnn, s2025.id]);
        }
    });

    test('refuses to run while an ingestion run holds the lock', async () => {
        const lock = await IngestionLock.tryAcquire(pool);
        assert.ok(lock);
        try {
            await assert.rejects(reconcileIdentities(pool, resolver(), { apply: true, targets, season: 2026 }), /holds the lock/);
        } finally {
            await lock?.release();
        }
    });

    test('applying removes only the targets, carries their favorites, audits each change and records what it removed', async () => {
        const report = await reconcileIdentities(pool, resolver(), { apply: true, targets, season: 2026 });
        assert.equal(report.applied, true);
        assert.deepEqual(report.favorites, { teams_moved: 1, teams_removed: 1, players_moved: 1, players_removed: 0 });
        assert.equal(report.removed?.teams.length, 2);
        assert.equal(report.removed?.players.length, 1);
        assert.equal(report.removed?.user_favorite_teams.length, 2);
        // In scope: gone, favorites carried.
        assert.equal(await count(`SELECT count(*)::int AS n FROM teams WHERE id = ANY($1)`, [[ids.team19, ids.elite]]), 0);
        const { rows: favTeams } = await pool.query('SELECT t.slug FROM accounts.user_favorite_teams f JOIN teams t ON t.id = f.team_id ORDER BY 1');
        assert.deepEqual(favTeams.map(r => r.slug), ['cornell', 'fpu']);
        const { rows: favPlayers } = await pool.query('SELECT p.identity_key FROM accounts.user_favorite_players f JOIN players p ON p.id = f.player_id ORDER BY 1');
        assert.deepEqual(favPlayers.map(r => r.identity_key), ['cornell:annace', 'cornell:oldtimer']);
        const { rows: audit } = await pool.query(`SELECT action, actor FROM accounts.user_activity_audit ORDER BY action`);
        assert.deepEqual(audit.map(a => a.action), ['favorite.moved', 'favorite.moved', 'favorite.removed']);
        assert.ok(audit.every(a => a.actor === 'reconcile-identities'));
        // Out of scope: still there, with their favorites.
        assert.equal(await count(`SELECT count(*)::int AS n FROM teams WHERE id = $1`, [ids.fpu]), 1);
        assert.equal(await count(`SELECT count(*)::int AS n FROM players WHERE id = $1`, [ids.oldTimer]), 1);
        assert.equal(await count(
            `SELECT count(*)::int AS n FROM source_identifiers s WHERE s.entity_type = 'team' AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = s.entity_id)`), 0);
    });

    test('running the same apply again does nothing and says the targets are already removed', async () => {
        const before = await count('SELECT count(*)::int AS n FROM accounts.user_activity_audit');
        const report = await reconcileIdentities(pool, resolver(), { apply: true, targets, season: 2026 });
        assert.deepEqual(report.problems, []);
        assert.deepEqual([report.teams.length, report.players.length], [0, 0]);
        assert.deepEqual(report.already_removed, { teams: [ids.team19, ids.elite].sort((a, b) => a - b), players: [ids.oldAnn] });
        assert.equal(await count('SELECT count(*)::int AS n FROM accounts.user_activity_audit'), before);
        assert.equal(await count(`SELECT count(*)::int AS n FROM teams WHERE id = $1`, [ids.fpu]), 1, 'out of scope still untouched');
    });

    test('a malformed targets file is rejected before anything runs', () => {
        assert.throws(() => parseTargets('{"teams": [{"id": "x", "successor": null}], "players": []}'), /integer "id"/);
        assert.throws(() => parseTargets('{"teams": []}'), /"players" must be a list/);
    });
});
