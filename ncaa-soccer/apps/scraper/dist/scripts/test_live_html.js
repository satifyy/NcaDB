"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const src_1 = require("../../../../packages/parsers/src");
const rawFilename = '2025-12-28T20-39-02-665Z_boxscore_2025-08-24-UNC-Seattle.html';
const htmlPath = path_1.default.join(process.cwd(), 'data/raw', rawFilename);
if (!fs_1.default.existsSync(htmlPath)) {
    console.error(`File not found: ${htmlPath}`);
    process.exit(1);
}
const html = fs_1.default.readFileSync(htmlPath, 'utf8');
const parser = new src_1.SidearmBoxScoreParser();
const result = parser.parse(html, { sourceUrl: 'https://test.com' });
console.log(`Parsed ${result.playerStats.length} stats.`);
if (result.playerStats.length > 0) {
    console.log('Sample Stats:');
    result.playerStats.slice(0, 5).forEach(stat => {
        console.log(`${stat.team_id} - ${stat.jersey_number} ${stat.player_name}: ${stat.minutes} min`);
    });
}
//# sourceMappingURL=test_live_html.js.map