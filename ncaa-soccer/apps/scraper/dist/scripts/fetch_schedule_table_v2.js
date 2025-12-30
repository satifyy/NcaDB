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
const playwright_chromium_1 = require("playwright-chromium");
const parsers_1 = require("@ncaa/parsers");
const storage_1 = require("@ncaa/storage");
const fs = __importStar(require("fs"));
// Normalize a boxscore URL using the schedule page as base. Works across layouts without hardcoded team overrides.
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
            console.log(`🔄 Attempt ${attempt}/${maxAttempts} for ${operation}`);
            return await fn();
        }
        catch (error) {
            lastError = error;
            console.warn(`⚠️  Attempt ${attempt} failed: ${lastError.message}`);
            if (attempt < maxAttempts) {
                const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
                console.log(`⏱️  Waiting ${delayMs}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    throw new Error(`Failed after ${maxAttempts} attempts: ${lastError?.message}`);
}
async function main() {
    const [, , url, teamName = 'Unknown Team', alias = 'table_schedule', maxRetriesArg = '3'] = process.argv;
    if (!url) {
        console.error('Usage: ts-node fetch_schedule_table.ts <url> <teamName> [alias] [maxRetries]');
        process.exit(1);
    }
    const maxRetries = parseInt(maxRetriesArg, 10) || 3;
    console.log(`⚙️  Configuration: maxRetries=${maxRetries}`);
    const browser = await playwright_chromium_1.chromium.launch({
        headless: true,
        timeout: 60000 // Increase launch timeout to 60s
    });
    const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
    });
    // Set default navigation timeout to 60s for slow sites
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(30000);
    // // Capture JSON API responses
    // let capturedJsonData: string | null = null;
    // page.on('response', async (response: any) => {
    //     try {
    //         const responseUrl = response.url();
    //         const contentType = response.headers()['content-type'] || '';
    //         if (contentType.includes('application/json') && 
    //             (responseUrl.includes('schedule') || responseUrl.includes('games') || responseUrl.includes('calendar'))) {
    //             try {
    //                 const json = await response.text();
    //                 if (!capturedJsonData) {
    //                     capturedJsonData = json;
    //                     console.log(`📡 Captured schedule JSON from API: ${responseUrl}`);
    //                 }
    //             } catch (e) {
    //                 // Ignore
    //             }
    //         }
    //     } catch (e) {
    //         // Ignore
    //     }
    // });
    console.log(`Navigating to ${url} ...`);
    const response = await retryWithBackoff(() => page.goto(url, {
        waitUntil: 'domcontentloaded', // Faster than networkidle
        timeout: 60000
    }), maxRetries, 2000, 'page navigation');
    // Give page extra time to settle after initial load
    await page.waitForTimeout(2000);
    // // Check if main response is JSON
    // const mainContentType = response?.headers()['content-type'] || '';
    // if (mainContentType.includes('application/json') && response) {
    //     console.log('⚡ Direct JSON API endpoint detected!');
    //     const jsonContent = await response.text();
    //     const parser = new SidearmParser();
    //     const games = await parser.parseSchedule(jsonContent, { teamName, baseUrl: url });
    //     await browser.close();
    //     if (games.length > 0) {
    //         const year = games[0].date.split('-')[0];
    //         const storageDir = path.resolve(__dirname, '../../../../data');
    //         const storage = new GameStorageAdapter(storageDir);
    //         await storage.saveGames(games, year);
    //         console.log(`✅ Parsed and saved ${games.length} games from JSON API`);
    //     }
    //     return;
    // }
    // Try to close any popups/overlays - use force option to skip waiting
    try {
        // Force-hide any popups via JavaScript immediately
        await page.evaluate(() => {
            const popups = document.querySelectorAll('.c-polite-pop-up--index, .s-popup, [class*="popup"], [id*="popup"], #iubenda-cs-banner, [class*="iubenda"]');
            popups.forEach(p => {
                p.style.display = 'none';
                p.style.visibility = 'hidden';
                p.style.opacity = '0';
                p.style.pointerEvents = 'none';
            });
        });
        console.log('Force-hidden all popups via JavaScript');
        await page.waitForTimeout(1000);
    }
    catch (e) {
        console.warn('Popup removal error:', e);
    }
    // Handle dropdown select for Grid/List view (e.g., Stanford, Virginia Tech)
    try {
        const dropdownSelector = 'select#view, select.dropdown__select, select[name="view"]';
        const dropdown = await page.$(dropdownSelector);
        if (dropdown) {
            console.log('Found dropdown view selector, selecting "list" option...');
            await page.selectOption(dropdownSelector, 'list');
            await page.waitForTimeout(1000);
            console.log('Selected list view from dropdown');
        }
    }
    catch (e) {
        console.warn('Dropdown select failed or not found');
    }
    // Click the table view toggle if present (use force option)
    const tableSelector = '#_viewType_table, button[aria-label="Table View"], a[aria-label="Switch to Grid View"], a[data-view="grid"], a:has-text("Grid")';
    try {
        if (await page.$(tableSelector)) {
            console.log('Attempting to switch to table/grid view...');
            await page.click(tableSelector, { timeout: 5000, force: true });
            console.log('Clicked grid view button');
        }
        else {
            console.warn('Table/Grid view toggle not found; continuing with current view.');
        }
    }
    catch (e) {
        console.warn('Could not click grid view, continuing with default view...');
    }
    // Wait for the table view to render
    const tableSelectorConcrete = '.c-schedule__table, #tablePanel table, table[data-table-view]';
    try {
        await page.waitForSelector(tableSelectorConcrete, { timeout: 5000 });
    }
    catch {
        console.warn('Table view did not render within timeout; proceeding anyway.');
    }
    await page.waitForTimeout(1500);
    // Scroll through the page to trigger lazy loading (optimized)
    for (let i = 0; i < 2; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(800);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);
    }
    // // Priority 1: Use captured JSON API data if available
    // if (capturedJsonData) {
    //     console.log('🎯 Intercepted JSON API data - checking if parseable...');
    //     const parser = new SidearmParser();
    //     const games = await parser.parseSchedule(capturedJsonData, { teamName, baseUrl: url, debug: true });
    //     console.log(`📊 Parser returned ${games.length} games from JSON`);
    //     if (games.length > 0) {
    //         await browser.close();
    //         const year = games[0].date.split('-')[0];
    //         const storageDir = path.resolve(__dirname, '../../../../data');
    //         const storage = new GameStorageAdapter(storageDir);
    //         await storage.saveGames(games, year);
    //         console.log(`✅ Parsed and saved ${games.length} games from API`);
    //         return;
    //     } else {
    //         console.warn('⚠️  JSON returned 0 games. Falling back to HTML parsing...');
    //         // Continue to HTML parsing below
    //     }
    // }
    // Extract boxscore links from HTML - try multiple strategies
    const linkButtonsBoxscoreMap = new Map();
    // Strategy 1: Check if this site has direct table links (Stanford/VT style) - skip dropdowns if so
    const hasDirectTableLinks = await page.evaluate(() => {
        const rows = document.querySelectorAll('tr.schedule-item-table, table.schedule-events-table__table tbody tr');
        if (rows.length === 0)
            return false;
        // Check first few rows for boxscore links (skip header rows)
        let foundCount = 0;
        for (let i = 0; i < Math.min(5, rows.length); i++) {
            const row = rows[i];
            // Skip if this is a header row
            if (row.querySelector('th') && !row.querySelector('td'))
                continue;
            // Look for links with "boxscore" in href or "Box Score" in text
            const links = Array.from(row.querySelectorAll('a'));
            const hasBoxscoreLink = links.some((a) => {
                const href = a.getAttribute('href') || '';
                const text = a.textContent || '';
                return href.includes('boxscore') || text.toLowerCase().includes('box score');
            });
            if (hasBoxscoreLink) {
                foundCount++;
                if (foundCount >= 2)
                    return true; // Found at least 2 rows with boxscore links
            }
        }
        return foundCount >= 2;
    });
    console.log(`🔍 Direct table links detected: ${hasDirectTableLinks}`);
    if (hasDirectTableLinks) {
        console.log('✅ Detected direct table links (Stanford/VT style), skipping dropdown extraction...');
    }
    // Strategy 2: Try link buttons/dropdowns (old Sidearm sites) - only if no direct links
    const linkButtons = hasDirectTableLinks ? [] : await page.$$('button[aria-label*="Links" i], button:has-text("Links")');
    if (linkButtons.length > 0) {
        console.log(`Extracting links from ${linkButtons.length} link menus...`);
        for (let i = 0; i < linkButtons.length; i++) {
            const btn = linkButtons[i];
            try {
                // Click to open dropdown with shorter timeout
                await btn.click({ timeout: 1500 });
                await page.waitForTimeout(300);
                // Extract the boxscore URL from the dropdown while it's open
                const boxscoreLink = await page.evaluate((button) => {
                    const parent = button.closest('tr, [class*="schedule"]');
                    if (!parent)
                        return null;
                    // Find the overlay/dropdown that opened
                    const overlay = parent.querySelector('[class*="overlay"] a[href*="boxscore"], [class*="dropdown"] a[href*="boxscore"]');
                    if (overlay) {
                        return overlay.getAttribute('href');
                    }
                    // Alternative: look for any link with "boxscore" or "stats" in it
                    const anyLink = parent.querySelector('[class*="overlay"] a, [class*="dropdown"] a');
                    if (anyLink) {
                        const href = anyLink.getAttribute('href');
                        if (href && (href.includes('boxscore') || href.includes('stats'))) {
                            return href;
                        }
                    }
                    return null;
                }, btn);
                if (boxscoreLink) {
                    // Use row index as key to match with parsed games later
                    linkButtonsBoxscoreMap.set(`row_${i}`, boxscoreLink);
                    console.log(`Row ${i}: Found boxscore link: ${boxscoreLink}`);
                }
                // Small delay before next iteration (reduced for speed)
                await page.waitForTimeout(100);
            }
            catch (e) {
                console.warn(`Could not extract link from button ${i}:`, e);
            }
        }
        console.log(`Extracted ${linkButtonsBoxscoreMap.size} boxscore links from dropdowns`);
    }
    else {
        console.log('No link dropdown buttons found, checking for direct links in table...');
    }
    // Strategy 3: Extract boxscore links directly from table rows (Stanford, Virginia Tech style)
    if (linkButtonsBoxscoreMap.size === 0) {
        const tableRows = await page.$$('tr.schedule-item-table, tr[class*="schedule"], table.schedule-events-table__table tbody tr');
        console.log(`Found ${tableRows.length} table rows, extracting boxscore links...`);
        for (let i = 0; i < tableRows.length; i++) {
            try {
                const boxscoreLink = await page.evaluate((row) => {
                    // Look for "Box Score" or "boxscore" link within the row
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
        console.log(`Extracted ${linkButtonsBoxscoreMap.size} boxscore links from table rows`);
    }
    // Now get the full HTML
    const html = await page.content();
    await browser.close();
    // Save raw HTML snapshot
    const rawDir = path.resolve(__dirname, '../../../../data/raw');
    if (!fs.existsSync(rawDir))
        fs.mkdirSync(rawDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = alias.replace(/[^a-zA-Z0-9_-]/g, '_');
    const rawPath = path.join(rawDir, `${timestamp}_${slug}.html`);
    fs.writeFileSync(rawPath, html);
    console.log(`Saved raw HTML to ${rawPath}`);
    // Parse with Sidearm parser
    const parser = new parsers_1.SidearmParser();
    const games = await parser.parseSchedule(html, { teamName, baseUrl: url, debug: true });
    // Enrich games with extracted boxscore links and normalize any relative URLs
    games.forEach((game, index) => {
        const rowKey = `row_${index}`;
        const mapped = linkButtonsBoxscoreMap.get(rowKey);
        const mappedResolved = resolveBoxscoreUrl(mapped, url);
        const parsedResolved = resolveBoxscoreUrl(game.source_urls?.boxscore_url, url);
        const finalBox = mappedResolved || parsedResolved;
        if (finalBox) {
            if (!game.source_urls)
                game.source_urls = {};
            game.source_urls.boxscore_url = finalBox;
        }
    });
    console.log(`Parsed ${games.length} games for ${teamName}.`);
    games.forEach(g => {
        const score = `${g.home_score ?? '-'}-${g.away_score ?? '-'}`;
        const box = g.source_urls?.boxscore_url ? `boxscore=${g.source_urls.boxscore_url}` : 'boxscore=(none)';
        console.log(`${g.date}: ${g.home_team_name} vs ${g.away_team_name} ${score} status=${g.status} ${box}`);
    });
    if (games.length > 0) {
        const year = games[0].date.split('-')[0];
        const storageDir = path.resolve(__dirname, '../../../../data');
        const storage = new storage_1.GameStorageAdapter(storageDir);
        await storage.saveGames(games, year);
        console.log(`Saved games to ${path.join(storageDir, 'games', year, 'games.csv')}`);
    }
}
main().catch(err => {
    console.error('fetch_schedule_table failed:', err);
    process.exit(1);
});
//# sourceMappingURL=fetch_schedule_table_v2.js.map