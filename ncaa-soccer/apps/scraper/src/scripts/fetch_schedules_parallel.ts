import * as path from 'path';
import * as fs from 'fs';
import { chromium } from 'playwright-chromium';
import {
    SidearmParser,
    TeamNameResolver,
    WmtClient,
    WmtParser,
    WmtWordpressParser,
    classifyGameType,
    cleanTeamName,
    makeDedupeKey,
    seasonNameCandidates,
    sportSlugFromScheduleUrl
} from '@ncaa/parsers';
import { ACC_INVENTORY, DATA_DIR, GameStorageAdapter, gamesCsv } from '@ncaa/storage';
import { buildTeamNameResolver, loadTeams, TeamConfig } from '../utils/teams';

// Normalize a boxscore URL using the schedule page as base. No hardcoded team overrides.
const resolveBoxscoreUrl = (rawUrl: string | undefined, baseUrl: string): string | undefined => {
    if (!rawUrl) return undefined;
    const trimmed = rawUrl.trim();
    if (!trimmed) return undefined;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    const originFromBase = (() => {
        try {
            return new URL(baseUrl).origin;
        } catch {
            return '';
        }
    })();
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    if (trimmed.startsWith('/')) return originFromBase ? `${originFromBase}${trimmed}` : undefined;
    try {
        return new URL(trimmed, originFromBase || baseUrl).toString();
    } catch {
        return undefined;
    }
};

