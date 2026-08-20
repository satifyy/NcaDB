/**
 * Builds the team inventory a scrape needs, given only conference rosters.
 *
 * The pipeline is driven by a teams JSON holding, per school, a men's soccer schedule
 * URL and which platform serves it. Writing that by hand does not scale past one
 * conference and goes stale as schools migrate between Sidearm and WMT, so this
 * derives it:
 *
 *   1. Harvest school -> athletics domain from schedule pages we can already reach.
 *      Sidearm renders each opponent as a link to that school's own site, and the WMT
 *      API carries `opponent.website_url`, so every scraped season hands us a batch of
 *      domains for free. Newly resolved schools are re-harvested, so coverage spreads.
 *   2. Probe each domain for a men's soccer schedule, trying the slugs the two
 *      platforms use and detecting the platform from the response.
 *   3. Verify the result actually yields games before writing it out.
 *
 * Usage:
 *   npx tsx apps/scraper/src/scripts/discover_teams.ts <rosters.json> [season] [outDir]
 *
 * `rosters.json` maps a conference name to its member schools:
 *   { "Big Ten": ["Indiana", "Maryland", ...], "Big East": [...] }
 */

import * as fs from 'fs';
import * as path from 'path';
import { cleanTeamName, WmtClient, seasonNameCandidates, sportSlugFromScheduleUrl } from '@ncaa/parsers';
import { loadTeams, TeamConfig } from '../utils/teams';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

/** Slugs the two platforms use for men's soccer, most common first. */
const SPORT_SLUGS = ['mens-soccer', 'msoc', 'm-soccer', 'mens-soccer-1'];

/** Domains probed in parallel; these are many small requests across many hosts. */
const CONCURRENCY = 12;

const SOCIAL_OR_VENDOR =
    /twitter|facebook|instagram|youtube|tiktok|ticketmaster|seatgeek|evenue|espn|sidearm|shopify|x\.com|google|apple|paciolan|learfield|hostedstats|statbroadcast|wmt\.|prestosports/i;

function slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Keys a school name can be recognised by, so "St. John's (NY)" harvested off one site
 * matches "St. John's" in a roster.
 *
 * "State" is never stripped: doing so collapses Michigan and Michigan State onto the
 * same key, and whichever is seen first then claims the other's athletics domain.
 */
function matchKeys(name: string): string[] {
    let base = cleanTeamName(name).name.toLowerCase();
    base = base.replace(/&/g, ' and ');
    base = base.replace(/\bst\.?\s*$/i, 'state');       // trailing "St." means State
    base = base.replace(/\bst\.?\s+(?=[a-z])/i, 'saint '); // leading "St." means Saint
    base = base.replace(/\s*\([^)]*\)\s*$/, '');        // "(United States)" disambiguators

    const keys = new Set<string>([slug(base)]);
    // Rosters give formal institution names ("University of the Pacific",
    // "Saint Mary's College of California"); athletics sites use the short form.
    const stripped = base
        .replace(/^the\s+/, '')
        .replace(/^university\s+(?:of\s+the|of|at|in)\s+/, '')
        .replace(/\s+(?:university|college)\s+of\s+.+$/, '')
        .replace(/[,]\s+.+$/, '')
        .trim();
    keys.add(slug(stripped));
    keys.add(slug(stripped.replace(/\s+(university|college)$/, '')));
    keys.add(slug(base.replace(/\b(university|college)\b/g, '')));
    keys.delete('');
    return [...keys];
}

async function get(url: string, timeoutMs = 20000): Promise<{ ok: boolean; status: number; body: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
            redirect: 'follow'
        });
        const body = await response.text();
        return { ok: response.ok, status: response.status, body };
    } catch {
        return { ok: false, status: 0, body: '' };
    } finally {
        clearTimeout(timer);
    }
}

