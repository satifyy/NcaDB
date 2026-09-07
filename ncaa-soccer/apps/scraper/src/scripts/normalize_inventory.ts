/**
 * Repairs the team inventories in place: one entry per school, filed under the name the
 * scraped data actually uses.
 *
 * Two defects accumulated while the inventory grew from five conferences to all of D1,
 * both of them from discovery trusting Wikipedia's roster spellings:
 *
 *   1. **Duplicates.** Discovery merged by `team_id`. The hand-written entry files Duke
 *      as `DUKE`; the roster says "Duke University", which mints `DUKE_UNIVERSITY`, and
 *      the merge kept both — `acc_teams.json` reached 27 entries for a 15-team
 *      conference.
 *   2. **Formal names.** The generated conferences carry institution names ("Loyola
 *      Marymount University", "University of the Pacific"), while every row in
 *      `games.csv` and `player_stats.csv` carries the athletics short form. Scraping
 *      against the formal name files the same school twice, once per source.
 *
 * Discovery no longer introduces either, but it also cannot undo what is already on
 * disk: it treats an existing entry's name as established and keeps it. So this pass
 * exists to fix the written data once, and is safe to re-run — it is idempotent.
 *
 * The authority for what a school is called is the dataset itself. Every distinct team
 * name across `data/games` and `data/player_stats` is a spelling some athletics site
 * published, which is exactly the vocabulary a future scrape has to dedupe against.
 *
 * Usage:
 *   npx tsx apps/scraper/src/scripts/normalize_inventory.ts          # report only
 *   npx tsx apps/scraper/src/scripts/normalize_inventory.ts --write  # apply
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    DATA_DIR,
    GameCsvRow,
    gamesCsv,
    PlayerStatCsvRow,
    playerStatsCsv,
    readAllIfExists,
    seasonsWithGames,
    seasonsWithPlayerStats,
    streamRowsIfExists,
    TEAMS_DIR
} from '@ncaa/storage';
import { cleanTeamName } from '@ncaa/parsers';
import { TeamConfig, loadTeams } from '../utils/teams';
import {
    SchoolIndex,
    matchKeys,
    mergeAliases,
    pickCanonicalName,
    sameSchool,
    teamId
} from '../utils/school_names';

const COMBINED_FILE = 'd1_msoc_teams.json';
const LEGACY_COMBINED_FILES = new Set([COMBINED_FILE, 'p5_msoc_teams.json']);
const NOT_AN_INVENTORY = new Set([...LEGACY_COMBINED_FILES, 'test_teams.json']);

/** Every spelling the scraped data uses, with how often, keyed by match key. */
type Vocabulary = Map<string, Map<string, number>>;

/**
 * Every team name appearing in the scraped data, indexed by the keys it answers to.
 *
 * This is the authority for what a school is called: each entry is a spelling some
 * athletics site published and some row was written under, which is exactly what a
 * future scrape has to dedupe against.
 */
async function readDatasetNames(): Promise<Vocabulary> {
    const vocabulary: Vocabulary = new Map();

    const record = (raw: string | undefined) => {
        const name = cleanTeamName(raw || '').name.trim();
        // Conference names and tournament placeholders ride along in opponent columns.
        if (!name || name.length < 2 || /^(unknown|tbd|tba)$/i.test(name)) return;
        for (const key of matchKeys(name)) {
            if (!vocabulary.has(key)) vocabulary.set(key, new Map());
            const bucket = vocabulary.get(key)!;
            bucket.set(name, (bucket.get(name) || 0) + 1);
        }
    };

    // The schedules are small enough to read whole; the box scores are not — a season is
    // 9-10 MB, and all this needs from them is one column, so they are streamed.
    for (const season of seasonsWithGames()) {
        for (const row of readAllIfExists<GameCsvRow>(gamesCsv(season))) {
            record(row.home_team_name);
            record(row.away_team_name);
        }
    }
    for (const season of seasonsWithPlayerStats()) {
        for await (const row of streamRowsIfExists<PlayerStatCsvRow>(playerStatsCsv(season))) {
            record(row.team_id);
        }
    }
    return vocabulary;
}

/**
 * The spelling the dataset uses for a school, if it has seen one.
 *
 * Where the data holds several — "Pacific" 291 times, "University of the Pacific" 15 —
 * the one the dataset leans on wins, since renaming to the rare spelling would leave the
 * inventory disagreeing with almost every row it describes.
 */
