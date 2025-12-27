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
// import { writeCsv } from './csv/writers'; // If available
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
        // Headers based on Game schema
        const headers = [
            'game_id', 'date', 'home_team_name', 'away_team_name',
            'home_score', 'away_score', 'location_type', 'status',
            'schedule_url', 'boxscore_url', 'dedupe_key'
        ];
        let content = '';
        if (!fs.existsSync(filePath)) {
            content += headers.join(',') + '\n';
        }
        // Read existing keys to dedupe if appending? 
        // For now, simple append or overwrite?
        // Implementation plan said "saveGames". Usually we want to merge or overwrite.
        // Let's assume overwrite for the session or append new ones. 
        // For simplicity and to avoid duplicates in file, we might want to read all, merge, write all.
        // But for this phase, simple write is fine.
        for (const game of games) {
            const row = [
                this.escapeCsv(game.game_id),
                this.escapeCsv(game.date),
                this.escapeCsv(game.home_team_name),
                this.escapeCsv(game.away_team_name),
                game.home_score !== null ? game.home_score : '',
                game.away_score !== null ? game.away_score : '',
                this.escapeCsv(game.location_type),
                this.escapeCsv(game.status),
                this.escapeCsv(game.source_urls?.schedule_url || ''),
                this.escapeCsv(game.source_urls?.boxscore_url || ''),
                this.escapeCsv(game.dedupe_key)
            ];
            content += row.join(',') + '\n';
        }
        // naive append for now.
        fs.appendFileSync(filePath, content);
        console.log(`Saved ${games.length} games to ${filePath}`);
    }
    escapeCsv(field) {
        if (!field)
            return '';
        if (field.includes(',') || field.includes('"') || field.includes('\n')) {
            return `"${field.replace(/"/g, '""')}"`;
        }
        return field;
    }
}
exports.GameStorageAdapter = GameStorageAdapter;
//# sourceMappingURL=game_adapter.js.map