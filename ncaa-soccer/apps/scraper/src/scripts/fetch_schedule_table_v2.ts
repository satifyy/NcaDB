import * as path from 'path';
import { chromium } from 'playwright-chromium';
import { SidearmParser } from '@ncaa/parsers';
import { GameStorageAdapter } from '@ncaa/storage';
import * as fs from 'fs';

async function main() {
    const [, , url, teamName = 'Unknown Team', alias = 'table_schedule'] = process.argv;

    if (!url) {
        console.error('Usage: ts-node fetch_schedule_table.ts <url> <teamName> [alias]');
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
    });

    console.log(`Navigating to ${url} ...`);
    await page.goto(url, { waitUntil: 'networkidle' });

    // Click the table view toggle if present
    const tableSelector = '#_viewType_table, button[aria-label="Table View"]';
    if (await page.$(tableSelector)) {
        console.log('Switching to table view...');
        await page.click(tableSelector);
    } else {
        console.warn('Table view toggle not found; continuing with current view.');
    }

    // Wait for the table view to render
    const tableSelectorConcrete = '.c-schedule__table, #tablePanel table, table[data-table-view]';
    try {
        await page.waitForSelector(tableSelectorConcrete, { timeout: 5000 });
    } catch {
        console.warn('Table view did not render within timeout; proceeding anyway.');
    }
    await page.waitForTimeout(1500);

    // Scroll through the page multiple times to trigger lazy loading
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1200);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(800);
    }

    // SOLUTION: Extract boxscore links during the click loop
    const linkButtonsBoxscoreMap = new Map<string, string>();
    const linkButtons = await page.$$('button[aria-label*="Links" i], button:has-text("Links")');
    
    if (linkButtons.length > 0) {
        console.log(`Extracting links from ${linkButtons.length} link menus...`);
        
        for (let i = 0; i < linkButtons.length; i++) {
            const btn = linkButtons[i];
            try {
                // Click to open dropdown
                await btn.click({ timeout: 2000 });
                await page.waitForTimeout(500);
                
                // Extract the boxscore URL from the dropdown while it's open
                const boxscoreLink = await page.evaluate((button) => {
                    const parent = button.closest('tr, [class*="schedule"]');
                    if (!parent) return null;
                    
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
                
                // Small delay before next iteration
                await page.waitForTimeout(200);
            } catch (e) {
                console.warn(`Could not extract link from button ${i}:`, e);
            }
        }
        
        console.log(`Extracted ${linkButtonsBoxscoreMap.size} boxscore links`);
    }

    // Now get the full HTML
    const html = await page.content();
    await browser.close();

    // Save raw HTML snapshot
    const rawDir = path.resolve(__dirname, '../../../../data/raw');
    if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = alias.replace(/[^a-zA-Z0-9_-]/g, '_');
    const rawPath = path.join(rawDir, `${timestamp}_${slug}.html`);
    fs.writeFileSync(rawPath, html);
    console.log(`Saved raw HTML to ${rawPath}`);

    // Parse with Sidearm parser
    const parser = new SidearmParser();
    const games = await parser.parseSchedule(html, { teamName, baseUrl: url, debug: true });
    
    // Enrich games with extracted boxscore links
    games.forEach((game, index) => {
        const rowKey = `row_${index}`;
        const boxscoreUrl = linkButtonsBoxscoreMap.get(rowKey);
        if (boxscoreUrl && !game.source_urls?.boxscore_url) {
            if (!game.source_urls) {
                game.source_urls = {};
            }
            // Resolve relative URLs
            game.source_urls.boxscore_url = boxscoreUrl.startsWith('http') 
                ? boxscoreUrl 
                : new URL(boxscoreUrl, url).toString();
        }
    });
    
    console.log(`Parsed ${games.length} games for ${teamName}.`);
    games.forEach(g => {
        const score = `${g.home_score ?? '-'}-${g.away_score ?? '-'}`;
        const box = g.source_urls?.boxscore_url ? `boxscore=${g.source_urls.boxscore_url}` : 'boxscore=';
        console.log(`${g.date}: ${g.home_team_name} vs ${g.away_team_name} ${score} status=${g.status} ${box}`);
    });

    if (games.length > 0) {
        const year = games[0].date.split('-')[0];
        const storageDir = path.resolve(__dirname, '../../../../data');
        const storage = new GameStorageAdapter(storageDir);
        await storage.saveGames(games, year);
        console.log(`Saved games to ${path.join(storageDir, 'games', year, 'games.csv')}`);
    }
}

main().catch(err => {
    console.error('fetch_schedule_table failed:', err);
    process.exit(1);
});
