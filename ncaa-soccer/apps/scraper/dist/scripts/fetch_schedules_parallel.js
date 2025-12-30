"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const playwright_chromium_1 = require("playwright-chromium");
const parsers_1 = require("@ncaa/parsers");
const storage_1 = require("@ncaa/storage");
// Normalize a boxscore URL using the schedule page as base. No hardcoded team overrides.
const resolveBoxscoreUrl = (rawUrl, baseUrl) => {
    if (!rawUrl)
        return undefined;
    const trimmed = rawUrl.trim();
    if (!trimmed)
        return undefined;
    if (/^https?:\/\//i.test(trimmed))
        return trimmed;
    const originFromBase = (() => {
        try {
            return new URL(baseUrl).origin;
        }
        catch {
            return '';
        }
    })();
    if (trimmed.startsWith('//'))
        return `https:${trimmed}`;
    if (trimmed.startsWith('/'))
        return originFromBase ? `${originFromBase}${trimmed}` : undefined;
    try {
        return new URL(trimmed, originFromBase || baseUrl).toString();
    }
    catch {
        return undefined;
    }
};
// Retry wrapper with exponential backoff
async function retryWithBackoff(fn, maxAttempts = 3, initialDelayMs = 2000, operation = 'operation') {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (attempt > 1)
                console.log(`🔄 Retry ${attempt}/${maxAttempts} for ${operation}`);
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt < maxAttempts) {
                const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
                console.warn(`⚠️  Attempt ${attempt} failed, retrying in ${delayMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    throw lastError || new Error(`Failed after ${maxAttempts} attempts`);
}
// Configuration
const CONCURRENCY = 10; // Increased for faster processing
const VIEWPORT = { width: 1280, height: 720 };
const inputPath = process.argv[2];
const TEAMS_JSON_PATH = inputPath
    ? path.resolve(process.cwd(), inputPath)
    : path.resolve(__dirname, '../../../../data/teams/acc_teams.json');
async function processSchool(browser, team) {
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
    // Block images and CSS for faster loading
    await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            route.abort();
        }
        else {
            route.continue();
        }
    });
    // Reduced timeouts for faster scraping
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(15000);
    // // Capture JSON API responses that might contain schedule data
    // let capturedJsonData: string | null = null;
    // const apiResponses: Array<{url: string, data: any}> = [];
    // page.on('response', async (response: any) => {
    //     try {
    //         const url = response.url();
    //         const contentType = response.headers()['content-type'] || '';
    //         // Capture JSON responses that look like schedule data
    //         if (contentType.includes('application/json') && 
    //             (url.includes('schedule') || url.includes('games') || url.includes('calendar'))) {
    //             try {
    //                 const json = await response.text();
    //                 apiResponses.push({ url, data: json });
    //                 if (!capturedJsonData) capturedJsonData = json;
    //                 console.log(`[${team.name_canonical}] 📡 Captured JSON from: ${url}`);
    //             } catch (e) {
    //                 // Ignore errors reading response body
    //             }
    //         }
    //     } catch (e) {
    //         // Ignore errors
    //     }
    // });
    try {
        const response = await retryWithBackoff(() => page.goto(team.schedule_url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        }), 2, // Reduced retries from 3 to 2
        1500, `[${team.name_canonical}] navigation`);
        // // Check if the main page itself returned JSON
        // const contentType = response?.headers()['content-type'] || '';
        // if (contentType.includes('application/json') && response) {
        //     console.log(`[${team.name_canonical}] ⚡ Direct JSON response detected`);
        //     const jsonContent = await response.text();
        //     const parser = new SidearmParser();
        //     const games = await parser.parseSchedule(jsonContent, { 
        //         teamName: team.name_canonical, 
        //         baseUrl: team.schedule_url 
        //     });
        //     console.log(`[${team.name_canonical}] Parsed ${games.length} games from JSON API`);
        //     if (games.length > 0) {
        //         await page.close();
        //         return games;
        //     } else {
        //         console.warn(`[${team.name_canonical}] ⚠️  Direct JSON returned 0 games, trying HTML...`);
        //     }
        // }
        // Try to close any popups/overlays that might block interaction
        try {
            // Force-hide popups via JavaScript (including cookie consent)
            await page.evaluate(() => {
                const popups = document.querySelectorAll('.c-polite-pop-up--index, .s-popup, [class*="popup"], [id*="popup"], #iubenda-cs-banner, [class*="iubenda"]');
                popups.forEach(p => {
                    p.style.display = 'none';
                    p.style.visibility = 'hidden';
                    p.style.pointerEvents = 'none';
                });
            });
            await page.waitForTimeout(100);
        }
        catch (e) {
            // Ignore popup errors
        }
        // Handle dropdown select for Grid/List view (e.g., Stanford, Virginia Tech)
        try {
            const dropdownSelector = 'select#view, select.dropdown__select, select[name="view"]';
            const dropdown = await page.$(dropdownSelector);
            if (dropdown) {
                console.log(`[${team.name_canonical}] Found dropdown, selecting list view...`);
                await page.selectOption(dropdownSelector, 'list');
                await page.waitForTimeout(300);
            }
        }
        catch (e) {
            // Ignore dropdown errors
        }
        // Fast UI interactions for HTML pages
        const tableSelector = '#_viewType_table, button[aria-label="Table View"], .sidearm-schedule-view-options button:has-text("Table"), a[aria-label="Switch to Grid View"], a[data-view="grid"], a:has-text("Grid")';
        if (await page.$(tableSelector)) {
            await page.click(tableSelector, { timeout: 5000, force: true });
            await page.waitForTimeout(300);
        }
        // Wait a bit for JavaScript to load data (reduced)
        await page.waitForTimeout(1500);
        // // Check if we captured JSON data from API calls
        // if (capturedJsonData) {
        //     console.log(`[${team.name_canonical}] 🎯 Checking captured API data...`);
        //     const parser = new SidearmParser();
        //     const games = await parser.parseSchedule(capturedJsonData, { 
        //         teamName: team.name_canonical, 
        //         baseUrl: team.schedule_url 
        //     });
        //     console.log(`[${team.name_canonical}] Parsed ${games.length} games from API response`);
        //     if (games.length > 0) {
        //         await page.close();
        //         return games;
        //     } else {
        //         console.warn(`[${team.name_canonical}] ⚠️  API JSON returned 0 games, falling back to HTML...`);
        //     }
        // }
        // Wait for table (HTML fallback)
        try {
            await page.waitForSelector('.c-schedule__table, #tablePanel table, table[data-table-view], .s-table-body__row', { timeout: 8000 });
        }
        catch (e) {
            console.warn(`[${team.name_canonical}] ⚠️  Table selector timeout - page may not have loaded properly`);
        }
        // Quick scroll to trigger lazy loading (optimized)
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(300);
        await page.evaluate(() => window.scrollTo(0, 0));
        // Extract Links Map (Optimized)
        const linkButtonsBoxscoreMap = new Map();
        // Check if this site has direct table links (Stanford/VT style)
        const hasDirectTableLinks = await page.evaluate(() => {
            const rows = document.querySelectorAll('tr.schedule-item-table, table.schedule-events-table__table tbody tr');
            if (rows.length === 0)
                return false;
            let foundCount = 0;
            for (let i = 0; i < Math.min(5, rows.length); i++) {
                const row = rows[i];
                if (row.querySelector('th') && !row.querySelector('td'))
                    continue;
                const links = Array.from(row.querySelectorAll('a'));
                const hasBoxscoreLink = links.some((a) => {
                    const href = a.getAttribute('href') || '';
                    const text = a.textContent || '';
                    return href.includes('boxscore') || text.toLowerCase().includes('box score');
                });
                if (hasBoxscoreLink) {
                    foundCount++;
                    if (foundCount >= 2)
                        return true;
                }
            }
            return foundCount >= 2;
        });
        const linkButtons = hasDirectTableLinks ? [] : await page.$$('button[aria-label*="Links" i], button:has-text("Links")');
        // Process buttons quickly
        for (let i = 0; i < linkButtons.length; i++) {
            try {
                const btn = linkButtons[i];
                await btn.click({ timeout: 800 });
                // Don't wait long, just check immediately
                const boxscoreLink = await page.evaluate((button) => {
                    // Try to find the closest row container
                    const parent = button.closest('tr, [class*="schedule"], [class*="s-table-body__row"], div[class*="row"]');
                    if (!parent)
                        return null;
                    // Look for boxscore link within the parent row
                    const link = parent.querySelector('a[href*="boxscore"]');
                    if (link)
                        return link.getAttribute('href');
                    // Fallback: Look for "History" or similar if boxscore isn't explicit,
                    // but usually "Box Score" or "boxscore" in href is the key.
                    // Sometimes it's in a dropdown menu that is a sibling or child.
                    const overlay = parent.querySelector('[class*="overlay"] a[href*="boxscore"], [class*="dropdown"] a[href*="boxscore"], ul a[href*="boxscore"]');
                    if (overlay)
                        return overlay.getAttribute('href');
                    return null;
                }, btn);
                if (boxscoreLink) {
                    linkButtonsBoxscoreMap.set(`row_${i}`, boxscoreLink);
                }
                // close dropdown by clicking elsewhere or just proceed (sidearm closes on next click usually)
            }
            catch (e) {
                // ignore click errors
            }
        }
        // Strategy 2: Extract boxscore links directly from table rows if no dropdowns worked
        if (linkButtonsBoxscoreMap.size === 0) {
            const tableRows = await page.$$('tr.schedule-item-table, tr[class*="schedule"], table.schedule-events-table__table tbody tr');
            for (let i = 0; i < tableRows.length; i++) {
                try {
                    const boxscoreLink = await page.evaluate((row) => {
                        const links = Array.from(row.querySelectorAll('a'));
                        const boxscoreLinkEl = links.find((a) => {
                            const href = a.getAttribute('href') || '';
                            const text = a.textContent || '';
                            return href.includes('boxscore') || text.toLowerCase().includes('box score');
                        });
                        return boxscoreLinkEl ? boxscoreLinkEl.getAttribute('href') : null;
                    }, tableRows[i]);
                    if (boxscoreLink) {
                        linkButtonsBoxscoreMap.set(`row_${i}`, boxscoreLink);
                    }
                }
                catch (e) {
                    // Ignore row extraction errors
                }
            }
        }
        // Get rendered HTML as final fallback
        const html = await page.content();
        await page.close();
        // Parse HTML (handles both HTML and embedded JSON)
        const parser = new parsers_1.SidearmParser();
        const games = await parser.parseSchedule(html, {
            teamName: team.name_canonical,
            baseUrl: team.schedule_url
        });
        // Enrich
        games.forEach((game, index) => {
            const rowKey = `row_${index}`; // Logic assumes simple row mapping matching index
            const mapped = linkButtonsBoxscoreMap.get(rowKey);
            const mappedResolved = resolveBoxscoreUrl(mapped, team.schedule_url);
            const parsedResolved = resolveBoxscoreUrl(game.source_urls?.boxscore_url, team.schedule_url);
            const finalBox = mappedResolved || parsedResolved;
            if (finalBox) {
                if (!game.source_urls)
                    game.source_urls = {};
                game.source_urls.boxscore_url = finalBox;
            }
        });
        console.log(`[${team.name_canonical}] Parsed ${games.length} games`);
        return games;
    }
    catch (e) {
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
    const teams = JSON.parse(fs.readFileSync(TEAMS_JSON_PATH, 'utf8'));
    console.log(`Loaded ${teams.length} teams.`);
    const browser = await playwright_chromium_1.chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--no-sandbox'],
        timeout: 60000
    });
    const allGames = [];
    // Process in batches with retry logic per team
    for (let i = 0; i < teams.length; i += CONCURRENCY) {
        const batch = teams.slice(i, i + CONCURRENCY);
        const promises = batch.map(team => retryWithBackoff(() => processSchool(browser, team), 2, // max 2 retries per team
        3000, `process ${team.name_canonical}`).catch(err => {
            console.error(`[${team.name_canonical}] Failed after retries: ${err.message}`);
            return []; // Return empty array on complete failure
        }));
        const results = await Promise.all(promises);
        results.forEach(g => allGames.push(...g));
    }
    await browser.close();
    // Deduplicate and Save
    if (allGames.length > 0) {
        const year = allGames[0].date.split('-')[0] || '2025';
        const storageDir = path.resolve(__dirname, '../../../../data');
        const storage = new storage_1.GameStorageAdapter(storageDir, { verbose: true });
        // Simple client-side dedupe before saving? Storage adapter might handle it.
        // But let's be safe and dedupe by unique key if we can.
        // Actually GameStorageAdapter likely overwrites or merges.
        await storage.saveGames(allGames, year);
        console.log(`\n✨ Saved ${allGames.length} games to ${path.join(storageDir, 'games', year, 'games.csv')}`);
    }
    else {
        console.log('No games found.');
    }
    const duration = (Date.now() - startTotal) / 1000;
    console.log(`Total time: ${duration.toFixed(1)}s`);
}
main().catch(console.error);
//# sourceMappingURL=fetch_schedules_parallel.js.map