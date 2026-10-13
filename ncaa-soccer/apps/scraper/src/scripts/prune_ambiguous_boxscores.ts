/**
 * Removes player rows scraped from a box score that several fixtures claim.
 *
 * Some schools publish one stale box-score link on every schedule row — Winthrop serves
 * `boxscore.aspx?id=23965` for its whole season — so that single game's players were
 * scraped once per fixture and credited with the same goals four or five times over.
 * Pablo Ortega's 2 goals in one game became 8 a season, in all five seasons.
 *
 * `fetch_boxscores_from_csv.ts` now refuses these while scraping, but the seasons already
 * on disk were collected before that, and re-fetching five seasons to correct 2-4% of
 * their games is hours of scraping for something that can be deleted directly.
 *
 * Which fixture the page really belongs to is not recoverable from it, so the entire
 * ambiguous group goes. Re-run `aggregate_player_stats.ts` afterwards.
 *
 * Usage:
 *   npx tsx apps/scraper/src/scripts/prune_ambiguous_boxscores.ts          # report only
 *   npx tsx apps/scraper/src/scripts/prune_ambiguous_boxscores.ts --write  # apply
 */

import * as fs from 'fs';
import {
    GameCsvRow,
    gamesCsv,
    PlayerStatCsvRow,
    playerStatsCsv,
    readAllIfExists,
    seasonsWithPlayerStats,
    STATS_DIR,
    streamRows,
    writeRows
} from '@ncaa/storage';

function ambiguousGameIds(season: string): Set<string> {
    const rows = readAllIfExists<GameCsvRow>(gamesCsv(season));

    const claimants = new Map<string, string[]>();
    for (const row of rows) {
        const url = (row.boxscore_url || '').trim();
        if (!url) continue;
        claimants.set(url, [...(claimants.get(url) || []), row.game_id]);
    }

    const ambiguous = new Set<string>();
    for (const ids of claimants.values()) {
        if (ids.length > 1) ids.forEach(id => ambiguous.add(id));
    }
    return ambiguous;
}

async function main(): Promise<void> {
    const write = process.argv.includes('--write');
    if (!fs.existsSync(STATS_DIR)) {
        console.error(`No stats under ${STATS_DIR}.`);
        process.exit(1);
    }

    let totalRows = 0;
    for (const season of seasonsWithPlayerStats()) {
        const statsPath = playerStatsCsv(season);
        const ambiguous = ambiguousGameIds(season);

        // Streamed: only the rows being *kept* are held, and on a season where nothing is
        // ambiguous that is still cheaper than parsing the file into an array first.
        const kept: PlayerStatCsvRow[] = [];
        let total = 0;
        for await (const row of streamRows<PlayerStatCsvRow>(statsPath)) {
            total++;
            if (!ambiguous.has(row.game_id)) kept.push(row);
        }
        const dropped = total - kept.length;
        totalRows += dropped;

        console.log(
            `${season}: ${ambiguous.size} ambiguous games, ${dropped} of ${total} player rows affected`
        );
        if (write && dropped > 0) writeRows(statsPath, kept);
    }

    console.log(`\n${totalRows} player rows ${write ? 'removed' : 'would be removed'}.`);
    if (write) console.log('Re-run aggregate_player_stats.ts for each season.');
    else console.log('Dry run. Re-run with --write to apply.');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
