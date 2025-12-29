"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const parsers_1 = require("@ncaa/parsers");
const fetcher_1 = require("../utils/fetcher");
async function main() {
    const [, , scheduleUrl, teamName = 'Unknown Team', alias = 'schedule_for_boxscores'] = process.argv;
    if (!scheduleUrl) {
        console.error('Usage: ts-node fetch_boxscores.ts <scheduleUrl> <teamName> [alias]');
        process.exit(1);
    }
    const fetcher = new fetcher_1.Fetcher({
        rawDir: path.resolve(__dirname, '../../../../data/raw'),
        delayMs: 0
    });
    console.log(`Fetching schedule ${scheduleUrl}...`);
    const scheduleHtml = await fetcher.get(scheduleUrl, alias);
    const scheduleParser = new parsers_1.SidearmParser();
    const games = await scheduleParser.parseSchedule(scheduleHtml, { teamName, baseUrl: scheduleUrl, debug: true });
    console.log(`Found ${games.length} games. Collecting boxscore URLs...`);
    const targets = games.filter(g => g.source_urls?.boxscore_url).map(g => ({
        game: g,
        boxUrl: g.source_urls.boxscore_url
    }));
    console.log(`Boxscore targets: ${targets.length}`);
    const boxParser = new parsers_1.SidearmBoxScoreParser();
    const rows = [];
    for (const { game, boxUrl } of targets) {
        console.log(`Fetching boxscore ${boxUrl} for ${game.date} ${game.home_team_name} vs ${game.away_team_name}`);
        try {
            const html = await fetcher.get(boxUrl, `boxscore_${game.dedupe_key}`);
            const res = boxParser.parse(html, { sourceUrl: boxUrl });
            res.playerStats.forEach(p => {
                rows.push({
                    game_id: game.game_id,
                    team_id: p.team_id,
                    player_name: p.player_name,
                    player_key: p.player_key,
                    jersey_number: p.jersey_number ?? null,
                    minutes: p.minutes ?? null,
                    goals: p.goals ?? null,
                    assists: p.assists ?? null,
                    shots: p.shots ?? null,
                    shots_on_goal: p.stats?.shots_on_goal ?? null,
                    saves: p.stats?.saves ?? null
                });
            });
            console.log(`Parsed ${res.playerStats.length} player rows`);
        }
        catch (e) {
            console.error(`Failed ${boxUrl}: ${e.message}`);
        }
    }
    const year = games[0]?.date?.split('-')[0] || 'unknown';
    const statsDir = path.resolve(__dirname, '../../../../data/player_stats', year);
    fs.mkdirSync(statsDir, { recursive: true });
    const csvPath = path.join(statsDir, 'player_stats.csv');
    const header = [
        'game_id', 'team_id', 'player_name', 'player_key', 'jersey_number',
        'minutes', 'goals', 'assists', 'shots', 'shots_on_goal', 'saves'
    ];
    const lines = [header.join(',')];
    rows.forEach(r => {
        const vals = [
            r.game_id,
            r.team_id,
            r.player_name,
            r.player_key,
            r.jersey_number ?? '',
            r.minutes ?? '',
            r.goals ?? '',
            r.assists ?? '',
            r.shots ?? '',
            r.shots_on_goal ?? '',
            r.saves ?? ''
        ];
        lines.push(vals.map(v => escapeCsv(String(v))).join(','));
    });
    fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
    console.log(`Wrote ${rows.length} player rows to ${csvPath}`);
}
function escapeCsv(field) {
    if (field === undefined || field === null)
        return '';
    if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        return `"${field.replace(/"/g, '""')}"`;
    }
    return field;
}
main().catch(err => {
    console.error('fetch_boxscores failed:', err);
    process.exit(1);
});
//# sourceMappingURL=fetch_boxscores.js.map