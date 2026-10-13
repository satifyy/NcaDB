import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import {
    INGESTION_LOCK_KEY,
    IngestionLock,
    abandonOrphanedRuns,
    exportGameRows,
    exportPlayerStatRows,
    loadSeason,
    refreshReadModels,
    startRun
} from '../src';
import { batch, count, freshDatabase, game, skipWithoutDb, stat } from './helpers';

describe('season loader', { skip: skipWithoutDb }, () => {
    let pool: Pool;
    before(async () => {
        pool = await freshDatabase();
    });
    after(async () => {
        await pool?.end();
    });

    const duke = () => [stat('Ana Scorer', 'duke', { goals: 2, shots: 4, shotsOnGoal: 3 }), stat('Bo Keeper', 'duke', { saves: 5, jerseyNumber: '1' })];
    const clemson = () => [stat('Cy Striker', 'clemson', { goals: 1 }), stat('Di Wing', 'clemson')];

    test('inserts a new game with its box score', async () => {
        const result = await loadSeason(pool, batch(2025, [game()], [...duke(), ...clemson()]));
        assert.equal(result.games.inserted, 1);
        assert.equal(result.playerStats.inserted, 4);
        assert.equal(result.players.inserted, 4);
        const { rows } = await pool.query('SELECT boxscore_status, home_score, away_score FROM games');
        assert.deepEqual(rows[0], { boxscore_status: 'complete', home_score: 2, away_score: 1 });
        const totals = await pool.query(
            `SELECT t.slug, tg.goals, tg.reported_score, tg.goals_reconciliation
             FROM team_game_stats tg JOIN teams t ON t.id = tg.team_id ORDER BY t.slug`
        );
        assert.deepEqual(totals.rows, [
            { slug: 'clemson', goals: 1, reported_score: 1, goals_reconciliation: 'ok' },
            { slug: 'duke', goals: 2, reported_score: 2, goals_reconciliation: 'ok' }
        ]);
    });

    test('re-ingesting the same data changes nothing and duplicates nothing', async () => {
        const before = await Promise.all(['games', 'game_sources', 'players', 'player_game_stats'].map(t => count(pool, t)));
        const result = await loadSeason(pool, batch(2025, [game()], [...duke(), ...clemson()]));
        assert.deepEqual(result.games, { inserted: 0, updated: 0, unchanged: 1, deleted: 0 });
        assert.deepEqual(result.playerStats, { inserted: 0, updated: 0, unchanged: 4, deleted: 0 });
        const afterCounts = await Promise.all(['games', 'game_sources', 'players', 'player_game_stats'].map(t => count(pool, t)));
        assert.deepEqual(afterCounts, before);
    });

    test('a corrected score updates the game and its reconciliation', async () => {
        const result = await loadSeason(pool, batch(2025, [game({ homeScore: 3 })], [...duke(), ...clemson()]));
        assert.equal(result.games.updated, 1);
        const { rows } = await pool.query(
            `SELECT tg.reported_score, tg.goals_reconciliation FROM team_game_stats tg
             JOIN teams t ON t.id = tg.team_id WHERE t.slug = 'duke'`
        );
        // Two player goals against a corrected score of three: an own goal, not an error.
        assert.deepEqual(rows[0], { reported_score: 3, goals_reconciliation: 'unattributed' });
    });

    test('corrected player stats update in place, and a removed player is removed from that side only', async () => {
        const corrected = [stat('Ana Scorer', 'duke', { goals: 3, shots: 4, shotsOnGoal: 3 })]; // Bo Keeper dropped
        const result = await loadSeason(pool, batch(2025, [game({ homeScore: 3 })], [...corrected, ...clemson()]));
        assert.equal(result.playerStats.updated, 1);
        assert.equal(result.playerStats.deleted, 1);
        const { rows } = await pool.query(
            `SELECT p.display_name, s.goals FROM player_game_stats s JOIN players p ON p.id = s.player_id ORDER BY 1`
        );
        assert.deepEqual(rows.map(r => r.display_name), ['Ana Scorer', 'Cy Striker', 'Di Wing']);
        assert.equal(rows[0].goals, 3);
    });

    test('a side whose box score is absent from a batch keeps its stored rows', async () => {
        // Clemson's side failed to scrape this time: its rows are not in the batch.
        await loadSeason(pool, batch(2025, [game({ homeScore: 3 })], [stat('Ana Scorer', 'duke', { goals: 3, shots: 4, shotsOnGoal: 3 })]));
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM player_game_stats s JOIN teams t ON t.id = s.team_id WHERE t.slug = 'clemson'`
        );
        assert.equal(rows[0].n, 2);
    });

    test('missing values stay NULL rather than becoming zero', async () => {
        await loadSeason(pool, batch(2025, [game({ homeScore: 3 })], [stat('Ana Scorer', 'duke', { goals: 3, shots: 4, shotsOnGoal: 3, saves: null, minutes: null })], false));
        const { rows } = await pool.query(
            `SELECT minutes, saves FROM player_game_stats s JOIN players p ON p.id = s.player_id WHERE p.display_name = 'Ana Scorer'`
        );
        assert.deepEqual(rows[0], { minutes: null, saves: null });
        const exported = await exportPlayerStatRows(pool, 2025);
        const ana = exported.find(r => r.player_name === 'Ana Scorer')!;
        assert.equal(ana.saves, '');
        assert.equal(ana.minutes, '');
    });

    test('two schools’ rows for one fixture become one game, with disagreement flagged', async () => {
        const other = game({
            dedupeKey: '2025-09-05-Clemson-University-Duke',
            sourceGameId: 'wmt-2025-09-05-Clemson-Duke',
            homeSlug: 'clemson',
            awaySlug: 'duke',
            homeName: 'Clemson University',
            awayName: 'Duke',
            homeScore: 1,
            awayScore: 2, // Clemson's site says 2-1 Duke; Duke's (corrected) says 3-1
            locationType: 'away'
        });
        const result = await loadSeason(pool, batch(2025, [game({ homeScore: 3 }), other], []));
        assert.equal(await count(pool, 'games'), 1);
        assert.equal(await count(pool, 'game_sources'), 2);
        assert.ok(result.issues.some(i => i.code === 'score_conflict'));
        const { rows } = await pool.query('SELECT quality_flags FROM games');
        assert.deepEqual(rows[0].quality_flags, ['score_conflict']);
    });

    test('a transfer is a second player, linked to the first only by name', async () => {
        const nextSeason = game({
            dedupeKey: '2026-09-04-Duke-Indiana',
            sourceGameId: 'sidearm-2026-09-04-Indiana-Duke',
            date: '2026-09-04',
            homeSlug: 'indiana',
            awaySlug: 'duke',
            homeName: 'Indiana',
            awayName: 'Duke'
        });
        await loadSeason(pool, batch(2026, [nextSeason], [stat('Ana Scorer', 'indiana', { sourceGameId: nextSeason.sourceGameId })]));
        const { rows } = await pool.query(
            `SELECT p.identity_key, array_agg(s.year ORDER BY s.year) AS seasons
             FROM players p JOIN player_team_seasons pts ON pts.player_id = p.id JOIN seasons s ON s.id = pts.season_id
             WHERE p.display_name = 'Ana Scorer' GROUP BY p.identity_key ORDER BY 1`
        );
        assert.deepEqual(rows, [
            { identity_key: 'duke:anascorer', seasons: [2025] },
            { identity_key: 'indiana:anascorer', seasons: [2026] }
        ]);
    });

    test('box-score rows pointing at no known game are rejected and reported', async () => {
        const result = await loadSeason(pool, batch(2025, [game({ homeScore: 3 })], [stat('Ghost', 'duke', { sourceGameId: 'nope' })], false));
        assert.ok(result.issues.some(i => i.code === 'stat_unknown_game' && i.count === 1));
        // Not even an identity: a rejected row leaves no trace but the issue.
        assert.equal((await pool.query(`SELECT 1 FROM players WHERE display_name = 'Ghost'`)).rowCount, 0);
    });

    test('a failure part-way through a season rolls the whole season back', async () => {
        const before = await Promise.all(['games', 'player_game_stats'].map(t => count(pool, t)));
        const bad = game({ dedupeKey: '2025-09-12-Duke-Indiana', sourceGameId: 'g2', date: '2025-09-12', awaySlug: 'indiana', awayName: 'Indiana' });
        await assert.rejects(
            // 500 minutes violates the CHECK constraint, after the game itself was written.
            loadSeason(pool, batch(2025, [game({ homeScore: 3 }), bad], [stat('Ana Scorer', 'duke', { sourceGameId: 'g2', minutes: 500 })], false))
        );
        const afterCounts = await Promise.all(['games', 'player_game_stats'].map(t => count(pool, t)));
        assert.deepEqual(afterCounts, before);
    });

    test('exported game rows are the source rows exactly as loaded', async () => {
        const rows = await exportGameRows(pool, 2025);
        assert.equal(rows.length, 2);
        assert.ok(rows.every(r => typeof r.dedupe_key === 'string' && typeof r.game_id === 'string'));
    });

    test('read models refresh concurrently', async () => {
        await refreshReadModels(pool);
        const { rows } = await pool.query(
            `SELECT pss.goals FROM player_season_stats pss JOIN players p ON p.id = pss.player_id
             WHERE p.identity_key = 'duke:anascorer'`
        );
        assert.equal(rows[0].goals, 3);
    });
});

describe('ingestion lock and run recovery', { skip: skipWithoutDb }, () => {
    let pool: Pool;
    before(async () => {
        pool = await freshDatabase();
    });
    after(async () => {
        await pool?.end();
    });

    test('only one holder at a time, and released on demand', async () => {
        const first = await IngestionLock.tryAcquire(pool);
        assert.ok(first);
        assert.equal(await IngestionLock.tryAcquire(pool), null);
        await first.release();
        const again = await IngestionLock.tryAcquire(pool);
        assert.ok(again);
        await again.release();
    });

    test('a lock held by a connection that dies is released by Postgres', async () => {
        const other = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
        other.on('error', () => undefined); // the killed connection reports here
        const lock = await IngestionLock.tryAcquire(other);
        assert.ok(lock);
        assert.equal(await IngestionLock.tryAcquire(pool), null);
        // The process holding it crashes: its session ends without unlocking.
        await pool.query(
            `SELECT pg_terminate_backend(pid) FROM pg_locks
             WHERE locktype = 'advisory' AND objid = $1 AND granted
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
            [INGESTION_LOCK_KEY]
        );
        await new Promise(r => setTimeout(r, 300));
        const recovered = await IngestionLock.tryAcquire(pool);
        assert.ok(recovered);
        await recovered.release();
        await lock.release().catch(() => undefined);
        await other.end().catch(() => undefined);
    });

    test('runs left "running" by a dead process are marked abandoned', async () => {
        const id = await startRun(pool, 'nightly', 'cron', {});
        assert.equal(await abandonOrphanedRuns(pool), 1);
        const { rows } = await pool.query('SELECT status, finished_at FROM ingestion_runs WHERE id = $1', [id]);
        assert.equal(rows[0].status, 'abandoned');
        assert.ok(rows[0].finished_at);
    });
});
