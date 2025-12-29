"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sync_1 = require("csv-parse/sync");
const sync_2 = require("csv-stringify/sync");
const inputPath = path_1.default.join(process.cwd(), 'data/player_stats/2025/player_stats.csv');
const outputPath = path_1.default.join(process.cwd(), 'data/player_stats/2025/aggregated_player_stats.csv');
if (!fs_1.default.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
}
console.log(`Reading stats from ${inputPath}...`);
const fileContent = fs_1.default.readFileSync(inputPath, 'utf-8');
const records = (0, sync_1.parse)(fileContent, {
    columns: true,
    skip_empty_lines: true
});
console.log(`Parsed ${records.length} rows.`);
const aggregated = {};
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
    if (pointsB !== pointsA)
        return pointsB - pointsA;
    return b.minutes - a.minutes;
});
const csvOutput = (0, sync_2.stringify)(outputRecords, {
    header: true
});
fs_1.default.writeFileSync(outputPath, csvOutput);
console.log(`Wrote ${outputRecords.length} aggregated rows to ${outputPath}`);
//# sourceMappingURL=aggregate_player_stats.js.map