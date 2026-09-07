/**
 * One name per school, shared by everything downstream of the CSVs.
 *
 * Team names arrive spelled however the site that published them felt like spelling
 * them, and until they are collapsed onto one name per school every consumer counts the
 * same school several times. That mattered for the dashboard's filters first, so the
 * resolution lived inside `generate_dashboard_data.ts`; it now also decides who an Elo
 * rating belongs to and which roster a prediction is about, and a rating attached to
 * "Colgate" while the fixture says "Colgate University" is a silently missing team.
 * So it lives here, resolved once and read by all of them.
 *
 * The two halves are quite different. The inventory resolves the schools it holds by
 * name; the rest are resolved by **roster overlap**, because two different schools
 * never share players and no string rule separates "MU"/"Mercer" (one school) from
 * "SMU"/"Saint Michael's" (two).
 */

import * as fs from 'fs';
import {
    AggregatedPlayerCsvRow,
    aggregatedStatsCsv,
    INVENTORY,
    readAllIfExists,
    seasonsWithAggregatedStats,
    seasonsWithGames
} from '@ncaa/storage';
import { cleanTeamName } from '@ncaa/parsers';
import { SchoolIndex } from './school_names';
import { loadTeams, TeamConfig, DEFAULT_ALIASES_PATH } from './teams';

// Re-exported rather than re-derived: `@ncaa/storage` owns where the data lives, and the
// seven modules that already import these from here keep working unchanged.
export { REPO_ROOT, STATS_DIR, GAMES_DIR, INVENTORY } from '@ncaa/storage';

/**
 * Teams whose conference is not known.
 *
 * Mostly opponents outside Division I — schools field exhibitions against nearby D2, D3
 * and NAIA programs, and those box scores are scraped like any other — plus the handful
 * of D1 programs discovery has not resolved yet. Named rather than blanked so the filter
 * can offer it, since hiding a fifth of the players behind an empty string reads as a
 * bug.
 */
export const UNAFFILIATED = 'Other / Non-D1';

/**
 * The inventory, searchable by every spelling a school answers to.
 *
 * `team_aliases.json` is folded in because it is where the abbreviations the stats
 * actually use are recorded — "LMU", "UNCG", "Hoyas" — and without them a fifth of the
 * players land in {@link UNAFFILIATED} despite their school being right there in the
 * inventory.
 */
export function buildTeamIndex(): SchoolIndex<TeamConfig> {
    const teams = loadTeams(INVENTORY);
    let byTeamId: Record<string, string[]> = {};
    try {
        byTeamId = JSON.parse(fs.readFileSync(DEFAULT_ALIASES_PATH, 'utf8'));
    } catch {
        /* no alias file; canonical names and inventory aliases still apply */
    }

    const index = new SchoolIndex<TeamConfig>();
    for (const team of teams) {
        index.add({
            ...team,
            aliases: [...(team.aliases || []), ...(byTeamId[team.team_id] || [])]
        });
    }
    return index;
}

/** A roster overlap this large, within one season, identifies a spelling as a team. */
const ROSTER_SHARED = 5;
const ROSTER_FRACTION = 0.6;