function datasetName(vocabulary: Vocabulary, name: string): string | undefined {
    const candidates = new Map<string, number>();
    for (const key of matchKeys(name)) {
        for (const [spelling, count] of vocabulary.get(key) || []) {
            if (!sameSchool(name, spelling)) continue;
            candidates.set(spelling, (candidates.get(spelling) || 0) + count);
        }
    }
    if (candidates.size === 0) return undefined;
    return [...candidates.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0])
    )[0][0];
}

interface Repair {
    entries: TeamConfig[];
    renamed: [string, string][];
    dropped: string[];
}

/**
 * One entry per school, named as the dataset names it.
 *
 * When two entries turn out to be the same school, the one that keeps its schedule URL
 * is the one with verified games behind it, since that URL is known to have produced a
 * season; the other's spellings survive as aliases.
 */
function repairInventory(teams: TeamConfig[], vocabulary: Vocabulary): Repair {
    const index = new SchoolIndex<TeamConfig>();
    const renamed: [string, string][] = [];
    const dropped: string[] = [];

    for (const team of teams) {
        // A spelling the dataset already uses is not a guess to be weighed against the
        // shortened roster name — it is the name every scraped row literally carries, so
        // it settles the question. Without that, "Boston University" shortens to
        // "Boston" and stops matching its own rows (and collides with Boston College).
        const canonical = pickCanonicalName(
            team.name_canonical,
            undefined,
            datasetName(vocabulary, team.name_canonical)
        );
        const repaired: TeamConfig = {
            ...team,
            team_id: teamId(canonical),
            name_canonical: canonical,
            aliases: mergeAliases(canonical, [team.name_canonical, ...(team.aliases || [])])
        };
        if (canonical !== team.name_canonical) renamed.push([team.name_canonical, canonical]);

        const existing = index.add(repaired);
        if (!existing) continue;

        // Same school twice. Keep the better-evidenced entry, absorb the other's names.
        const incomingGames = (repaired as any).verified_games ?? 0;
        const existingGames = (existing as any).verified_games ?? 0;
        const keepIncoming =
            incomingGames > existingGames ||
            (incomingGames === existingGames && repaired.name_canonical.length < existing.name_canonical.length);
        const winner = keepIncoming ? repaired : existing;
        const loser = keepIncoming ? existing : repaired;
        dropped.push(loser.name_canonical);

        winner.aliases = mergeAliases(winner.name_canonical, [
            ...(winner.aliases || []),
            loser.name_canonical,
            ...(loser.aliases || [])
        ]);
        if (keepIncoming) index.replace(repaired);
    }

    return { entries: index.all(), renamed, dropped };
}

async function main(): Promise<void> {
    const write = process.argv.includes('--write');
    const vocabulary = await readDatasetNames();
    console.log(`Dataset vocabulary: ${vocabulary.size} name keys from data/games and data/player_stats.\n`);

    const union = new SchoolIndex<TeamConfig>();
    let totalRenamed = 0;
    let totalDropped = 0;

    for (const file of fs.readdirSync(TEAMS_DIR).sort()) {
        if (!file.endsWith('_teams.json') || NOT_AN_INVENTORY.has(file)) continue;
        let teams: TeamConfig[];
        try {
            teams = loadTeams(path.join(TEAMS_DIR, file));
        } catch {
            continue;
        }

        const { entries, renamed, dropped } = repairInventory(teams, vocabulary);
        totalRenamed += renamed.length;
        totalDropped += dropped.length;

        const changed = renamed.length > 0 || dropped.length > 0;
        console.log(`${file}: ${teams.length} -> ${entries.length}${changed ? '' : '  (unchanged)'}`);
        for (const [from, to] of renamed) console.log(`    rename  ${from}  ->  ${to}`);
        for (const name of dropped) console.log(`    dedupe  ${name}`);

        if (write) fs.writeFileSync(path.join(TEAMS_DIR, file), `${JSON.stringify(entries, null, 4)}\n`);

        entries.forEach(team => union.add(team));
    }

    console.log(`\n${totalRenamed} renamed, ${totalDropped} duplicates merged.`);
    console.log(`Union: ${union.size} teams -> ${COMBINED_FILE}`);
    if (write) {
        fs.writeFileSync(path.join(TEAMS_DIR, COMBINED_FILE), `${JSON.stringify(union.all(), null, 4)}\n`);
        console.log('Written.');
    } else {
        console.log('\nDry run. Re-run with --write to apply.');
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