/** School name -> athletics hostname, read off the opponents on a schedule page. */
function harvestFromHtml(html: string, ownHost: string): Map<string, string> {
    const found = new Map<string, string>();
    const anchor = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*title="([^"]{2,60})"/g;
    let match: RegExpExecArray | null;
    while ((match = anchor.exec(html))) {
        const [, href, rawTitle] = match;
        let host: string;
        try {
            host = new URL(href).hostname.replace(/^www\./, '');
        } catch {
            continue;
        }
        if (!host || host === ownHost || SOCIAL_OR_VENDOR.test(host)) continue;
        const name = cleanTeamName(rawTitle.replace(/&#39;/g, "'").replace(/&amp;/g, '&')).name;
        if (!name) continue;
        for (const key of matchKeys(name)) {
            if (!found.has(key)) found.set(key, host);
        }
    }
    return found;
}

/** Adds every pair from `from` that `into` does not already know. */
function absorb(into: Map<string, string>, from: Map<string, string>): number {
    let added = 0;
    for (const [key, host] of from) {
        if (!into.has(key)) {
            into.set(key, host);
            added++;
        }
    }
    return added;
}

async function harvestFromTeam(team: TeamConfig, season: number): Promise<Map<string, string>> {
    const ownHost = new URL(team.schedule_url).hostname.replace(/^www\./, '');

    if (team.platform_guess === 'wmt') {
        const found = new Map<string, string>();
        try {
            const sportSlug = sportSlugFromScheduleUrl(team.schedule_url);
            if (!sportSlug) return found;
            const events = await new WmtClient(team.schedule_url).fetchSeasonEvents(
                sportSlug,
                seasonNameCandidates(season)
            );
            for (const event of events) {
                const url = event.opponent?.website_url;
                const name = cleanTeamName(event.opponent_school_name || event.opponent_name).name;
                if (!url || !name) continue;
                try {
                    const host = new URL(url).hostname.replace(/^www\./, '');
                    if (host && host !== ownHost && !SOCIAL_OR_VENDOR.test(host)) {
                        for (const key of matchKeys(name)) if (!found.has(key)) found.set(key, host);
                    }
                } catch {
                    /* malformed opponent URL */
                }
            }
        } catch {
            /* season not published; nothing to harvest */
        }
        return found;
    }

    const page = await get(`${team.schedule_url.replace(/\/$/, '')}/${season}`);
    return page.ok ? harvestFromHtml(page.body, ownHost) : new Map();
}

export interface DiscoveredTeam extends TeamConfig {
    conference: string;
    sport: 'msoc';
    aliases: string[];
    verified_games?: number;
}

/** Finds the men's soccer schedule on a domain and identifies which platform serves it. */
async function probeDomain(
    host: string,
    schoolName: string,
    season: number
): Promise<{ schedule_url: string; platform: 'wmt' | 'wmt_wp' | 'sidearm'; games: number } | null> {
    for (const sportSlug of SPORT_SLUGS) {
        const scheduleUrl = `https://${host}/sports/${sportSlug}/schedule`;
        const page = await get(scheduleUrl);
        if (!page.ok || !page.body) continue;
        if (!/soccer/i.test(page.body.slice(0, 200000))) continue;

        if (page.body.includes('/website-api')) {
            try {
                const events = await new WmtClient(scheduleUrl).fetchSeasonEvents(
                    sportSlug,
                    seasonNameCandidates(season)
                );
                if (events.length > 0) {
                    return { schedule_url: scheduleUrl, platform: 'wmt', games: events.length };
                }
            } catch {
                /* right platform, wrong season: fall through and keep the URL below */
            }
            return { schedule_url: scheduleUrl, platform: 'wmt', games: 0 };
        }

        // Sidearm and WMT's WordPress product both render the season server-side.
        const seasonPage = await get(`${scheduleUrl}/${season}`);
        const body = seasonPage.ok ? seasonPage.body : page.body;
        const title = (body.match(/<title>([^<]*)/) || ['', ''])[1];

        // WMT's WordPress product, in either of the themes schools use for it.
        const wpRows = body.match(/class="[^"]*\bschedule-item\b[^"]*"|class="[^"]*\bschedule-table_row\b[^"]*"/g);
        if (body.includes('wmt-bulk-schedule-api') || (wpRows && wpRows.length > 3)) {
            return { schedule_url: scheduleUrl, platform: 'wmt_wp', games: wpRows ? wpRows.length : 0 };
        }

        if (/soccer/i.test(title) && !/404/.test(title)) {
            // Count rendered game cards, not the class names that also appear in CSS.
            const games = (
                body.match(/data-test-id="s-game-card-standard__root"|<li[^>]+class="[^"]*sidearm-schedule-game\b/g) || []
            ).length;
            return { schedule_url: scheduleUrl, platform: 'sidearm', games };
        }
    }
    return null;
}