export function normalisePlayer(name: string): string {
    return name.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * One name per school, for every school appearing in the data.
 *
 * Opponents are written differently by different sites, and schools the inventory does
 * not hold have no entry to normalise against, so the team filter fills with the same
 * school several times over: "Cal State Northridge" beside "CSUN", "Colgate" beside
 * "Colgate (PL Semifinals)". Names alone cannot resolve that — no string rule makes "MU"
 * and "Mercer" one school without also making "SMU" and "Saint Michael's" one school,
 * which they are not.
 *
 * Rosters can, because two different schools never share players. But roster overlap is
 * only safe as a direct test against a known team, never as something to chain: several
 * spellings in the raw data are ambiguous ("Loyola" covers two different programs, and
 * its roster is the union of both), and one such spelling transitively welds every team
 * it touches into a single 674-player blob. So each spelling is matched against the
 * inventory's teams and nothing else, and a spelling that matches more than one is left
 * alone rather than guessed at.
 */
export function canonicalTeamNames(seasons: string[], teams: SchoolIndex<TeamConfig>): Map<string, string> {
    const counts = new Map<string, number>();
    const rosters: { season: string; byTeam: Map<string, Set<string>> }[] = [];

    for (const season of seasons) {
        const rows = readAllIfExists<AggregatedPlayerCsvRow>(aggregatedStatsCsv(season));

        const byTeam = new Map<string, Set<string>>();
        for (const row of rows) {
            const name = cleanTeamName(row.team_id).name || row.team_id;
            const player = normalisePlayer(row.player_name || '');
            if (!name || !player) continue;
            counts.set(name, (counts.get(name) || 0) + 1);
            if (!byTeam.has(name)) byTeam.set(name, new Set());
            byTeam.get(name)!.add(player);
        }
        rosters.push({ season, byTeam });
    }

    const canonical = new Map<string, string>();

    // Resolving a spelling against the inventory walks every entry and rebuilds its match
    // keys, so it is done once per spelling here rather than inside the roster loops
    // below, where it would run hundreds of thousands of times.
    const knownAs = new Map<string, string | undefined>();
    for (const name of counts.keys()) knownAs.set(name, teams.findUnique(name)?.name_canonical);

    const unresolved: string[] = [];
    for (const name of counts.keys()) {
        const known = knownAs.get(name);
        if (known) canonical.set(name, known);
        else unresolved.push(name);
    }

    // For the rest, ask each season's rosters which known team — if exactly one — this
    // spelling was fielding.
    for (const name of unresolved) {
        const votes = new Map<string, number>();
        for (const { byTeam } of rosters) {
            const roster = byTeam.get(name);
            if (!roster || roster.size < ROSTER_SHARED) continue;

            for (const [other, otherRoster] of byTeam) {
                if (other === name) continue;
                const known = knownAs.get(other);
                if (!known) continue;
                let shared = 0;
                for (const player of roster) if (otherRoster.has(player)) shared++;
                if (shared >= ROSTER_SHARED && shared / roster.size >= ROSTER_FRACTION) {
                    votes.set(known, (votes.get(known) || 0) + 1);
                }
            }
        }
        // Ambiguous spellings — the ones whose roster is really two schools' — match more
        // than one team and are deliberately left as themselves.
        if (votes.size === 1) canonical.set(name, [...votes.keys()][0]);
    }

    // Whatever is still unresolved keeps its most-used spelling, so at least the variants
    // that are plainly the same string-wise collapse.
    const remaining = [...counts.entries()]
        .filter(([name]) => !canonical.has(name))
        .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
        .map(([name]) => name);
    const byIdentity = new SchoolIndex<{ name_canonical: string }>();
    for (const name of remaining) {
        const existing = byIdentity.add({ name_canonical: name });
        canonical.set(name, existing ? existing.name_canonical : name);
    }

    return canonical;
}

/**
 * Resolves any spelling onto its canonical school.
 *
 * `canonicalTeamNames` is built from the *player stats*, so it only knows spellings that
 * reached a box score. `games.csv` carries names for fixtures that were never scraped for
 * players — cancelled games, this week's fixtures, teams whose stats feed is empty — and
 * those still need a name to rate. So the map is tried first, then the inventory, and the
 * cleaned spelling is the fallback.
 */
export function makeTeamResolver(
    canonical: Map<string, string>,
    teams: SchoolIndex<TeamConfig>
): (raw: string) => string {
    const cache = new Map<string, string>();
    return (raw: string): string => {
        const cached = cache.get(raw);
        if (cached !== undefined) return cached;
        const cleaned = cleanTeamName(raw).name || raw;
        const resolved = canonical.get(cleaned) || teams.findUnique(cleaned)?.name_canonical || cleaned;
        cache.set(raw, resolved);
        return resolved;
    };
}

/** Season directories holding aggregated stats, oldest first. */
export const seasonsOnDisk = seasonsWithAggregatedStats;

/** Season directories holding a schedule, oldest first. Rated seasons need only this. */
export const gameSeasonsOnDisk = seasonsWithGames;
