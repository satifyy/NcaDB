"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sync_1 = require("csv-parse/sync");
const inputPath = path_1.default.join(process.cwd(), 'data/player_stats/2025/aggregated_player_stats.csv');
const outputPath = path_1.default.join(process.cwd(), 'apps/dashboard/data.js');
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
fs_1.default.writeFileSync(outputPath, fileContentJs);
console.log(`Wrote dashboard data to ${outputPath}`);
//# sourceMappingURL=generate_dashboard_data.js.map