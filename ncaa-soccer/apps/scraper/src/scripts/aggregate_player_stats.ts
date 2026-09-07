/**
 * Season totals per player, from the per-game box scores.
 *
 * Streamed rather than read whole: `player_stats.csv` is 9-10 MB and up to 130,000 rows
 * per season, and nothing here needs two rows at once — every row folds straight into the
 * running total for its `player_key`.
 */

import * as fs from 'fs';
import {
    aggregatedStatsCsv,
    int,
    PlayerStatCsvRow,
    playerStatsCsv,
    streamRows,
    writeRows
} from '@ncaa/storage';

interface AggregatedStat {
    player_key: string;
    player_name: string;
    team_id: string;
    jersey_number: string;
    games_played: number;
    minutes: number;
    goals: number;
    assists: number;
    shots: number;
    shots_on_goal: number;
    saves: number;
}

/**
 * Which season to total up. Hardcoding it kept the dataset to a single year, so it is
 * an argument now that box scores exist for more than one.
 *
 * Usage: npx tsx apps/scraper/src/scripts/aggregate_player_stats.ts [season]
 */
const season = String(Number(process.argv[2]) || new Date().getFullYear());

const inputPath = playerStatsCsv(season);
const outputPath = aggregatedStatsCsv(season);

async function main(): Promise<void> {
    if (!fs.existsSync(inputPath)) {
        console.error(`No box scores for season ${season}: ${inputPath} does not exist.`);
        process.exit(1);
    }

    console.log(`Aggregating season ${season} from ${inputPath}...`);

    const aggregated = new Map<string, AggregatedStat>();
    let rows = 0;

    for await (const row of streamRows<PlayerStatCsvRow>(inputPath)) {
        rows++;
        const key = row.player_key;
        let stat = aggregated.get(key);
        if (!stat) {
            stat = {
                player_key: key,
                player_name: row.player_name,
                team_id: row.team_id,
                jersey_number: row.jersey_number,
                games_played: 0,
                minutes: 0,
                goals: 0,
                assists: 0,
                shots: 0,
                shots_on_goal: 0,
                saves: 0
            };
            aggregated.set(key, stat);
        }

        stat.games_played += 1;
        stat.minutes += int(row.minutes);
        stat.goals += int(row.goals);
        stat.assists += int(row.assists);
        stat.shots += int(row.shots);
        stat.shots_on_goal += int(row.shots_on_goal);
        stat.saves += int(row.saves);
    }

    console.log(`Parsed ${rows} rows.`);

    const outputRecords = [...aggregated.values()].sort((a, b) => {
        // Sort by Total Points (Goals * 2 + Assists) descending, then Minutes descending
        const pointsA = a.goals * 2 + a.assists;
        const pointsB = b.goals * 2 + b.assists;
        if (pointsB !== pointsA) return pointsB - pointsA;
        return b.minutes - a.minutes;
    });

    writeRows(outputPath, outputRecords);
    console.log(`Wrote ${outputRecords.length} aggregated rows to ${outputPath}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
