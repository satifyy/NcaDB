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
    const tableSelector = '#_viewType_table, button[aria-label=\"Table View\"]';
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

    // Open all "Links" dropdowns so boxscore anchors are in the DOM
    // Force all dropdowns to stay open by adding a class or modifying the DOM
    await page.evaluate(() => {
        // Find all dropdown containers and force them open
        const dropdowns = document.querySelectorAll('[class*="dropdown"], [class*="overlay"]');
        dropdowns.forEach(dropdown => {
            const htmlEl = dropdown as HTMLElement;
            htmlEl.style.display = 'block';
            htmlEl.style.visibility = 'visible';
            htmlEl.style.opacity = '1';
            htmlEl.style.height = 'auto';
            htmlEl.classList.add('is-open');
        });
    });

    const linkButtons = await page.$$('button[aria-label*="Links" i], button:has-text("Links")');
    if (linkButtons.length > 0) {
        console.log(`Expanding ${linkButtons.length} link menus...`);
        
        // Click buttons and immediately prevent them from closing
        for (const btn of linkButtons) {
            try {
                await btn.click({ timeout: 2000 });
                // Prevent the dropdown from closing by manipulating the DOM
                await page.evaluate((button) => {
                    const parent = button.closest('[class*="schedule"], tr');
                    if (parent) {
                        const overlay = parent.querySelector('[class*="overlay"], [class*="dropdown"]');
                        if (overlay) {
                            const htmlEl = overlay as HTMLElement;
                            htmlEl.classList.add('is-open');
                            htmlEl.style.pointerEvents = 'none'; // Prevent close on click-away
                        }
                    }
                }, btn);
                await page.waitForTimeout(300);
            } catch (e) {
                console.warn('Could not expand a links menu:', e);
            }
        }
        // Give time for dropdown content to render
        await page.waitForTimeout(2000);
    }

    // Wait for table to be visible if it exists
    const table = await page.$(tableSelectorConcrete);
    if (!table) {
        console.warn('No table found; scraping full DOM instead.');
    }

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
