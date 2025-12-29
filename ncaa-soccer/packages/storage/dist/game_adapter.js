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
exports.GameStorageAdapter = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const sync_1 = require("csv-parse/sync");
const sync_2 = require("csv-stringify/sync");
class GameStorageAdapter {
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    async saveGames(games, season) {
        if (games.length === 0)
            return;
        const dir = path.join(this.baseDir, 'games', season);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, 'games.csv');
        const headers = [
            'game_id', 'date', 'home_team_name', 'away_team_name',
            'home_score', 'away_score', 'location_type', 'status',
            'schedule_url', 'boxscore_url', 'dedupe_key'
        ];
        const gamesMap = new Map();
        // 1. Read existing
        if (fs.existsSync(filePath)) {
            try {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const records = (0, sync_1.parse)(fileContent, {
                    columns: true,
                    skip_empty_lines: true
                });
                for (const record of records) {
                    // Normalize dedupe_key just in case
                    if (record.dedupe_key) {
                        gamesMap.set(record.dedupe_key, record);
                    }
                }
            }
            catch (e) {
                console.warn(`Error reading existing CSV at ${filePath}:`, e);
            }
        }
        // 2. Upsert new games
        for (const game of games) {
            // Flatten game object to match CSV structure
            const row = {
                game_id: game.game_id,
                date: game.date,
                home_team_name: game.home_team_name,
                away_team_name: game.away_team_name,
                home_score: game.home_score !== null ? String(game.home_score) : '',
                away_score: game.away_score !== null ? String(game.away_score) : '',
                location_type: game.location_type,
                status: game.status,
                schedule_url: game.source_urls?.schedule_url || '',
                boxscore_url: game.source_urls?.boxscore_url || '',
                dedupe_key: game.dedupe_key
            };
            gamesMap.set(game.dedupe_key, row);
        }
        // 3. Write back
        const allGames = Array.from(gamesMap.values());
        // ensure sorting by date
        allGames.sort((a, b) => a.date.localeCompare(b.date));
        const output = (0, sync_2.stringify)(allGames, {
            header: true,
            columns: headers
        });
        fs.writeFileSync(filePath, output);
        console.log(`Saved ${games.length} games (merged with existing) to ${filePath}`);
    }
}
exports.GameStorageAdapter = GameStorageAdapter;
//# sourceMappingURL=game_adapter.js.map