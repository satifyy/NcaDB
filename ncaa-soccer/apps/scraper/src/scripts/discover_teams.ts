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
import { TEAMS_DIR } from '@ncaa/storage';
import { loadTeams, TeamConfig } from '../utils/teams';
import { countSidearmCards, countWordpressRows } from '../utils/season_probe';
import {
    SchoolIndex,
    matchKeys,
    mergeAliases,
    pickCanonicalName,
    sameSchool,
    teamId
} from '../utils/school_names';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

/** Slugs the two platforms use for men's soccer, most common first. */
const SPORT_SLUGS = ['mens-soccer', 'msoc', 'm-soccer', 'mens-soccer-1'];

/** Domains probed in parallel; these are many small requests across many hosts. */
const CONCURRENCY = 12;

const SOCIAL_OR_VENDOR =
    /twitter|facebook|instagram|youtube|tiktok|ticketmaster|seatgeek|evenue|espn|sidearm|shopify|x\.com|google|apple|paciolan|learfield|hostedstats|statbroadcast|wmt\.|prestosports/i;

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

/**
 * An athletics site found for a school, with the spelling that site used for it.
 *
 * The name matters as much as the host: rosters spell schools formally, athletics sites
 * spell them the way every scraped row will, and the inventory has to agree with the
 * rows.
 */
interface Harvest {
    host: string;
    name: string;
}

/** School name -> athletics site, read off the opponents on a schedule page. */
function harvestFromHtml(html: string, ownHost: string): Map<string, Harvest> {
    const found = new Map<string, Harvest>();
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
            if (!found.has(key)) found.set(key, { host, name });
        }
    }
    return found;
}

/**
 * The athletics site harvested for a school, if one of its keys found a match.
 *
 * The harvested name is checked against the school rather than trusted outright: the
 * map is keyed by match key, and the loose key `boston` is shared by Boston College and
 * Boston University, so a bare lookup would hand one school the other's site and scrape
 * the wrong program under its name.
 */
function lookupDomain(domains: Map<string, Harvest>, school: string): Harvest | undefined {
    for (const key of matchKeys(school)) {
        const harvest = domains.get(key);
        if (harvest && sameSchool(harvest.name, school)) return harvest;
    }
    return undefined;
}

/** Adds every pair from `from` that `into` does not already know. */
function absorb(into: Map<string, Harvest>, from: Map<string, Harvest>): number {
    let added = 0;
    for (const [key, harvest] of from) {
        if (!into.has(key)) {
            into.set(key, harvest);
            added++;
        }
    }
    return added;
}

