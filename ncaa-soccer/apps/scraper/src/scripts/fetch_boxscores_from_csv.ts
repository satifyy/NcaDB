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

// Configuration
const BATCH_SIZE = 50; // Restart browser after this many games to free memory
const CONCURRENCY = 5; // Number of parallel tabs
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

async function processGame(browser: any, game: GameRow, rawDir: string, boxParser: SidearmBoxScoreParser): Promise<PlayerRow[]> {
    const boxUrl = game.boxscore_url!;

    let page;
    try {
        page = await browser.newPage({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
            viewport: VIEWPORT
        });

        // Fast navigation
        await page.goto(boxUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(800);

        // Scroll once
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);

        // Quick check for tab
        const tabSelectors = [
            'button:has-text("Individual Stats")',
            'button:has-text("Player Stats")',
            '[role="tab"]:has-text("Stats")'
        ];

        let tabClicked = false;
        for (const selector of tabSelectors) {
            const tab = await page.$(selector);
            if (tab) {
                await tab.click();
                tabClicked = true;
                // Wait for hydration - optimized
                await page.waitForTimeout(1500);
                break;
            }
        }

        // Just grab HTML now - assume it loaded or failed
        const html = await page.evaluate(() => document.documentElement.outerHTML);

        // NOTE: HTML file saving has been removed to save disk space as requested.

        const res = boxParser.parse(html, { sourceUrl: boxUrl });

        await page.close(); // Critical: close page immediately

        if (res.playerStats.length > 0) {
            console.log(`✅ [${game.game_id}] Parsed ${res.playerStats.length} stats`);
            return res.playerStats.map(p => ({
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
        } else {
            console.warn(`⚠️ [${game.game_id}] No stats found`);
            return [];
        }

    } catch (e: any) {
        console.error(`❌ [${game.game_id}] Failed: ${e.message}`);
        if (page) await page.close().catch(() => { });
        return [];
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
    let dupeCount = 0;

    for (const g of games) {
        const d = g.date.trim();
        const t1 = g.home_team_name.trim();
        const t2 = g.away_team_name.trim();

        // Keys: Date-Team
        const k1 = `${d}|${t1}`;
        const k2 = `${d}|${t2}`;

        // If EITHER team has been seen on this date, this game is a duplicate
        if (processedSet.has(k1) || processedSet.has(k2)) {
            dupeCount++;
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
    console.log(`🚀 Loading ${games.length} games to process... (Removed ${dupeCount} duplicates of existing team-dates)`);

    const rawDir = path.resolve(__dirname, '../../../../data/raw');
    if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

    const boxParser = new SidearmBoxScoreParser();
    const allRows: PlayerRow[] = [];

    // Process in Batches
    for (let i = 0; i < games.length; i += BATCH_SIZE) {
        const batch = games.slice(i, i + BATCH_SIZE);
        console.log(`\nStarting Batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} games)...`);

        // Launch Browser for this batch
        const browser = await chromium.launch({
            headless: true,
            args: ['--disable-dev-shm-usage', '--no-sandbox']
        });

        // specific concurrency logic
        // We will execute 'CONCURRENCY' promises at a time from the batch
        for (let j = 0; j < batch.length; j += CONCURRENCY) {
            const chunk = batch.slice(j, j + CONCURRENCY);
            const promises = chunk.map(game => processGame(browser, game, rawDir, boxParser));
            const results = await Promise.all(promises);
            results.forEach(rows => allRows.push(...rows));
        }

        await browser.close();
        console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1} complete. Memory cleared.`);
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
    console.log(`\n✨ DONE! Processed ${games.length} games in ${duration.toFixed(1)}s`);
    console.log(`Stats written to ${outPath}`);
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
