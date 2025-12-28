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

async function main() {
    const [, , gamesCsv = 'data/games/2025/games.csv', limitArg] = process.argv;
    const limit = limitArg ? Number(limitArg) : undefined;
    const csvPath = path.resolve(process.cwd(), gamesCsv);
    if (!fs.existsSync(csvPath)) {
        console.error(`games.csv not found at ${csvPath}`);
        process.exit(1);
    }

    let games = parseGamesCsv(csvPath).filter(g => g.boxscore_url);
    if (limit && !isNaN(limit)) {
        games = games.slice(0, limit);
    }
    console.log(`Loaded ${games.length} games with boxscore URLs from ${csvPath}${limit ? ` (limit ${limit})` : ''}`);

    const rawDir = path.resolve(__dirname, '../../../../data/raw');
    if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
    const boxParser = new SidearmBoxScoreParser();
    const rows: PlayerRow[] = [];

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
    });

    for (const g of games) {
        const boxUrl = g.boxscore_url!;
        console.log(`Fetching boxscore ${boxUrl} for ${g.date} ${g.home_team_name} vs ${g.away_team_name}`);
        try {
            await page.goto(boxUrl, { waitUntil: 'networkidle' });
            await page.waitForTimeout(1500);

            // Scroll to load any lazy-loaded content
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });
            await page.waitForTimeout(1000);

            // Try multiple selector patterns for the Individual Stats tab
            const tabSelectors = [
                'button:has-text("Individual Stats")',
                'button:has-text("Player Stats")',
                'button:has-text("Stats")',
                'button[aria-label*="Individual Stats" i]',
                'button[aria-label*="Player Stats" i]',
                'button[aria-label*="Stats" i]',
                'a:has-text("Individual Stats")',
                'a:has-text("Player Stats")',
                '[role="tab"]:has-text("Individual Stats")',
                '[role="tab"]:has-text("Player Stats")',
                '[role="tab"]:has-text("Stats")'
            ];

            let tabClicked = false;
            for (const selector of tabSelectors) {
                try {
                    const tab = await page.$(selector);
                    if (tab) {
                        console.log(`Found tab with selector: ${selector}`);
                        await tab.click();
                        tabClicked = true;

                        // CRITICAL: Wait for JavaScript to render the tables
                        // The page is a Nuxt.js SPA that hydrates tables from JSON data
                        // We need to wait for actual table rows to appear, not just the table elements
                        console.log(`Waiting for tables to be populated by JavaScript...`);

                        // Wait for network to be idle after clicking tab (ensures Vue.js hydration completes)
                        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
                            console.warn('Network did not become idle, but continuing...');
                        });

                        // Give extra time for Vue.js to render the tables
                        await page.waitForTimeout(3000);

                        // Try to wait for table content with actual player data (position like "gk" or "mid")
                        try {
                            await page.waitForSelector('table tbody tr td:has-text("gk"), table tbody tr td:has-text("mid")', { timeout: 5000 });
                            console.log(`Tables with player position data detected`);
                        } catch (error: any) {
                            console.warn(`Could not detect player position data - HTML may not be fully hydrated`);
                        }

                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            if (!tabClicked) {
                console.warn('No Individual/Player Stats tab found; attempting to parse visible content');
            }

            // Scroll again after clicking tab to ensure tables are visible
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });
            await page.waitForTimeout(1000);

            // Try multiple table selector patterns
            const tableSelectors = [
                'table.sidearm-table',
                'table.overall-stats',
                'table[class*="stats"]',
                'table[class*="player"]',
                '.stats-table table',
                '.player-stats table',
                'table tbody tr',
                'table'
            ];

            let tableFound = false;
            for (const selector of tableSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 3000 });
                    console.log(`Found table with selector: ${selector}`);
                    tableFound = true;
                    break;
                } catch (e) {
                    // Try next selector
                }
            }

            if (!tableFound) {
                console.warn('No stats tables detected; saving HTML anyway for inspection');
            }

            // CRITICAL: Get the RENDERED HTML from the live DOM, not the source HTML
            // page.content() returns the original source before JavaScript runs
            // We need the actual rendered DOM after Vue.js hydration
            const html = await page.evaluate(() => document.documentElement.outerHTML);

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const rawPath = path.join(rawDir, `${timestamp}_boxscore_${g.dedupe_key}.html`);
            fs.writeFileSync(rawPath, html, 'utf8');
            console.log(`Saved HTML to ${rawPath}`);

            // Debug: Check what tabs and tables exist in the page
            const debugInfo = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim());
                const tables = document.querySelectorAll('table');
                const tableInfo = Array.from(tables).map(t => ({
                    classes: t.className,
                    rows: t.querySelectorAll('tr').length
                }));
                return { buttons, tableCount: tables.length, tableInfo };
            });
            console.log('Page debug info:', JSON.stringify(debugInfo, null, 2));

            const res = boxParser.parse(html, { sourceUrl: boxUrl });
            res.playerStats.forEach(p => {
                rows.push({
                    game_id: g.game_id,
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
                });
            });
            console.log(`Parsed ${res.playerStats.length} player rows`);
            if (res.playerStats.length > 0) {
                console.log('DEBUG First Player:', JSON.stringify(res.playerStats[0], null, 2));
            }
        } catch (e: any) {
            console.error(`Failed ${boxUrl}: ${e.message}`);
        }
    }

    await browser.close();

    const year = games[0]?.date?.split('-')[0] || 'unknown';
    const statsDir = path.resolve(__dirname, '../../../../data/player_stats', year);
    fs.mkdirSync(statsDir, { recursive: true });
    const outPath = path.join(statsDir, 'player_stats.csv');

    const header = [
        'game_id', 'team_id', 'player_name', 'player_key', 'jersey_number',
        'minutes', 'goals', 'assists', 'shots', 'shots_on_goal', 'saves'
    ];
    const lines = [header.join(',')];
    rows.forEach(r => {
        const vals = [
            r.game_id,
            r.team_id,
            r.player_name,
            r.player_key,
            r.jersey_number ?? '',
            r.minutes ?? '',
            r.goals ?? '',
            r.assists ?? '',
            r.shots ?? '',
            r.shots_on_goal ?? '',
            r.saves ?? ''
        ];
        lines.push(vals.map(v => escapeCsv(String(v))).join(','));
    });

    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log(`Wrote ${rows.length} player rows to ${outPath}`);
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
    console.error('fetch_boxscores_from_csv failed:', err);
    process.exit(1);
});
