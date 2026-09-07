import * as fs from 'fs';
import * as path from 'path';
import { SidearmBoxScoreParser, TeamNameResolver, WmtBoxScoreParser } from '@ncaa/parsers';
import { buildTeamNameResolver, loadAllTeams } from '../utils/teams';
const { chromium } = require('playwright-chromium');
import {
    DEBUG_BOXSCORE_LOG,
    FAILED_BOXSCORES_LOG,
    GameCsvRow,
    PlayerStatCsvRow,
    RAW_DIR,
    playerStatsCsv,
    readAll,
    streamRows
} from '@ncaa/storage';

interface GameRow {
    game_id: string;
    date: string;
    home_team_name: string;
    away_team_name: string;
    /** `final`, `scheduled`, `canceled`, `postponed`. Only a final has a box score. */
    status: string;
    boxscore_url?: string;
    /** The other school's box score for the same fixture, when the two differ. */
    boxscore_url_alt?: string;
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
    /**
     * Why this game yielded nothing, when that was the correct outcome rather than a
     * failure to be retried.
     *
     * A PDF-only box score is not a page that failed to load; it is a source with no
     * machine-readable table in it, and no number of retries will change that. Counting
     * the two together produced a failure log where twenty-one deliberate skips sat
     * beside five real problems with nothing to tell them apart.
     */
    skipped?: string;
}

// Configuration
const BATCH_SIZE = 120; // Restart browser after this many games to free memory
const CONCURRENCY = 8; // Number of parallel tabs (safer; raise cautiously if stable)
const DEBUG_LOG_PATH = DEBUG_BOXSCORE_LOG;
const VIEWPORT = { width: 1280, height: 720 };

/**
 * Box scores on WMT Digital sites (Clemson, Notre Dame, Virginia) are an iframe onto
 * wmt.games backed by a JSON stats feed. Scraping the iframe's DOM returns scoring
 * plays interleaved with players, so those URLs are routed to the JSON feed instead
 * and never touch the browser pool.
 */
const wmtBoxParser = new WmtBoxScoreParser();
let wmtHosts = new Set<string>();
let teamNameResolver: TeamNameResolver | undefined;

