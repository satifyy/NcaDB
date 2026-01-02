// @ts-nocheck
import * as fs from 'fs';
import * as path from 'path';
import { SidearmBoxScoreParser } from '../../../../packages/parsers/src';
const { chromium } = require('playwright-chromium');

interface GameRow {
    game_id: string;
    date: string;
    home_team_name: string;
    away_team_name: string;
    boxscore_url?: string;
    dedupe_key: string;
}

interface PlayerRow {
    game_id: string;
    team_id: string;
    player_name: string;
    player_key: string;
    jersey_number: string | null;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    shots: number | null;
    shots_on_goal: number | null;
    saves: number | null;
}

interface ProcessResult {
    rows: PlayerRow[];
    success: boolean;
}

// Configuration
const BATCH_SIZE = 120; // Restart browser after this many games to free memory
const CONCURRENCY = 8; // Number of parallel tabs (safer; raise cautiously if stable)
const DEBUG_LOG_PATH = path.resolve(process.cwd(), 'data/player_stats/debug_boxscore.log');
const VIEWPORT = { width: 1280, height: 720 };

function parseGamesCsv(csvPath: string): GameRow[] {
    const text = fs.readFileSync(csvPath, 'utf8');
    const lines = text.trim().split(/\r?\n/);
    if (lines.length === 0) return [];
    const header = lines[0].split(',');
    const idx = (name: string) => header.indexOf(name);
    const games: GameRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        const row: GameRow = {
            game_id: parts[idx('game_id')] || '',
            date: parts[idx('date')] || '',
            home_team_name: parts[idx('home_team_name')] || '',
            away_team_name: parts[idx('away_team_name')] || '',
            boxscore_url: parts[idx('boxscore_url')] || '',
            dedupe_key: parts[idx('dedupe_key')] || ''
        };
        games.push(row);
    }
    return games;
}

