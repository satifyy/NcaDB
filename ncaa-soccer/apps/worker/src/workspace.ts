/**
 * The scrapers' working tree.
 *
 * The scrapers read and write `data/` under `NCAA_REPO_ROOT`. On a server that tree is
 * empty at every start, and locally it must not be the checkout (whose committed CSVs a
 * run would overwrite), so the worker builds a scratch tree: the team inventory and the
 * fitted model copied from the code, and the season's rows written out from the database.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { GAME_COLUMNS, PLAYER_STAT_COLUMNS, exportGameRows, exportPlayerStatRows } from '@ncaa/database';
import { headerFrom, readAllIfExists, writeRows } from '@ncaa/storage';
import type { GameCsvRow, PlayerStatCsvRow } from '@ncaa/storage';
import { WorkerConfig } from './config';

export const gamesFile = (root: string, season: number) => path.join(root, 'data/games', String(season), 'games.csv');
export const statsFile = (root: string, season: number) =>
    path.join(root, 'data/player_stats', String(season), 'player_stats.csv');
export const inventoryFile = (root: string) => path.join(root, 'data/teams/d1_msoc_teams.json');
export const teamsDir = (root: string) => path.join(root, 'data/teams');
export const dashboardDataDir = (root: string) => path.join(root, 'apps/dashboard/src/data');

/**
 * Copies file contents into newly created files.
 *
 * Not `fs.cpSync`: that preserves permissions, and the image's code is read-only to the
 * runtime user, so the copies came out read-only too — and the second preparation in a
 * run (hydrate, then analytics) failed with EACCES writing into them.
 *
 * Symlinks are refused on both sides and each file is created exclusively (`wx`), so a
 * link planted in the scratch tree cannot redirect a write elsewhere.
 */
function copyWritable(from: string, to: string): void {
    // One descriptor for both the type check and the read, so the file checked is the
    // file copied. O_NOFOLLOW makes opening a symlink fail (ELOOP).
    const fd = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let content: Buffer;
    try {
        if (fs.fstatSync(fd).isDirectory()) {
            fs.mkdirSync(to, { recursive: true, mode: 0o700 });
            for (const entry of fs.readdirSync(from)) copyWritable(path.join(from, entry), path.join(to, entry));
            return;
        }
        content = fs.readFileSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.rmSync(to, { force: true });
    fs.writeFileSync(to, content, { flag: 'wx', mode: 0o600 });
}

/**
 * Creates the work directory private to this user, or checks an existing one is.
 *
 * It defaults to a fixed path under the shared temp directory, so another local user
 * could otherwise create it first (or as a symlink) and read or swap the scrapers' files.
 */
export function ensurePrivateDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Work directory ${dir} is not a plain directory`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`Work directory ${dir} is owned by another user`);
    }
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** Creates the scratch tree with the inventory and the fitted model in place. */
export function prepareWorkDir(config: WorkerConfig): void {
    ensurePrivateDir(config.workDir);
    fs.mkdirSync(path.join(config.workDir, 'data'), { recursive: true, mode: 0o700 });
    copyWritable(teamsDir(config.codeRoot), teamsDir(config.workDir));
    const model = path.join(config.codeRoot, 'data/ratings/model.json');
    if (fs.existsSync(model)) {
        copyWritable(model, path.join(config.workDir, 'data/ratings/model.json'));
    }
    // Stage progress from an earlier process means nothing here: every run starts from
    // what the database holds, not from what a previous container left on disk.
    fs.rmSync(path.join(config.workDir, 'data/pipeline_state.json'), { force: true });
}

/** Writes a season's rows from the database into the scratch tree. */
export async function hydrateSeason(
    pool: Pool,
    root: string,
    season: number
): Promise<{ games: number; stats: number }> {
    const games = await exportGameRows(pool, season);
    const stats = await exportPlayerStatRows(pool, season);
    const gPath = gamesFile(root, season);
    const sPath = statsFile(root, season);
    fs.rmSync(gPath, { force: true });
    fs.rmSync(sPath, { force: true });
    // A season the database has never seen stays absent, which the scrapers read as
    // "nothing stored yet" — exactly what a first scrape should see.
    if (games.length > 0) writeRows(gPath, games, headerFrom(games, GAME_COLUMNS));
    if (stats.length > 0) writeRows(sPath, stats, PLAYER_STAT_COLUMNS);
    return { games: games.length, stats: stats.length };
}

export function readSeason(root: string, season: number): { games: GameCsvRow[]; stats: PlayerStatCsvRow[] } {
    return {
        games: readAllIfExists<GameCsvRow>(gamesFile(root, season), { relaxColumnCount: true }),
        stats: readAllIfExists<PlayerStatCsvRow>(statsFile(root, season), { relaxColumnCount: true })
    };
}

/** Every `.json` under the dashboard data directory, keyed by its path relative to it. */
export function collectDashboardArtifacts(root: string): { key: string; content: string }[] {
    const base = dashboardDataDir(root);
    const out: { key: string; content: string }[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.json')) {
                out.push({ key: path.relative(base, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
            }
        }
    };
    walk(base);
    return out.sort((a, b) => a.key.localeCompare(b.key));
}

export interface StageState {
    status: 'ok' | 'failed';
    rows?: { before: number; after: number };
}

/** What `run_pipeline.ts` recorded for a season, read back after it exits. */
export function pipelineState(root: string, season: number): Record<string, StageState> {
    try {
        const state = JSON.parse(fs.readFileSync(path.join(root, 'data/pipeline_state.json'), 'utf8'));
        return state.seasons?.[season] ?? {};
    } catch {
        return {};
    }
}