// Retry wrapper with exponential backoff
async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxAttempts: number = 3,
    initialDelayMs: number = 2000,
    operation: string = 'operation'
): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (attempt > 1) console.log(`🔄 Retry ${attempt}/${maxAttempts} for ${operation}`);
            return await fn();
        } catch (error) {
            lastError = error as Error;
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
    : ACC_INVENTORY;

// Fall season to scrape, e.g. 2025 covers Aug-Dec 2025.
const SEASON_YEAR = Number(process.argv[3]) || new Date().getFullYear();

/**
 * Collapses a stored row's team names onto their canonical form and rebuilds the
 * dedupe key from them.
 *
 * Sidearm pages decorate opponents with poll rankings and long-form names — "#3 NC
 * State", "#24/RV University of Virginia", "Pitt" — while the WMT API returns plain
 * school names. Without this, one fixture is filed twice: once from each school's
 * point of view. The ranking is preserved on the `*_ranked` columns, where the schema
 * keeps it.
 *
 * The fixture kind is read here, before the names are replaced, because this function is
 * where it used to be lost: "Marist (Exhibition)" becomes "Marist" on the way past, and
 * nothing downstream could tell afterwards that the game had been a friendly. Rows
 * already on disk go through this too, so a stored row keeps whatever kind it was written
 * with — a re-scrape may only ever add a marker, never erase one.
 */
function normalizeRow(row: Record<string, string>, resolver: TeamNameResolver): Record<string, string> {
    const home = cleanTeamName(row.home_team_name);
    const away = cleanTeamName(row.away_team_name);
    const stored = row.game_type;
    const derived = classifyGameType(row).type;
    const gameType = stored && stored !== 'regular' ? stored : derived;
    const homeName = resolver.canonical(home.name);
    const awayName = resolver.canonical(away.name);
    if (!homeName || !awayName || !row.date) return { ...row, game_type: gameType };

    return {
        ...row,
        game_type: gameType,
        home_team_name: homeName,
        away_team_name: awayName,
        home_team_ranked: row.home_team_ranked === 'true' || home.ranked ? 'true' : 'false',
        away_team_ranked: row.away_team_ranked === 'true' || away.ranked ? 'true' : 'false',
        dedupe_key: makeDedupeKey(row.date, homeName, awayName)
    };
}

/**
 * Sidearm serves a past season at `/schedule/<year>`; without it the page always
 * renders the current season, which is how 2026 fixtures previously leaked into the
 * 2025 dataset. The current season stays on the bare URL, which is the form these
 * sites canonicalise to.
 */
function sidearmScheduleUrl(scheduleUrl: string, seasonYear: number): string {
    if (seasonYear === new Date().getFullYear()) return scheduleUrl;
    if (/\/(19|20)\d{2}\/?$/.test(scheduleUrl)) return scheduleUrl;
    return `${scheduleUrl.replace(/\/$/, '')}/${seasonYear}`;
}

/**
 * WMT Digital schools (Clemson, Notre Dame, Virginia) do not render their schedule
 * into HTML the way Sidearm does: Notre Dame builds the table client-side, Clemson
 * omits the year from every row, and neither exposes past seasons at a fetchable URL.
 * They all serve the same `/website-api` JSON that their own pages consume, so we
 * read that directly and skip the browser entirely.
 */
async function processWmtSchool(team: TeamConfig, resolver: TeamNameResolver): Promise<any[]> {
    const sportSlug = sportSlugFromScheduleUrl(team.schedule_url);
    if (!sportSlug) {
        console.warn(`[${team.name_canonical}] Cannot read sport slug from ${team.schedule_url}`);
        return [];
    }

    const seasonNames = seasonNameCandidates(SEASON_YEAR);
    const client = new WmtClient(team.schedule_url);
    const events = await client.fetchSeasonEvents(sportSlug, seasonNames);

    const games = new WmtParser().parseEvents(events, {
        teamName: team.name_canonical,
        baseUrl: team.schedule_url,
        sourceUrl: team.schedule_url,
        timeZone: team.timezone || 'America/New_York',
        nameResolver: resolver,
        seasonYear: SEASON_YEAR
    });

    console.log(`[${team.name_canonical}] Parsed ${games.length} games from WMT API (${SEASON_YEAR})`);
    return games;
}

/**
 * WMT's WordPress sites (Kentucky, South Carolina) render the whole season server-side
 * and expose no schedule API, so a plain fetch of the season URL is all they need.
 */
async function processWmtWordpressSchool(team: TeamConfig, resolver: TeamNameResolver): Promise<any[]> {
    const url = `${team.schedule_url.replace(/\/$/, '')}/${SEASON_YEAR}`;
    const response = await fetch(url, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
        }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

    const games = await new WmtWordpressParser().parseSchedule(await response.text(), {
        teamName: team.name_canonical,
        baseUrl: team.schedule_url,
        sourceUrl: url,
        nameResolver: resolver,
        seasonYear: SEASON_YEAR,
        timeZone: team.timezone || 'America/New_York'
    });
    console.log(`[${team.name_canonical}] Parsed ${games.length} games from WMT WordPress (${SEASON_YEAR})`);
    return games;
}

async function processSchool(browser: any, team: TeamConfig, resolver: TeamNameResolver): Promise<any[]> {
    console.log(`[${team.name_canonical}] Starting extract from ${team.schedule_url}`);

    if (team.platform_guess === 'wmt') {
        return processWmtSchool(team, resolver);
    }

    if (team.platform_guess === 'wmt_wp') {
        return processWmtWordpressSchool(team, resolver);
    }

    if (team.platform_guess !== 'sidearm') {
        console.warn(`[${team.name_canonical}] No parser for platform "${team.platform_guess}"`);
        return [];
    }

    const scheduleUrl = sidearmScheduleUrl(team.schedule_url, SEASON_YEAR);

    const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        viewport: VIEWPORT
    });
    
    // Block images and CSS for faster loading
    await page.route('**/*', (route: any) => {
        const resourceType = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            route.abort();
        } else {
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
        const response = await retryWithBackoff(
            () => page.goto(scheduleUrl, { 
                waitUntil: 'domcontentloaded',
                timeout: 30000 
            }),
            2, // Reduced retries from 3 to 2
            1500,
            `[${team.name_canonical}] navigation`
        );
        
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
                    (p as HTMLElement).style.display = 'none';
                    (p as HTMLElement).style.visibility = 'hidden';
                    (p as HTMLElement).style.pointerEvents = 'none';
                });
            });
            await page.waitForTimeout(100);
        } catch (e) {
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
        } catch (e) {
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
        } catch (e) {
            console.warn(`[${team.name_canonical}] ⚠️  Table selector timeout - page may not have loaded properly`);
        }

        // Quick scroll to trigger lazy loading (optimized)
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(300);
        await page.evaluate(() => window.scrollTo(0, 0));

        // Extract Links Map (Optimized)
        const linkButtonsBoxscoreMap = new Map<string, string>();
        
        // Check if this site has direct table links (Stanford/VT style)
        const hasDirectTableLinks = await page.evaluate(() => {
            const rows = document.querySelectorAll('tr.schedule-item-table, table.schedule-events-table__table tbody tr');
            if (rows.length === 0) return false;
            let foundCount = 0;
            for (let i = 0; i < Math.min(5, rows.length); i++) {
                const row = rows[i];
                if (row.querySelector('th') && !row.querySelector('td')) continue;
                const links = Array.from(row.querySelectorAll('a'));
                const hasBoxscoreLink = links.some((a: any) => {
                    const href = a.getAttribute('href') || '';
                    const text = a.textContent || '';
                    return href.includes('boxscore') || text.toLowerCase().includes('box score');
                });
                if (hasBoxscoreLink) {
                    foundCount++;
                    if (foundCount >= 2) return true;
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
        
        // Strategy 2: Extract boxscore links directly from table rows if no dropdowns worked
        if (linkButtonsBoxscoreMap.size === 0) {
            const tableRows = await page.$$('tr.schedule-item-table, tr[class*="schedule"], table.schedule-events-table__table tbody tr');
            for (let i = 0; i < tableRows.length; i++) {
                try {
                    const boxscoreLink = await page.evaluate((row: any) => {
                        const links = Array.from(row.querySelectorAll('a')) as HTMLAnchorElement[];
                        const boxscoreLinkEl = links.find((a: HTMLAnchorElement) => {
                            const href = a.getAttribute('href') || '';
                            const text = a.textContent || '';
                            return href.includes('boxscore') || text.toLowerCase().includes('box score');
                        });
                        return boxscoreLinkEl ? boxscoreLinkEl.getAttribute('href') : null;
                    }, tableRows[i]);
                    
                    if (boxscoreLink) {
                        linkButtonsBoxscoreMap.set(`row_${i}`, boxscoreLink);
                    }
                } catch (e) {
                    // Ignore row extraction errors
                }
            }
        }

        // Get rendered HTML as final fallback
        const html = await page.content();
        await page.close();

        // Parse HTML (handles both HTML and embedded JSON)
        const parser = new SidearmParser();
        const games = await parser.parseSchedule(html, { 
            teamName: team.name_canonical, 
            baseUrl: scheduleUrl 
        });

        // Enrich
        games.forEach((game, index) => {
            const rowKey = `row_${index}`; // Logic assumes simple row mapping matching index
            const mapped = linkButtonsBoxscoreMap.get(rowKey);
            const mappedResolved = resolveBoxscoreUrl(mapped, scheduleUrl);
            const parsedResolved = resolveBoxscoreUrl(game.source_urls?.boxscore_url, scheduleUrl);
            const finalBox = mappedResolved || parsedResolved;

            if (finalBox) {
                if (!game.source_urls) game.source_urls = {};
                game.source_urls.boxscore_url = finalBox;
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
    const teams = loadTeams(TEAMS_JSON_PATH);
    const resolver = buildTeamNameResolver(teams);
    console.log(`Loaded ${teams.length} teams. Season: ${SEASON_YEAR}`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--no-sandbox'],
        timeout: 60000
    });

    let allGames: any[] = [];

    // Closed in `finally` rather than after the loop. A throw anywhere in the scrape
    // used to leave chromium — and so this process — alive. Locally that is a stray
    // process; on a scheduled runner it is worse, because a run that never exits makes
    // the scheduler skip every run after it.
    try {
        // Process in batches with retry logic per team
        for (let i = 0; i < teams.length; i += CONCURRENCY) {
            const batch = teams.slice(i, i + CONCURRENCY);
            const promises = batch.map(team =>
                retryWithBackoff(
                    () => processSchool(browser, team, resolver),
                    2, // max 2 retries per team
                    3000,
                    `process ${team.name_canonical}`
                ).catch(err => {
                    console.error(`[${team.name_canonical}] Failed after retries: ${err.message}`);
                    return []; // Return empty array on complete failure
                })
            );
            const results = await Promise.all(promises);
            results.forEach(g => allGames.push(...g));
        }
    } finally {
        await browser.close();
    }

    // A row whose opponent never resolved is a parse failure, not a fixture.
    const placeholders = allGames.filter(g =>
        /unknown/i.test(`${g.home_team_name} ${g.away_team_name}`)
    );
    if (placeholders.length > 0) {
        console.warn(`Dropping ${placeholders.length} games with an unresolved opponent.`);
    }
    allGames = allGames.filter(g => !/unknown/i.test(`${g.home_team_name} ${g.away_team_name}`));

    // A site that ignores our season request would otherwise write next season's
    // fixtures into this season's file, so the year is enforced here as well.
    const offSeason = allGames.filter(g => !String(g.date).startsWith(`${SEASON_YEAR}-`));
    if (offSeason.length > 0) {
        console.warn(`Dropping ${offSeason.length} games outside season ${SEASON_YEAR}.`);
        const bySeason = new Map<string, number>();
        offSeason.forEach(g => {
            const y = String(g.date).slice(0, 4);
            bySeason.set(y, (bySeason.get(y) || 0) + 1);
        });
        console.warn(`  by year: ${[...bySeason].map(([y, n]) => `${y}=${n}`).join(', ')}`);
    }
    const seasonGames = allGames.filter(g => String(g.date).startsWith(`${SEASON_YEAR}-`));

    // Deduplicate and Save
    if (seasonGames.length > 0) {
        const year = String(SEASON_YEAR);
        const storage = new GameStorageAdapter(DATA_DIR, {
            verbose: true,
            normalizeRow: row => normalizeRow(row, resolver)
        });

        // Simple client-side dedupe before saving? Storage adapter might handle it.
        // But let's be safe and dedupe by unique key if we can.
        // Actually GameStorageAdapter likely overwrites or merges.
        await storage.saveGames(seasonGames, year);
        console.log(`\n✨ Saved ${seasonGames.length} games to ${gamesCsv(year)}`);
    } else {
        console.log('No games found.');
    }

    const duration = (Date.now() - startTotal) / 1000;
    console.log(`Total time: ${duration.toFixed(1)}s`);
}

/**
 * A crashed run has to be visible to whatever invoked it.
 *
 * Logging the error and exiting 0 makes a scrape that fetched nothing indistinguishable
 * from one that worked, which a scheduled run reports as a success and a pipeline stage
 * treats as reason to continue on to the next step.
 */
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
