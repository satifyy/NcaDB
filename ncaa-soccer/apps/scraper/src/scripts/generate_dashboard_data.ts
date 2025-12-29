import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';

// Define the shape of our aggregated data based on the CSV structure
interface AggregatedStat {
    player_key: string;
    player_name: string;
    team_id: string;
    jersey_number: string;
    games_played: string; // CSV parse returns strings by default
    minutes: string;
    goals: string;
    assists: string;
    shots: string;
    shots_on_goal: string;
    saves: string;
}

const inputPath = path.join(process.cwd(), 'data/player_stats/2025/aggregated_player_stats.csv');
const outputPath = path.join(process.cwd(), 'apps/dashboard/data.js');

if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
}

console.log(`Reading stats from ${inputPath}...`);
const fileContent = fs.readFileSync(inputPath, 'utf-8');
const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true
}) as AggregatedStat[];

console.log(`Parsed ${records.length} records.`);

// Transform data if needed, ensuring numbers are numbers for the frontend
const processedData = records.map(record => ({
    ...record,
    games_played: parseInt(record.games_played, 10),
    minutes: parseInt(record.minutes, 10),
    goals: parseInt(record.goals, 10),
    assists: parseInt(record.assists, 10),
    shots: parseInt(record.shots, 10),
    shots_on_goal: parseInt(record.shots_on_goal, 10),
    saves: parseInt(record.saves, 10),
}));

const fileContentJs = `window.playerStats = ${JSON.stringify(processedData, null, 2)};`;

fs.writeFileSync(outputPath, fileContentJs);
console.log(`Wrote dashboard data to ${outputPath}`);
