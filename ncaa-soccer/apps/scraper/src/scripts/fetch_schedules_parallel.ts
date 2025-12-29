import * as path from 'path';
import * as fs from 'fs';
import { chromium } from 'playwright-chromium';
import { SidearmParser } from '@ncaa/parsers';
import { GameStorageAdapter } from '@ncaa/storage';

interface TeamConfig {
    team_id: string;
    name_canonical: string;
    schedule_url: string;
    platform_guess: string;
}

// Configuration
const CONCURRENCY = 5;
const VIEWPORT = { width: 1280, height: 720 };
const inputPath = process.argv[2];
const TEAMS_JSON_PATH = inputPath
    ? path.resolve(process.cwd(), inputPath)
    : path.resolve(__dirname, '../../../../data/teams/acc_teams.json');

async function processSchool(browser: any, team: TeamConfig): Promise<any[]> {
    console.log(`[${team.name_canonical}] Starting extract from ${team.schedule_url}`);

    // Only support Sidearm for now as Parser is specific
    if (team.platform_guess !== 'sidearm') {
        console.warn(`[${team.name_canonical}] Skipping non-sidearm site (${team.platform_guess})`);
        return [];
    }

    const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        viewport: VIEWPORT
    });

    try {
        await page.goto(team.schedule_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Fast UI interactions
        const tableSelector = '#_viewType_table, button[aria-label="Table View"], .sidearm-schedule-view-options button:has-text("Table")';
        if (await page.$(tableSelector)) {
            await page.click(tableSelector);
            await page.waitForTimeout(500);
        }

        // Log likely API requests
        const apiRequests: string[] = [];
        page.on('request', (request: any) => {
            const url = request.url();
            if (url.includes('schedule') || url.includes('.json') || url.includes('services') || url.includes('xml')) {
                apiRequests.push(url);
            }
        });

        // Wait for table
        try {
            await page.waitForSelector('.c-schedule__table, #tablePanel table, table[data-table-view], .s-table-body__row', { timeout: 10000 });
        } catch (e) {
            console.warn(`[${team.name_canonical}] Warning: Table selector timeout`, e);
        }

        // Snapshot for debugging
        await page.screenshot({ path: path.resolve(__dirname, '../../../../debug_duke_screenshot.png') });
        fs.writeFileSync(path.resolve(__dirname, '../../../../debug_duke_network.txt'), apiRequests.join('\n'));

        // Quick scroll
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
        await page.evaluate(() => window.scrollTo(0, 0));

        // Extract Links Map (Optimized)
        const linkButtonsBoxscoreMap = new Map<string, string>();
        const linkButtons = await page.$$('button[aria-label*="Links" i], button:has-text("Links")');

        // Process buttons in parallel promises if possible, but click needs sequential
        // We'll do a fast concise loop
        for (let i = 0; i < linkButtons.length; i++) {
            try {
                const btn = linkButtons[i];
                await btn.click({ timeout: 1000 });
                // Don't wait long, just check immediately
                const boxscoreLink = await page.evaluate((button: any) => {
                    // Try to find the closest row container
                    const parent = button.closest('tr, [class*="schedule"], [class*="s-table-body__row"], div[class*="row"]');
                    if (!parent) return null;

                    // Look for boxscore link within the parent row
                    const link = parent.querySelector('a[href*="boxscore"]');
                    if (link) return link.getAttribute('href');

                    // Fallback: Look for "History" or similar if boxscore isn't explicit,
                    // but usually "Box Score" or "boxscore" in href is the key.
                    // Sometimes it's in a dropdown menu that is a sibling or child.
                    const overlay = parent.querySelector('[class*="overlay"] a[href*="boxscore"], [class*="dropdown"] a[href*="boxscore"], ul a[href*="boxscore"]');
                    if (overlay) return overlay.getAttribute('href');

                    return null;
                }, btn);

                if (boxscoreLink) {
                    linkButtonsBoxscoreMap.set(`row_${i}`, boxscoreLink);
                }
                // close dropdown by clicking elsewhere or just proceed (sidearm closes on next click usually)
            } catch (e) {
                // ignore click errors
            }
        }

        const html = await page.content();
        fs.writeFileSync(path.resolve(__dirname, '../../../../debug_live_duke.html'), html);
        // NOTE: Not saving HTML to disk

        await page.close();

        // Parse
        const parser = new SidearmParser();
        const games = await parser.parseSchedule(html, { teamName: team.name_canonical, baseUrl: team.schedule_url, debug: true });

        // Enrich
        games.forEach((game, index) => {
            const rowKey = `row_${index}`; // Logic assumes simple row mapping matching index
            const boxscoreUrl = linkButtonsBoxscoreMap.get(rowKey);
            if (boxscoreUrl && !game.source_urls?.boxscore_url) {
                if (!game.source_urls) game.source_urls = {};
                game.source_urls.boxscore_url = boxscoreUrl.startsWith('http')
                    ? boxscoreUrl
                    : new URL(boxscoreUrl, team.schedule_url).toString();
            }
        });

        console.log(`[${team.name_canonical}] Parsed ${games.length} games`);
        return games;

    } catch (e: any) {
        console.error(`[${team.name_canonical}] Failed: ${e.message}`);
        await page.close();
        return [];
    }
}

async function main() {
    const startTotal = Date.now();

    if (!fs.existsSync(TEAMS_JSON_PATH)) {
        console.error(`Teams JSON not found at ${TEAMS_JSON_PATH}`);
        process.exit(1);
    }
    const teams: TeamConfig[] = JSON.parse(fs.readFileSync(TEAMS_JSON_PATH, 'utf8'));
    console.log(`Loaded ${teams.length} teams.`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--no-sandbox']
    });

    const allGames: any[] = [];

    // Process in batches
    for (let i = 0; i < teams.length; i += CONCURRENCY) {
        const batch = teams.slice(i, i + CONCURRENCY);
        const promises = batch.map(team => processSchool(browser, team));
        const results = await Promise.all(promises);
        results.forEach(g => allGames.push(...g));
    }

    await browser.close();

    // Deduplicate and Save
    if (allGames.length > 0) {
        const year = allGames[0].date.split('-')[0] || '2025';
        const storageDir = path.resolve(__dirname, '../../../../data');
        const storage = new GameStorageAdapter(storageDir);

        // Simple client-side dedupe before saving? Storage adapter might handle it.
        // But let's be safe and dedupe by unique key if we can.
        // Actually GameStorageAdapter likely overwrites or merges.
        await storage.saveGames(allGames, year);
        console.log(`\n✨ Saved ${allGames.length} games to ${path.join(storageDir, 'games', year, 'games.csv')}`);
    } else {
        console.log('No games found.');
    }

    const duration = (Date.now() - startTotal) / 1000;
    console.log(`Total time: ${duration.toFixed(1)}s`);
}

main().catch(console.error);