function hostOf(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

function isWmtBoxscore(url: string): boolean {
    const host = hostOf(url);
    return host === 'wmt.games' || wmtHosts.has(host);
}

function isPdf(url: string): boolean {
    return /\.pdf(\?|#|$)/i.test(url);
}

function slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Maps the labels a box score uses for its two squads onto the game's actual teams.
 *
 * Pages name a team however that school writes it — "CAL", "Cal", "California", "USD",
 * "VIL", or nothing at all — and chasing every abbreviation with an alias never ends.
 * A box score has exactly two sides and `games.csv` already says who played, so any
 * label the resolver cannot place is assigned to whichever of the two teams is still
 * unclaimed. Only a label that resolves to a team in this game is trusted outright,
 * which keeps a stray "Unknown" from stealing the wrong side.
 *
 * That generosity has a limit. It is right for a label the resolver cannot place — "VIL",
 * "USD", an empty string — because the only candidates left are the two teams that
 * played. It is wrong for a label that resolves to a *different school*, because that
 * means the page is not this fixture at all. William & Mary's site serves the Longwood
 * box score at the URL filed against their Georgetown game, and taking the fallback at
 * face value would have credited Longwood's players to Georgetown.
 *
 * `foreign` names any such label, and the caller discards the page rather than
 * attributing another game's players to this one.
 */
function resolveTeamLabels(
    game: GameRow,
    labels: string[]
): { assignment: Map<string, string>; foreign: string[] } {
    const canonical = (name: string) =>
        teamNameResolver ? teamNameResolver.canonical(name) : name;
    const sides = [canonical(game.home_team_name), canonical(game.away_team_name)];
    const assignment = new Map<string, string>();
    const claimed = new Set<string>();

    for (const label of labels) {
        const resolved = canonical(label);
        if (sides.includes(resolved) && !claimed.has(resolved)) {
            assignment.set(label, resolved);
            claimed.add(resolved);
        }
    }

    const unassigned = labels.filter(label => !assignment.has(label));
    const remaining = sides.filter(side => !claimed.has(side));

    if (unassigned.length === 1 && remaining.length === 1) {
        assignment.set(unassigned[0], remaining[0]);
    } else if (unassigned.length === 2 && remaining.length === 2) {
        // Both sides are abbreviations ("VIL"/"ION", "USD"/"SDSU"). Score each of the
        // two possible pairings and take the better one, so long as something matched.
        const straight = affinity(unassigned[0], remaining[0]) + affinity(unassigned[1], remaining[1]);
        const crossed = affinity(unassigned[0], remaining[1]) + affinity(unassigned[1], remaining[0]);
        if (Math.max(straight, crossed) > 0 && straight !== crossed) {
            const order = straight > crossed ? remaining : [remaining[1], remaining[0]];
            assignment.set(unassigned[0], order[0]);
            assignment.set(unassigned[1], order[1]);
        } else {
            for (const label of unassigned) assignment.set(label, canonical(label));
        }
    } else {
        // More labels than sides, or nothing left to give: keep what we were handed
        // rather than guessing.
        for (const label of unassigned) assignment.set(label, canonical(label));
    }

    // A label the resolver recognises as a school, which is not one of the two that
    // played, means this page belongs to another fixture.
    const known = (name: string) => (teamNameResolver ? teamNameResolver.lookup(name) : null);
    const foreign = unassigned.filter(label => {
        const resolved = known(label);
        return resolved !== null && !sides.includes(resolved);
    });

    return { assignment, foreign };
}

/**
 * How strongly an abbreviation points at a team name.
 *
 * "VIL" prefixes "Villanova"; "GSU" opens with the initials of "Georgia State". Scores
 * are only ever compared against each other within one game, so the absolute values
 * just need to rank prefix matches above initial matches and longer matches above
 * shorter ones.
 */
function affinity(label: string, team: string): number {
    const l = slugify(label);
    const t = slugify(team);
    if (!l || !t) return 0;
    if (l === t) return 100;
    if (t.startsWith(l)) return 50 + l.length;
    if (l.startsWith(t)) return 40 + t.length;
    const initials = team.split(/\s+/).filter(Boolean).map(word => word[0]).join('').toLowerCase();
    if (initials.length > 1 && l.startsWith(initials)) return 20 + initials.length;
    if (initials.length > 1 && initials.startsWith(l)) return 15 + l.length;
    return 0;
}

/**
 * Canonicalises `team_id` and rebuilds `player_key`, which embeds it.
 *
 * Returns nothing when the page names a school that did not play in this fixture — see
 * {@link resolveTeamLabels}. Losing one game's stats is recoverable; filing another
 * game's players under it is not.
 */
function toPlayerRows(game: GameRow, parsed: any[]): { rows: PlayerRow[]; foreign: string[] } {
    const labels = [...new Set(parsed.map(p => String(p.team_id ?? '')))];
    const { assignment: teamFor, foreign } = resolveTeamLabels(game, labels);
    if (foreign.length > 0) return { rows: [], foreign };
    const rows = parsed.map(p => {
        const teamId = teamFor.get(String(p.team_id ?? '')) || String(p.team_id ?? '');
        return {
            game_id: game.game_id,
            team_id: teamId,
            player_name: p.player_name,
            player_key: `${slugify(teamId)}:${slugify(p.player_name)}`,
            jersey_number: p.jersey_number ?? null,
            minutes: p.minutes ?? null,
            goals: p.goals ?? null,
            assists: p.assists ?? null,
            shots: p.shots ?? null,
            shots_on_goal: toNumber(p.stats?.shots_on_goal),
            saves: toNumber(p.stats?.saves)
        };
    });
    return { rows, foreign };
}

async function processWmtGame(game: GameRow): Promise<ProcessResult> {
    try {
        const res = await wmtBoxParser.fetchBoxScore(game.boxscore_url!, { nameResolver: teamNameResolver });
        if (res.playerStats.length === 0) {
            logDebug(`WARN [${game.game_id}] WMT stats feed returned no players for ${game.boxscore_url}`);
            return { rows: [], success: false };
        }
        const built = toPlayerRows(game, res.playerStats);
        if (built.foreign.length > 0) {
            logDebug(
                `SKIP [${game.game_id}] WMT feed is another fixture; it names ` +
                    `${built.foreign.join(', ')}, who did not play in this game.`
            );
            return { rows: [], success: false, skipped: `page is another fixture (${built.foreign.join(', ')})` };
        }
        logDebug(`OK [${game.game_id}] Parsed ${res.playerStats.length} stats from WMT stats feed`);
        return { rows: built.rows, success: true };
    } catch (e: any) {
        logDebug(`ERR [${game.game_id}] WMT stats feed failed: ${e.message}`);
        return { rows: [], success: false };
    }
}

/**
 * Reads `games.csv`.
 *
 * Through a real CSV parser rather than `split(',')`, because school names contain
 * commas: "University of Maryland, Baltimore County" shifted every field after it by one,
 * so that fixture arrived with its date in the team column, `2026-10-30 vs UMBC` for a
 * name and the bare domain for a box-score URL. One mangled row per season is easy to
 * miss and impossible to fetch.
 */
function parseGamesCsv(csvPath: string): GameRow[] {
    const rows = readAll<GameCsvRow>(csvPath, { relaxColumnCount: true });
    return rows.map(row => ({
        game_id: row.game_id || '',
        date: row.date || '',
        home_team_name: row.home_team_name || '',
        away_team_name: row.away_team_name || '',
        status: row.status || '',
        boxscore_url: row.boxscore_url || '',
        boxscore_url_alt: row.boxscore_url_alt || '',
        dedupe_key: row.dedupe_key || ''
    }));
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

/**
 * Tries the fixture's primary box score, then the other school's copy of the same game.
 *
 * The two schools publish independently, and one side is sometimes a dead end — Notre
 * Dame's stats feed returns no players for several 2025 games that Virginia's feed
 * covers in full. Falling back recovers the game instead of dropping it.
 */
async function processGame(
    browser: any,
    game: GameRow,
    rawDir: string,
    boxParser: SidearmBoxScoreParser,
    opts?: { attempt?: number; waitLonger?: boolean; waitMs?: number; scrollWaitMs?: number }
): Promise<ProcessResult> {
    const primary = await processGameOnce(browser, game, rawDir, boxParser, opts);
    if (primary.success || !game.boxscore_url_alt) return primary;

    logDebug(`FALLBACK [${game.game_id}] Primary box score empty, trying ${game.boxscore_url_alt}`);
    const fallback = await processGameOnce(
        browser,
        { ...game, boxscore_url: game.boxscore_url_alt, boxscore_url_alt: '' },
        rawDir,
        boxParser,
        opts
    );
    if (fallback.success) {
        logDebug(`FALLBACK OK [${game.game_id}] Recovered ${fallback.rows.length} stats from the alternate source`);
    }
    return fallback;
}

async function processGameOnce(
    browser: any,
    game: GameRow,
    rawDir: string,
    boxParser: SidearmBoxScoreParser,
    opts?: { attempt?: number; waitLonger?: boolean; waitMs?: number; scrollWaitMs?: number }
): Promise<ProcessResult> {
    const boxUrl = game.boxscore_url!;

    if (isPdf(boxUrl)) {
        // PDF-only box scores carry no machine-readable player table. Virginia publishes
        // nothing else, so this is every one of their fixtures — a standing property of
        // the source, not a fault. Where the opponent's school posts an HTML box score
        // the fixture is still covered through `boxscore_url_alt`.
        logDebug(`SKIP [${game.game_id}] PDF-only box score: ${boxUrl}`);
        return { rows: [], success: false, skipped: 'pdf-only source' };
    }
    if (isWmtBoxscore(boxUrl)) {
        return processWmtGame(game);
    }

    const attempt = opts?.attempt ?? 1;
    const waitLonger = opts?.waitLonger ?? false;
    const waitMs = opts?.waitMs ?? 1200;
    const scrollWaitMs = opts?.scrollWaitMs ?? 800;

    let page;
    const findWmtUrl = (html: string): string | null => {
        const match = html.match(/https?:\/\/wmt\.games\/[^\s"'<>]+/i);
        if (!match) return null;
        return match[0].replace(/&amp;/g, '&');
    };

    const findPdfUrls = (html: string): string[] => {
        const matches = html.match(/https?:\/\/[^\s"'<>]+\.pdf/gi) || [];
        return Array.from(new Set(matches.map(u => u.replace(/&amp;/g, '&'))));
    };

    const parseWmtPage = async (url: string, wait: { waitLonger: boolean; waitMs: number; scrollWaitMs: number }) => {
        const wmtPage = await browser.newPage({ viewport: VIEWPORT });
        await wmtPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await wmtPage.waitForTimeout(wait.waitLonger ? Math.max(wait.waitMs, 2500) : wait.waitMs);
        await wmtPage.waitForSelector('table', { timeout: 4000 }).catch(() => { });
        const wmtHtml = await wmtPage.content();
        await wmtPage.close();
        return boxParser.parse(wmtHtml, { sourceUrl: url });
    };

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
        const wmtUrl = findWmtUrl(html);
        const pdfUrls = findPdfUrls(html);

        // NOTE: HTML file saving has been removed to save disk space as requested.

        let res = boxParser.parse(html, { sourceUrl: boxUrl });

        // If Sidearm parsing failed but a WMT iframe is present, fetch and parse the WMT page instead.
        if (res.playerStats.length === 0 && wmtUrl) {
            let wmtRes = await parseWmtPage(wmtUrl, { waitLonger, waitMs, scrollWaitMs });
            if (wmtRes.playerStats.length === 0 && wmtUrl.includes('/match/full/')) {
                const compactUrl = wmtUrl.replace('/match/full/', '/match/');
                wmtRes = await parseWmtPage(compactUrl, { waitLonger: true, waitMs: Math.max(waitMs, 2000), scrollWaitMs: Math.max(scrollWaitMs, 1500) });
            }
            if (wmtRes.playerStats.length > 0) {
                res = wmtRes;
            }
        }

        // If first attempt found nothing, wait briefly and re-parse once before giving up this attempt
        if (res.playerStats.length === 0 && attempt === 1) {
            await page.waitForTimeout(waitLonger ? 1200 : 1000);
            const htmlRetry = await page.evaluate(() => document.documentElement.outerHTML);
            res = boxParser.parse(htmlRetry, { sourceUrl: boxUrl });
        }

        await page.close(); // Critical: close page immediately

        if (res.playerStats.length > 0) {
            const built = toPlayerRows(game, res.playerStats);
            if (built.foreign.length > 0) {
                logDebug(
                    `SKIP [${game.game_id}] ${boxUrl} is another fixture; it names ` +
                        `${built.foreign.join(', ')}, who did not play in this game.`
                );
                return {
                    rows: [],
                    success: false,
                    skipped: `page is another fixture (${built.foreign.join(', ')})`
                };
            }
            logDebug(`OK [${game.game_id}] Parsed ${res.playerStats.length} stats (attempt ${attempt})`);
            return { rows: built.rows, success: true };
        } else {
            const meta: string[] = [];
            if (wmtUrl) meta.push(`wmt=${wmtUrl}`);
            if (pdfUrls.length) meta.push(`pdfs=${pdfUrls.join('|')}`);
            logDebug(`WARN [${game.game_id}] No stats found (attempt ${attempt})${meta.length ? ' | ' + meta.join(' ; ') : ''}`);
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
    const args = process.argv.slice(2);
    const flags = new Set(args.filter(a => a.startsWith('--')));
    const positional = args.filter(a => !a.startsWith('--'));
    const [gamesCsv = 'data/games/2025/games.csv', limitArg] = positional;
    const limit = limitArg ? Number(limitArg) : undefined;

    /**
     * Skip games whose box score is already on disk and settled.
     *
     * A daily refresh otherwise re-fetches every game of the season to learn about the
     * two that were played yesterday — an hour of scraping, every day, against sites
     * that have no reason to serve it. Recently played games are still re-fetched, since
     * a box score published minutes after a final whistle is routinely corrected after.
     */
    const newOnly = flags.has('--new-only');
    const recheckAt = args.indexOf('--recheck-days');
    const recheckDays = recheckAt === -1 ? 3 : Number(args[recheckAt + 1]) || 3;
    const csvPath = path.resolve(process.cwd(), gamesCsv);

    if (!fs.existsSync(csvPath)) {
        console.error(`games.csv not found at ${csvPath}`);
        process.exit(1);
    }

    const teams = loadAllTeams();
    teamNameResolver = buildTeamNameResolver(teams);
    wmtHosts = new Set(
        teams
            .filter(t => t.platform_guess === 'wmt')
            .map(t => hostOf(t.schedule_url))
            .filter(Boolean)
    );

    const withUrl = parseGamesCsv(csvPath).filter(g => g.boxscore_url);

    /**
     * Only games that have been played.
     *
     * Schools publish a box-score link the moment a fixture is on the calendar, and for
     * some of them the link is generated from the date rather than from anything that
     * exists — Virginia's schedule carries `VA121326.PDF` for a national final in
     * December that has not been drawn, let alone played. Fetching those costs a request
     * each, returns nothing every time because there is nothing there, and files the
     * result as a failure: eighty-five of 2026's fixtures, on every single run.
     */
    let games = withUrl.filter(g => g.status === 'final');
    const unplayed = withUrl.length - games.length;
    if (unplayed > 0) {
        console.log(`Skipping ${unplayed} fixture(s) with a box-score link but no result yet.`);
    }

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

    // A box-score URL that several fixtures point at cannot be the box score of any one
    // of them. Some schools publish a single stale link on every row — Winthrop hands out
    // `boxscore.aspx?id=23965` for its whole season — and scraping it once per fixture
    // credits that one game's players with the same goals four or five times over, in
    // every season. Which fixture it really belongs to is not knowable from the page, so
    // the whole ambiguous group is dropped rather than attributed to a guess.
    const byBoxscore = new Map<string, GameRow[]>();
    for (const game of games) {
        const url = (game.boxscore_url || '').trim();
        if (!url) continue;
        byBoxscore.set(url, [...(byBoxscore.get(url) || []), game]);
    }
    const ambiguous = new Set<string>();
    for (const [url, claimants] of byBoxscore) {
        if (claimants.length < 2) continue;
        claimants.forEach(g => ambiguous.add(g.game_id));
        logDebug(`AMBIGUOUS ${claimants.length} games share ${url}; dropping all of them.`);
    }
    if (ambiguous.size > 0) {
        console.warn(
            `Dropping ${ambiguous.size} games whose box-score URL is shared with another fixture.`
        );
        games = games.filter(g => !ambiguous.has(g.game_id));
    }

    // The season's full game set, fixed before any narrowing below. Carry-forward reads
    // it to decide which stored rows still belong to this season; narrowing it would
    // make every game this run chose not to re-scrape look like one that had left the
    // dataset, and delete its stats.
    const seasonScope = new Set(games.map(g => g.game_id));
    const seasonYear = games[0]?.date?.split('-')[0] || String(new Date().getFullYear());

    if (newOnly) {
        const settled = await settledGames(seasonYear, games, recheckDays);
        const before = games.length;
        games = games.filter(g => !settled.has(g.game_id));
        console.log(
            `Incremental: ${games.length} of ${before} games need box scores ` +
                `(${before - games.length} already stored and older than ${recheckDays} days).`
        );
    }

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

    const rawDir = RAW_DIR;
    if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

    const boxParser = new SidearmBoxScoreParser();
    const allRows: PlayerRow[] = [];
    const failedGames: GameRow[] = [];
    /** Games that correctly yielded nothing, and why — not retried, not failures. */
    const skippedGames = new Map<string, { game: GameRow; reason: string }>();
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

        // Closed in `finally`: a throw inside a batch used to leave chromium and this
        // process alive. Locally that is a stray process; on a scheduled runner a run
        // that never exits makes the scheduler skip every run after it.
        try {
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
                    if (res.skipped) {
                        // Nothing to retry: the source has no player table to give.
                        skippedGames.set(chunk[idx].game_id, { game: chunk[idx], reason: res.skipped });
                    } else if (!res.success) {
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
                        if (res.skipped) {
                            skippedGames.set(retryChunk[idx].game_id, {
                                game: retryChunk[idx],
                                reason: res.skipped
                            });
                        } else if (!res.success) {
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
                            if (res.skipped) {
                                skippedGames.set(retryChunk[idx].game_id, {
                                    game: retryChunk[idx],
                                    reason: res.skipped
                                });
                            } else if (!res.success) {
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

        } finally {
            await browser.close();
        }
        logDebug(`Batch ${Math.floor(i / BATCH_SIZE) + 1} complete. Memory cleared.`);
    }

    // Write Output
    const year = seasonYear;
    // Resolved through `@ncaa/storage` like every other reader and writer — and like
    // `carryForwardMissingGames` below, which already did. While this line built its own
    // path from `__dirname`, the two disagreed the moment `NCAA_REPO_ROOT` was set: the
    // run carried rows forward from one tree and wrote the result into another.
    const outPath = playerStatsCsv(year);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const header = [
        'game_id', 'team_id', 'player_name', 'player_key', 'jersey_number',
        'minutes', 'goals', 'assists', 'shots', 'shots_on_goal', 'saves'
    ];

    // A transient failure — a rate limit, a slow render — must not delete stats an
    // earlier run already collected. Rows are kept per game: anything scraped this run
    // replaces what was stored for that game, and games that yielded nothing this time
    // keep the rows they had.
    const carried = await carryForwardMissingGames(outPath, allRows, seasonScope);
    if (carried.rows.length > 0) {
        logDebug(`Kept ${carried.rows.length} stats from ${carried.games} previously scraped games that returned nothing this run.`);
    }

    const lines = [header.join(',')];
    [...allRows, ...carried.rows].forEach(r => {
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

    // The log carries a reason, and skips are separated from failures. Without both, a
    // run that skipped twenty-one PDFs and failed five pages produced twenty-six
    // identical-looking lines, and the five worth acting on were indistinguishable.
    const failLogPath = FAILED_BOXSCORES_LOG;
    const failDir = path.dirname(failLogPath);
    const logged = [
        ...failedGames.map(game => ({ game, reason: 'no player table after 3 attempts' })),
        ...[...skippedGames.values()]
    ];

    if (logged.length > 0) {
        if (!fs.existsSync(failDir)) fs.mkdirSync(failDir, { recursive: true });
        const header = 'game_id,date,fixture,reason,boxscore_url,boxscore_url_alt';
        const lines = logged.map(({ game, reason }) =>
            [
                game.game_id,
                game.date,
                `${game.home_team_name} vs ${game.away_team_name}`,
                reason,
                game.boxscore_url ?? '',
                game.boxscore_url_alt || ''
            ]
                .map(value => escapeCsv(String(value)))
                .join(',')
        );
        fs.writeFileSync(failLogPath, [header, ...lines].join('\n'), 'utf8');
    } else if (fs.existsSync(failLogPath)) {
        // A clean run leaves no log behind, so a stale one from last week cannot be read
        // as this run's result.
        fs.unlinkSync(failLogPath);
    }

    const byReason = new Map<string, number>();
    for (const { reason } of logged) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    if (failedGames.length > 0) {
        console.warn(`${failedGames.length} game(s) still missing stats after retry.`);
    }
    if (skippedGames.size > 0) {
        console.log(`${skippedGames.size} game(s) skipped for reasons no retry would fix.`);
    }
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
        console.log(`   ${String(count).padStart(4)}  ${reason}`);
    }
    if (logged.length > 0) console.log(`   detail -> ${failLogPath}`);

    status.inFlight = 0;
    renderStatus(status);
    clearInterval(statusTimer);
}

/**
 * Rows from a previous run for games that produced nothing this time.
 *
 * Only games still on this run's slate are eligible. Older runs may hold rows under
 * game ids that no longer exist — a fixture stored before team names were canonicalised
 * keys differently — and re-appending those would double-count the same match under two
 * ids.
 *
 * @returns the rows to re-append, plus how many games they came from
 */
async function carryForwardMissingGames(
    outPath: string,
    freshRows: PlayerRow[],
    inScope: Set<string>
): Promise<{ rows: PlayerStatCsvRow[]; games: number }> {
    if (!fs.existsSync(outPath)) return { rows: [], games: 0 };

    const scrapedThisRun = new Set(freshRows.map(r => r.game_id));
    const rows: PlayerStatCsvRow[] = [];
    // Streamed: only the rows actually being carried forward are kept, rather than the
    // whole stored season plus the subset of it.
    try {
        for await (const row of streamRows<PlayerStatCsvRow>(outPath)) {
            if (row.game_id && inScope.has(row.game_id) && !scrapedThisRun.has(row.game_id)) {
                rows.push(row);
            }
        }
    } catch (e: any) {
        logDebug(`WARN Could not read existing stats at ${outPath}: ${e.message}`);
        return { rows: [], games: 0 };
    }

    return { rows, games: new Set(rows.map(r => r.game_id)).size };
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

/**
 * Games whose stats are already stored and old enough to be final.
 *
 * "Old enough" matters: a box score read minutes after full time is often incomplete,
 * and the school corrects it over the following days, so a recently played game is
 * re-fetched even though rows for it exist.
 */
async function settledGames(
    season: string,
    games: GameRow[],
    recheckDays: number
): Promise<Set<string>> {
    const outPath = playerStatsCsv(season);
    if (!fs.existsSync(outPath)) return new Set();

    // Streamed: this only ever needed the set of stored game ids, never the rows.
    const settled = new Set<string>();
    try {
        for await (const row of streamRows<PlayerStatCsvRow>(outPath)) {
            if (row.game_id) settled.add(row.game_id);
        }
    } catch {
        // Unreadable stats mean nothing is known to be stored, so nothing is skipped.
        return new Set();
    }

    const cutoff = new Date(Date.now() - recheckDays * 86400000).toISOString().slice(0, 10);
    for (const game of games) {
        if (game.date >= cutoff) settled.delete(game.game_id);
    }
    return settled;
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