/** Runs `worker` over `items` with at most `limit` in flight, preserving input order. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (let i = next++; i < items.length; i = next++) {
            results[i] = await worker(items[i]);
        }
    });
    await Promise.all(runners);
    return results;
}

function teamId(name: string): string {
    return name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/** Union of every conference inventory, for running the whole dataset in one pass. */
const COMBINED_FILE = 'p5_msoc_teams.json';

function conferenceFile(conference: string): string {
    return `${conference.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_teams.json`;
}

async function main(): Promise<void> {
    const [, , rostersArg, seasonArg, outDirArg] = process.argv;
    if (!rostersArg) {
        console.error('Usage: discover_teams.ts <rosters.json> [season] [outDir]');
        process.exit(1);
    }
    const season = Number(seasonArg) || new Date().getFullYear();
    const teamsDir = path.resolve(__dirname, '../../../../data/teams');
    const outDir = outDirArg ? path.resolve(process.cwd(), outDirArg) : teamsDir;
    const rosters: Record<string, string[]> = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), rostersArg), 'utf8')
    );

    // Seed the domain map from every inventory we already have.
    const domains = new Map<string, string>();
    const seeds: TeamConfig[] = [];
    for (const file of fs.readdirSync(teamsDir).filter(f => f.endsWith('_teams.json'))) {
        try {
            for (const team of loadTeams(path.join(teamsDir, file))) {
                if (!team.schedule_url) continue;
                seeds.push(team);
                const host = new URL(team.schedule_url).hostname.replace(/^www\./, '');
                for (const key of matchKeys(team.name_canonical)) domains.set(key, host);
            }
        } catch {
            /* not a teams inventory */
        }
    }
    console.log(`Seeded ${domains.size} name keys from ${seeds.length} known teams.`);

    const wanted = Object.entries(rosters);
    const written: DiscoveredTeam[] = [];
    const unresolved = () =>
        wanted.flatMap(([, schools]) => schools).filter(s => !matchKeys(s).some(k => domains.has(k)));

    // Harvest, then re-harvest from whatever that resolved, until nothing new appears.
    let frontier = seeds;
    for (let round = 1; round <= 3 && unresolved().length > 0; round++) {
        let added = 0;
        const harvested = await mapLimit(frontier, CONCURRENCY, team => harvestFromTeam(team, season));
        for (const batch of harvested) added += absorb(domains, batch);
        console.log(`Harvest round ${round}: +${added} domains, ${unresolved().length} schools still unresolved.`);
        if (added === 0) break;

        // Next round harvests from the schools this round just unlocked, since their
        // schedules name opponents the seed conference never played.
        const candidates = wanted
            .flatMap(([, schools]) => schools)
            .map(school => ({ school, host: matchKeys(school).map(key => domains.get(key)).find(Boolean) }))
            .filter(c => c.host && !seeds.some(seed => seed.schedule_url.includes(c.host!)));
        const probed = await mapLimit(candidates, CONCURRENCY, async c => ({
            school: c.school,
            probe: await probeDomain(c.host!, c.school, season)
        }));
        frontier = probed
            .filter(p => p.probe)
            .map(p => ({
                team_id: teamId(p.school),
                name_canonical: p.school,
                schedule_url: p.probe!.schedule_url,
                platform_guess: p.probe!.platform
            }) as TeamConfig);
    }

    for (const [conference, schools] of wanted) {
        const discovered: DiscoveredTeam[] = [];
        const failures: string[] = [];

        const resolved = await mapLimit(schools, CONCURRENCY, async school => {
            const host = matchKeys(school).map(key => domains.get(key)).find(Boolean);
            if (!host) return { school, host: null, probe: null };
            return { school, host, probe: await probeDomain(host, school, season) };
        });

        for (const { school, host, probe } of resolved) {
            if (!host) {
                failures.push(`${school} (no athletics domain found)`);
                continue;
            }
            if (!probe) {
                failures.push(`${school} (${host}: no men's soccer schedule)`);
                continue;
            }
            discovered.push({
                team_id: teamId(school),
                name_canonical: school,
                conference,
                sport: 'msoc',
                schedule_url: probe.schedule_url,
                platform_guess: probe.platform,
                parser_key: `${probe.platform === 'sidearm' ? 'sidearm' : probe.platform}_std`,
                aliases: [school],
                timezone: 'America/New_York',
                verified_games: probe.games
            });
            console.log(`  ${school} -> ${probe.schedule_url} [${probe.platform}] ${probe.games} events`);
        }

        // Never drop a school a previous run resolved: a transient fetch failure or a
        // renamed roster entry would otherwise silently shrink the inventory.
        const outPath = path.join(outDir, conferenceFile(conference));
        const merged = mergeWithExisting(outPath, discovered);
        const retained = merged.length - discovered.length;
        fs.writeFileSync(outPath, `${JSON.stringify(merged, null, 4)}\n`);
        console.log(
            `\n${conference}: ${discovered.length}/${schools.length} resolved` +
                `${retained > 0 ? `, ${retained} kept from a previous run` : ''} -> ${outPath}`
        );
        failures.forEach(f => console.warn(`  UNRESOLVED ${f}`));
        written.push(...merged);
    }

    // One inventory the scrapers can be pointed at for a whole-dataset run.
    const combinedPath = path.join(outDir, COMBINED_FILE);
    const combined = mergeInventories(outDir, written);
    fs.writeFileSync(combinedPath, `${JSON.stringify(combined, null, 4)}\n`);
    console.log(`\nCombined inventory: ${combined.length} teams -> ${combinedPath}`);
}

