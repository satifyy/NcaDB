/**
 * The worker CLI end to end, as a scheduler runs it: a separate process, configured only
 * by environment, that must exit with the right code and leave its history behind.
 *
 * Scraping is not exercised here (it needs the live sites); `--from-csv` feeds the same
 * load path the scrape stage's output goes through.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Pool } from 'pg';
import { IngestionLock } from '@ncaa/database';
import { freshDatabase, skipWithoutDb, TEST_DATABASE_URL } from '../../../packages/database/test/helpers';

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(__dirname, 'fixtures/repo');

function worker(...args: string[]) {
    const result = spawnSync(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'apps/worker/src/cli.ts'), ...args], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, LOG_LEVEL: 'warn', ALERT_WEBHOOK_URL: '' },
        encoding: 'utf8',
        timeout: 120_000
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('worker CLI', { skip: skipWithoutDb }, () => {
    let pool: Pool;
    before(async () => {
        pool = await freshDatabase();
    });
    after(async () => {
        await pool?.end();
    });

    const counts = async () => {
        const { rows } = await pool.query(
            `SELECT (SELECT count(*) FROM games)::int AS games, (SELECT count(*) FROM game_sources)::int AS sources,
                    (SELECT count(*) FROM players)::int AS players, (SELECT count(*) FROM player_game_stats)::int AS stats,
                    (SELECT count(*) FROM teams)::int AS teams`
        );
        return rows[0];
    };

    test('migrate is idempotent', () => {
        const result = worker('migrate');
        assert.equal(result.code, 0, result.stderr);
    });

    test('a backfill loads validated rows, exits 0 and records its run', async () => {
        const result = worker('backfill', '--season', '2025', '--from-csv', FIXTURE, '--no-analytics');
        assert.equal(result.code, 0, result.stderr);
        // Two schools' rows for Duke–Clemson merge; the bracket placeholder is refused.
        assert.deepEqual(await counts(), { games: 4, sources: 5, players: 5, stats: 6, teams: 4 });
        const { rows: runs } = await pool.query(`SELECT status, stats FROM ingestion_runs WHERE kind = 'backfill'`);
        assert.equal(runs[0].status, 'succeeded');
        assert.equal(runs[0].stats.totals.games_inserted, 4);
        const { rows: clemson } = await pool.query(
            `SELECT count(*)::int AS n FROM player_game_stats s JOIN teams t ON t.id = s.team_id WHERE t.slug = 'clemson'`
        );
        assert.equal(clemson[0].n, 2, '"CU" rows are attributed to Clemson from the fixture');
        const { rows: issues } = await pool.query(`SELECT code, count FROM ingestion_errors ORDER BY code`);
        const byCode = Object.fromEntries(issues.map(i => [i.code, i.count]));
        assert.equal(byCode.not_a_team, 1);
        assert.equal(byCode.placeholder_player, 1);
        assert.equal(byCode.stat_unknown_team, 1);
        const { rows: keeper } = await pool.query(
            `SELECT s.saves FROM player_game_stats s JOIN players p ON p.id = s.player_id WHERE p.display_name = 'Di Gloves'`
        );
        assert.equal(keeper[0].saves, null, 'an empty saves cell stays empty');
    });

    test('re-running the same request resumes (skips), and --force reloads without duplicating', async () => {
        const before = await counts();
        assert.equal(worker('backfill', '--season', '2025', '--from-csv', FIXTURE, '--no-analytics').code, 0);
        const forced = worker('backfill', '--season', '2025', '--from-csv', FIXTURE, '--no-analytics', '--force');
        assert.equal(forced.code, 0, forced.stderr);
        assert.deepEqual(await counts(), before);
        const { rows } = await pool.query(
            `SELECT stats->'totals' AS totals FROM ingestion_runs WHERE kind = 'backfill' ORDER BY id DESC LIMIT 1`
        );
        assert.equal(rows[0].totals.games_unchanged, 4);
        assert.equal(rows[0].totals.player_stats_unchanged, 6);
    });

    test('a second run while one holds the lock is recorded as skipped, not run', async () => {
        const lock = await IngestionLock.tryAcquire(pool);
        assert.ok(lock);
        try {
            const result = worker('backfill', '--season', '2025', '--from-csv', FIXTURE, '--no-analytics', '--force');
            assert.equal(result.code, 0);
            const { rows } = await pool.query(`SELECT status, error FROM ingestion_runs ORDER BY id DESC LIMIT 1`);
            assert.equal(rows[0].status, 'skipped');
        } finally {
            await lock.release();
        }
    });

    test('a failed run exits 1, is recorded, and is recovered by retry once the cause is fixed', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncadb-fixture-'));
        fs.cpSync(FIXTURE, dir, { recursive: true });
        try {
            // 2024 has no data yet: the load task fails.
            const failed = worker('backfill', '--season', '2024', '--from-csv', dir, '--no-analytics');
            assert.equal(failed.code, 1);
            const { rows } = await pool.query(`SELECT id::int, status, error FROM ingestion_runs ORDER BY id DESC LIMIT 1`);
            assert.equal(rows[0].status, 'failed');
            assert.match(rows[0].error, /no games\.csv rows for 2024/);

            const status = worker('status', '--run', String(rows[0].id));
            assert.equal(status.code, 0);
            assert.equal(JSON.parse(status.stdout).tasks[0].status, 'failed');

            // The cause is fixed (the season's files appear) and the failed run is retried.
            fs.mkdirSync(path.join(dir, 'data/games/2024'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'data/games/2024/games.csv'),
                'game_id,date,home_team_name,away_team_name,home_team_ranked,away_team_ranked,home_score,away_score,location_type,status,schedule_url,boxscore_url,boxscore_url_alt,dedupe_key,game_type\n' +
                    'g-2024,2024-09-06,Duke,Indiana,false,false,1,1,home,final,,,,2024-09-06-Duke-Indiana,regular\n'
            );
            const retried = worker('retry');
            assert.equal(retried.code, 0, retried.stderr);
            const { rows: last } = await pool.query(`SELECT status, trigger FROM ingestion_runs ORDER BY id DESC LIMIT 1`);
            assert.deepEqual(last[0], { status: 'succeeded', trigger: `retry:${rows[0].id}` });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('usage errors exit 2 without touching the database', () => {
        assert.equal(worker('backfill').code, 2);
        assert.equal(worker('no-such-command').code, 2);
    });
});