async function harvestFromTeam(team: TeamConfig, season: number): Promise<Map<string, Harvest>> {
    const ownHost = new URL(team.schedule_url).hostname.replace(/^www\./, '');

    if (team.platform_guess === 'wmt') {
        const found = new Map<string, Harvest>();
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
                        for (const key of matchKeys(name)) if (!found.has(key)) found.set(key, { host, name });
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
        const wpRows = countWordpressRows(body);
        if (body.includes('wmt-bulk-schedule-api') || wpRows > 3) {
            return { schedule_url: scheduleUrl, platform: 'wmt_wp', games: wpRows };
        }

        if (/soccer/i.test(title) && !/404/.test(title)) {
            return { schedule_url: scheduleUrl, platform: 'sidearm', games: countSidearmCards(body) };
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

/** Union of every conference inventory, for running the whole dataset in one pass. */
const COMBINED_FILE = 'd1_msoc_teams.json';

/**
 * Union files, which are outputs rather than inventories and must never be read back in
 * as one. `p5_msoc_teams.json` is the name this file had while the dataset was five
 * conferences; it is kept here so a stale copy on disk is still excluded.
 */
const LEGACY_COMBINED_FILES = new Set([COMBINED_FILE, 'p5_msoc_teams.json']);

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
    const teamsDir = TEAMS_DIR;
    const outDir = outDirArg ? path.resolve(process.cwd(), outDirArg) : teamsDir;
    const rosters: Record<string, string[]> = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), rostersArg), 'utf8')
    );

    // Seed the domain map from every inventory we already have.
    const domains = new Map<string, Harvest>();
    const seeds: TeamConfig[] = [];
    for (const file of fs.readdirSync(teamsDir).filter(f => f.endsWith('_teams.json'))) {
        // Union files are outputs, not inventories. Seeding from one would let a stale
        // union re-establish a name a conference file has since had repaired.
        if (file === 'test_teams.json' || LEGACY_COMBINED_FILES.has(file)) continue;
        try {
            for (const team of loadTeams(path.join(teamsDir, file))) {
                if (!team.schedule_url) continue;
                seeds.push(team);
                const host = new URL(team.schedule_url).hostname.replace(/^www\./, '');
                for (const key of matchKeys(team.name_canonical)) {
                    domains.set(key, { host, name: team.name_canonical });
                }
            }
        } catch {
            /* not a teams inventory */
        }
    }

    // What earlier runs already decided a school is called, reachable from any spelling
    // it answers to. Keyed across every conference, not just the one being discovered,
    // so a school that changed conference keeps its established name and id.
    const established = new SchoolIndex<TeamConfig>();
    seeds.forEach(team => established.add(team));
    console.log(`Seeded ${domains.size} name keys from ${seeds.length} known teams.`);

    const wanted = Object.entries(rosters);
    const written: DiscoveredTeam[] = [];
    const unresolved = () =>
        wanted.flatMap(([, schools]) => schools).filter(school => !lookupDomain(domains, school));

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
            .map(school => ({ school, found: lookupDomain(domains, school) }))
            .filter(c => c.found && !seeds.some(seed => seed.schedule_url.includes(c.found!.host)));
        const probed = await mapLimit(candidates, CONCURRENCY, async c => ({
            school: c.school,
            probe: await probeDomain(c.found!.host, c.school, season)
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
            const found = lookupDomain(domains, school);
            if (!found) return { school, found: null, probe: null };
            return { school, found, probe: await probeDomain(found.host, school, season) };
        });

        for (const { school, found, probe } of resolved) {
            if (!found) {
                failures.push(`${school} (no athletics domain found)`);
                continue;
            }
            if (!probe) {
                failures.push(`${school} (${found.host}: no men's soccer schedule)`);
                continue;
            }

            // A school the inventory already holds keeps its name and id, whatever the
            // roster calls it — otherwise "Duke University" mints DUKE_UNIVERSITY beside
            // the DUKE that every 2025 row was scraped under.
            const prior = established.find(school);
            const nameCanonical = pickCanonicalName(school, found.name, prior?.name_canonical);
            const id = prior?.team_id || teamId(nameCanonical);
            const entry: DiscoveredTeam = {
                team_id: id,
                name_canonical: nameCanonical,
                conference,
                sport: 'msoc',
                schedule_url: probe.schedule_url,
                platform_guess: probe.platform,
                parser_key: `${probe.platform === 'sidearm' ? 'sidearm' : probe.platform}_std`,
                aliases: mergeAliases(nameCanonical, [school, found.name, ...(prior?.aliases || [])]),
                timezone: prior?.timezone || 'America/New_York',
                verified_games: probe.games
            };
            discovered.push(entry);
            // Later conferences in this same run must see the decision too, or a school
            // listed twice across rosters is named one way here and another way there.
            established.add(entry);

            const renamed = nameCanonical === school ? '' : ` (roster: ${school})`;
            console.log(`  ${nameCanonical}${renamed} -> ${probe.schedule_url} [${probe.platform}] ${probe.games} events`);
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

/**
 * This run's results, plus any school an earlier run resolved that this one did not.
 *
 * Schools are matched by name identity rather than `team_id`. Keying on the id alone let
 * one school enter the inventory twice: the hand-written entry files Duke as `DUKE`, a
 * roster spelling of "Duke University" mints `DUKE_UNIVERSITY`, and the merge kept both.
 */
function mergeWithExisting(outPath: string, discovered: DiscoveredTeam[]): DiscoveredTeam[] {
    if (!fs.existsSync(outPath)) return discovered;
    const merged = new SchoolIndex<DiscoveredTeam>();
    discovered.forEach(team => merged.add(team));
    try {
        for (const team of JSON.parse(fs.readFileSync(outPath, 'utf8')) as DiscoveredTeam[]) {
            if (team?.team_id && team.schedule_url) merged.add(team);
        }
    } catch {
        /* unreadable previous inventory; this run's results stand alone */
    }
    return merged.all();
}

/**
 * Every conference inventory on disk, de-duplicated by name identity.
 *
 * Reads the sibling files rather than only this run's output, so discovering one
 * conference does not drop the others from the combined inventory. De-duplicating by
 * identity rather than `team_id` matters most here: the union is what a whole-dataset
 * run is pointed at, so a school listed twice is a school scraped twice.
 */
function mergeInventories(dir: string, justWritten: DiscoveredTeam[]): TeamConfig[] {
    const merged = new SchoolIndex<TeamConfig>();
    justWritten.forEach(team => merged.add(team));
    for (const file of fs.readdirSync(dir).sort()) {
        if (!file.endsWith('_teams.json') || LEGACY_COMBINED_FILES.has(file) || file === 'test_teams.json') continue;
        try {
            loadTeams(path.join(dir, file)).forEach(team => merged.add(team));
        } catch {
            /* not an inventory */
        }
    }
    return merged.all();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