function ensureDebugLogDir() {
    const dir = path.dirname(DEBUG_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function logDebug(message: string) {
    ensureDebugLogDir();
    const stamp = new Date().toISOString();
    fs.appendFileSync(DEBUG_LOG_PATH, `[${stamp}] ${message}\n`);
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const s = (totalSeconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}

interface StatusState {
    total: number;
    success: number;
    failed: number;
    inFlight: number;
    start: number;
}

let lastStatusLines = 0;

function renderStatus(status: StatusState) {
    const elapsed = formatDuration(Date.now() - status.start);
    const queued = Math.max(status.total - status.success - status.failed - status.inFlight, 0);
    const lines = [
        `Games total: ${status.total}`,
        `Finished: ${status.success} ok | Failed: ${status.failed}`,
        `In progress: ${status.inFlight}`,
        `Queued: ${queued}`,
        `Elapsed: ${elapsed}`
    ];

    // Move cursor up to previous block, clear it, then write the fresh block so nothing piles up
    if (lastStatusLines > 0) {
        process.stdout.write(`\u001b[${lastStatusLines}A`); // move cursor up
        process.stdout.write('\u001b[0J'); // clear from cursor down
    }

    process.stdout.write(lines.join('\n') + '\n');
    lastStatusLines = lines.length;
}

function startStatusTicker(status: StatusState) {
    renderStatus(status); // initial render
    return setInterval(() => renderStatus(status), 1000);
}

async function processGame(
    browser: any,
    game: GameRow,
    rawDir: string,
    boxParser: SidearmBoxScoreParser,
    opts?: { attempt?: number; waitLonger?: boolean; waitMs?: number; scrollWaitMs?: number }
): Promise<ProcessResult> {
    const boxUrl = game.boxscore_url!;
    const attempt = opts?.attempt ?? 1;
    const waitLonger = opts?.waitLonger ?? false;
    const waitMs = opts?.waitMs ?? 1200;
    const scrollWaitMs = opts?.scrollWaitMs ?? 800;

    let page;
    try {
        page = await browser.newPage({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
            viewport: VIEWPORT
        });

        // Block heavy/irrelevant resources to reduce load time and flakiness
        await page.route('**/*', (route: any) => {
            const req = route.request();
            const type = req.resourceType();
            const url = req.url();
            const isHeavy = type === 'image' || type === 'media' || type === 'font';
            const isAnalytics = /google-analytics|gtag|segment|facebook|doubleclick|scorestream|snapchat|quantserve|googletagmanager|adservice|adzerk/i.test(url);
            if (isHeavy || isAnalytics) {
                return route.abort();
            }
            return route.continue();
        });

        // Fast navigation
        await page.goto(boxUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(waitLonger ? Math.max(waitMs, 2000) : waitMs);

        // Scroll once
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(waitLonger ? Math.max(scrollWaitMs, 1200) : scrollWaitMs);

        // Quick check for tab
        const tabSelectors = [
            'button:has-text("Individual Stats")',
            'button:has-text("Player Stats")',
            'button:has-text("Individual")', // Some sites label the tab simply as "Individual"
            '[role="tab"]:has-text("Individual")',
            '[role="tab"]:has-text("Stats")'
        ];

        let tabClicked = false;
        for (const selector of tabSelectors) {
            const tab = await page.$(selector);
            if (tab) {
                await tab.click();
                tabClicked = true;
                // Wait for hydration - optimized
                await page.waitForTimeout(waitLonger ? 2500 : 1500);
                // Also wait briefly for a stats table to appear to reduce blank grabs
                await page.waitForSelector('table.advanced-table__table, table.sidearm-table, table.w-full', { timeout: 2000 }).catch(() => {});
                break;
            }
        }

        // Just grab HTML now - assume it loaded or failed
        const html = await page.evaluate(() => document.documentElement.outerHTML);

        // NOTE: HTML file saving has been removed to save disk space as requested.

        let res = boxParser.parse(html, { sourceUrl: boxUrl });

        // If first attempt found nothing, wait briefly and re-parse once before giving up this attempt
        if (res.playerStats.length === 0 && attempt === 1) {
            await page.waitForTimeout(waitLonger ? 1200 : 1000);
            const htmlRetry = await page.evaluate(() => document.documentElement.outerHTML);
            res = boxParser.parse(htmlRetry, { sourceUrl: boxUrl });
        }

        await page.close(); // Critical: close page immediately

        if (res.playerStats.length > 0) {
            logDebug(`OK [${game.game_id}] Parsed ${res.playerStats.length} stats (attempt ${attempt})`);
            const rows = res.playerStats.map(p => ({
                game_id: game.game_id,
                team_id: p.team_id,
                player_name: p.player_name,
                player_key: p.player_key,
                jersey_number: p.jersey_number ?? null,
                minutes: p.minutes ?? null,
                goals: (p as any).goals ?? null,
                assists: (p as any).assists ?? null,
                shots: (p as any).shots ?? null,
                shots_on_goal: toNumber(p.stats?.shots_on_goal),
                saves: toNumber(p.stats?.saves)
            }));
            return { rows, success: true };
        } else {
            logDebug(`WARN [${game.game_id}] No stats found (attempt ${attempt})`);
            return { rows: [], success: false };
        }

    } catch (e: any) {
        logDebug(`ERR [${game.game_id}] Failed: ${e.message}`);
        if (page) await page.close().catch(() => { });
        return { rows: [], success: false };
    }
}

async function main() {
    const startTotal = Date.now();
    const [, , gamesCsv = 'data/games/2025/games.csv', limitArg] = process.argv;
    const limit = limitArg ? Number(limitArg) : undefined;
    const csvPath = path.resolve(process.cwd(), gamesCsv);

    if (!fs.existsSync(csvPath)) {
        console.error(`games.csv not found at ${csvPath}`);
        process.exit(1);
    }

    let games = parseGamesCsv(csvPath).filter(g => g.boxscore_url);

    // --- DEDUPLICATION LOGIC ---
    // Rule: Teams are only allowed one game per day.
    const processedSet = new Set<string>();
    const uniqueGames: GameRow[] = [];
    const removedDuplicates: { reason: string; game: GameRow }[] = [];

    for (const g of games) {
        const d = g.date.trim();
        const t1 = g.home_team_name.trim();
        const t2 = g.away_team_name.trim();

        // Keys: Date-Team
        const k1 = `${d}|${t1}`;
        const k2 = `${d}|${t2}`;

        // If EITHER team has been seen on this date, this game is a duplicate
        if (processedSet.has(k1) || processedSet.has(k2)) {
            removedDuplicates.push({ reason: 'team-date duplicate', game: g });
            continue;
        }

        processedSet.add(k1);
        processedSet.add(k2);
        uniqueGames.push(g);
    }
    games = uniqueGames;
    // ---------------------------

    if (limit && !isNaN(limit)) {
        games = games.slice(0, limit);
    }
    logDebug(`Loading ${games.length} games to process... (Removed ${removedDuplicates.length} duplicates of existing team-dates)`);
    if (removedDuplicates.length > 0) {
        logDebug('Duplicate removals:');
        removedDuplicates.forEach(({ game }) => {
            logDebug(` - ${game.date} ${game.home_team_name} vs ${game.away_team_name} (box=${game.boxscore_url || 'none'})`);
        });
    }

    const rawDir = path.resolve(__dirname, '../../../../data/raw');
    if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

    const boxParser = new SidearmBoxScoreParser();
    const allRows: PlayerRow[] = [];
    const failedGames: GameRow[] = [];
    const status: StatusState = {
        total: games.length,
        success: 0,
        failed: 0,
        inFlight: 0,
        start: startTotal
    };

    const statusTimer = startStatusTicker(status);

    // Process in Batches
    for (let i = 0; i < games.length; i += BATCH_SIZE) {
        const batch = games.slice(i, i + BATCH_SIZE);
        logDebug(`Starting Batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} games)...`);

        // Launch Browser for this batch
        const browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const batchFailures: GameRow[] = [];

        // specific concurrency logic
        // We will execute 'CONCURRENCY' promises at a time from the batch
        for (let j = 0; j < batch.length; j += CONCURRENCY) {
            const chunk = batch.slice(j, j + CONCURRENCY);
            status.inFlight = chunk.length;
            const promises = chunk.map(game => processGame(browser, game, rawDir, boxParser));
            const results = await Promise.all(promises);
            results.forEach((res, idx) => {
                allRows.push(...res.rows);
                if (!res.success) {
                    batchFailures.push(chunk[idx]);
                    status.failed += 1;
                } else {
                    status.success += 1;
                }
            });
            status.inFlight = 0;
        }

        if (batchFailures.length > 0) {
            logDebug(`Retrying ${batchFailures.length} games with longer waits...`);
            const secondFailures: GameRow[] = [];
            for (let j = 0; j < batchFailures.length; j += CONCURRENCY) {
                const retryChunk = batchFailures.slice(j, j + CONCURRENCY);
                status.inFlight = retryChunk.length;
                const retryPromises = retryChunk.map(game => processGame(browser, game, rawDir, boxParser, { attempt: 2, waitLonger: true }));
                const retryResults = await Promise.all(retryPromises);
                retryResults.forEach((res, idx) => {
                    allRows.push(...res.rows);
                    if (!res.success) {
                        secondFailures.push(retryChunk[idx]);
                    } else {
                        status.success += 1;
                    }
                });
                status.inFlight = 0;
            }

            // Third retry with extra waits for the remaining failures
            if (secondFailures.length > 0) {
                logDebug(`Retrying ${secondFailures.length} games with extra-long waits...`);
                for (let j = 0; j < secondFailures.length; j += CONCURRENCY) {
                    const retryChunk = secondFailures.slice(j, j + CONCURRENCY);
                    status.inFlight = retryChunk.length;
                    const retryPromises = retryChunk.map(game => processGame(browser, game, rawDir, boxParser, { attempt: 3, waitLonger: true, waitMs: 3000, scrollWaitMs: 2000 }));
                    const retryResults = await Promise.all(retryPromises);
                    retryResults.forEach((res, idx) => {
                        allRows.push(...res.rows);
                        if (!res.success) {
                            failedGames.push(retryChunk[idx]);
                            status.failed += 1;
                        } else {
                            status.success += 1;
                        }
                    });
                    status.inFlight = 0;
                }
            }
        }

        await browser.close();
        logDebug(`Batch ${Math.floor(i / BATCH_SIZE) + 1} complete. Memory cleared.`);
    }

    // Write Output
    const year = games[0]?.date?.split('-')[0] || '2025';
    const statsDir = path.resolve(__dirname, '../../../../data/player_stats', year);
    if (!fs.existsSync(statsDir)) fs.mkdirSync(statsDir, { recursive: true });
    const outPath = path.join(statsDir, 'player_stats.csv');

    const header = [
        'game_id', 'team_id', 'player_name', 'player_key', 'jersey_number',
        'minutes', 'goals', 'assists', 'shots', 'shots_on_goal', 'saves'
    ];
    const lines = [header.join(',')];
    allRows.forEach(r => {
        const vals = [
            r.game_id, r.team_id, r.player_name, r.player_key, r.jersey_number ?? '',
            r.minutes ?? '', r.goals ?? '', r.assists ?? '', r.shots ?? '',
            r.shots_on_goal ?? '', r.saves ?? ''
        ];
        lines.push(vals.map(v => escapeCsv(String(v))).join(','));
    });

    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

    const duration = (Date.now() - startTotal) / 1000;
    logDebug(`DONE! Processed ${games.length} games in ${duration.toFixed(1)}s`);
    logDebug(`Stats written to ${outPath}`);

    if (failedGames.length > 0) {
        const failDir = path.resolve(__dirname, '../../../../data/player_stats');
        if (!fs.existsSync(failDir)) fs.mkdirSync(failDir, { recursive: true });
        const failLogPath = path.join(failDir, 'failed_boxscores.log');
        const failLines = failedGames.map(g => `${g.game_id},${g.date},${g.home_team_name} vs ${g.away_team_name},${g.boxscore_url ?? ''}`);
        fs.writeFileSync(failLogPath, failLines.join('\n'), 'utf8');
        logDebug(`WARN ${failedGames.length} games still missing stats after retry. Logged to ${failLogPath}`);
    }

    status.inFlight = 0;
    renderStatus(status);
    clearInterval(statusTimer);
}

function escapeCsv(field: string): string {
    if (field === undefined || field === null) return '';
    if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        return `"${field.replace(/"/g, '""')}"`;
    }
    return field;
}

function toNumber(val: any): number | null {
    if (val === undefined || val === null) return null;
    const num = Number(val);
    return isNaN(num) ? null : num;
}

main().catch(err => {
    console.error('Fatal error:', err);
});
