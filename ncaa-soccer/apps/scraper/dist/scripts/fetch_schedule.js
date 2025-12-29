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
const path = __importStar(require("path"));
const fetcher_1 = require("../utils/fetcher");
const parsers_1 = require("@ncaa/parsers");
const storage_1 = require("@ncaa/storage");
async function main() {
    const [, , url, teamName = 'Unknown Team', alias = 'schedule'] = process.argv;
    if (!url) {
        console.error('Usage: ts-node fetch_schedule.ts <url> <teamName> [alias]');
        process.exit(1);
    }
    const fetcher = new fetcher_1.Fetcher({
        rawDir: path.resolve(__dirname, '../../../../data/raw'),
        delayMs: 0
    });
    console.log(`Fetching schedule from ${url}...`);
    const html = await fetcher.get(url, alias);
    const parser = new parsers_1.SidearmParser();
    const games = await parser.parseSchedule(html, { teamName });
    console.log(`Parsed ${games.length} games for ${teamName}.`);
    games.forEach(g => {
        const score = (g.home_score ?? '-') + '-' + (g.away_score ?? '-');
        console.log(`${g.date}: ${g.home_team_name} vs ${g.away_team_name} ${score} status=${g.status}`);
    });
    if (games.length > 0) {
        const year = games[0].date.split('-')[0];
        const storageDir = path.resolve(__dirname, '../../../../data');
        const storage = new storage_1.GameStorageAdapter(storageDir);
        await storage.saveGames(games, year);
        console.log(`Saved games to ${path.join(storageDir, 'games', year, 'games.csv')}`);
    }
}
main().catch(err => {
    console.error('fetch_schedule failed:', err);
    process.exit(1);
});
//# sourceMappingURL=fetch_schedule.js.map