"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const parsers_1 = require("@ncaa/parsers");
const url = 'https://smumustangs.com/sports/mens-soccer/stats/2025/umkc/boxscore/14065';
async function main() {
    console.log(`Fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    const parser = new parsers_1.SidearmBoxScoreParser();
    const result = parser.parse(html, { sourceUrl: url });
    console.log(`Parsed ${result.playerStats.length} player rows`);
    result.playerStats.slice(0, 15).forEach((p) => {
        console.log(`[${p.team_id}] #${p.jersey_number} ${p.player_name} G:${p.goals} A:${p.assists} S:${p.shots} SOG:${p.stats?.shots_on_goal} Min:${p.minutes}`);
    });
    if (result.playerStats.length > 15)
        console.log('...');
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=verify_boxscore_live.js.map