"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const boxscore_1 = require("../../../../packages/parsers/src/sidearm/boxscore");
const htmlPath = path_1.default.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs_1.default.readFileSync(htmlPath, 'utf8');
const parser = new boxscore_1.SidearmBoxScoreParser();
const result = parser.parse(html, { sourceUrl: 'https://goheels.com/sports/mens-soccer/stats/2025/ucf/boxscore/26235' });
console.log(`Parsed ${result.playerStats.length} stats.`);
if (result.playerStats.length > 0) {
    console.log('Sample Stats:');
    result.playerStats.slice(0, 5).forEach(stat => {
        console.log(`${stat.team_id} - ${stat.jersey_number} ${stat.player_name}: ${stat.minutes} min, ${stat.goals} G, ${stat.assists} A, ${stat.shots} SH`);
    });
    // Check for Cordes
    const cordes = result.playerStats.find(s => s.player_name.includes('Cordes'));
    if (cordes) {
        console.log('\nFound Cordes:', JSON.stringify(cordes, null, 2));
    }
    else {
        console.log('\nCordes NOT found');
    }
}
else {
    console.log('No stats found. Nuxt parsing failed?');
}
//# sourceMappingURL=test_boxscore_parser.js.map