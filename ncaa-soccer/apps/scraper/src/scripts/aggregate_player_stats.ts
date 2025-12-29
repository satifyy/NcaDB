import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

interface PlayerStatRow {
    game_id: string;
    team_id: string;
    player_name: string;
    player_key: string;
    jersey_number: string;
    minutes: string;
    goals: string;
    assists: string;
    shots: string;
    shots_on_goal: string;
    saves: string;
}

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

const inputPath = path.join(process.cwd(), 'data/player_stats/2025/player_stats.csv');
const outputPath = path.join(process.cwd(), 'data/player_stats/2025/aggregated_player_stats.csv');

if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
}

console.log(`Reading stats from ${inputPath}...`);
const fileContent = fs.readFileSync(inputPath, 'utf-8');
const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true
}) as PlayerStatRow[];

console.log(`Parsed ${records.length} rows.`);

const aggregated: Record<string, AggregatedStat> = {};

for (const row of records) {
    const key = row.player_key;
    if (!aggregated[key]) {
        aggregated[key] = {
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
    }

    const stat = aggregated[key];
    stat.games_played += 1;
    stat.minutes += parseInt(row.minutes, 10) || 0;
    stat.goals += parseInt(row.goals, 10) || 0;
    stat.assists += parseInt(row.assists, 10) || 0;
    stat.shots += parseInt(row.shots, 10) || 0;
    stat.shots_on_goal += parseInt(row.shots_on_goal, 10) || 0;
    stat.saves += parseInt(row.saves, 10) || 0;
}

const outputRecords = Object.values(aggregated).sort((a, b) => {
    // Sort by Total Points (Goals * 2 + Assists) descending, then Minutes descending
    const pointsA = a.goals * 2 + a.assists;
    const pointsB = b.goals * 2 + b.assists;
    if (pointsB !== pointsA) return pointsB - pointsA;
    return b.minutes - a.minutes;
});

const csvOutput = stringify(outputRecords, {
    header: true
});

fs.writeFileSync(outputPath, csvOutput);
console.log(`Wrote ${outputRecords.length} aggregated rows to ${outputPath}`);