/** This run's results, plus any school an earlier run resolved that this one did not. */
function mergeWithExisting(outPath: string, discovered: DiscoveredTeam[]): DiscoveredTeam[] {
    if (!fs.existsSync(outPath)) return discovered;
    const byId = new Map(discovered.map(team => [team.team_id, team]));
    try {
        for (const team of JSON.parse(fs.readFileSync(outPath, 'utf8')) as DiscoveredTeam[]) {
            if (team?.team_id && team.schedule_url && !byId.has(team.team_id)) byId.set(team.team_id, team);
        }
    } catch {
        /* unreadable previous inventory; this run's results stand alone */
    }
    return [...byId.values()];
}

/**
 * Every conference inventory on disk, de-duplicated by `team_id`.
 *
 * Reads the sibling files rather than only this run's output, so discovering one
 * conference does not drop the others from the combined inventory.
 */
function mergeInventories(dir: string, justWritten: DiscoveredTeam[]): TeamConfig[] {
    const byId = new Map<string, TeamConfig>();
    for (const team of justWritten) byId.set(team.team_id, team);
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('_teams.json') || file === COMBINED_FILE || file === 'test_teams.json') continue;
        try {
            for (const team of loadTeams(path.join(dir, file))) {
                if (!byId.has(team.team_id)) byId.set(team.team_id, team);
            }
        } catch {
            /* not an inventory */
        }
    }
    return [...byId.values()];
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
