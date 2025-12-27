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
exports.StorageService = void 0;
const sync_1 = require("csv-parse/sync");
const sync_2 = require("csv-stringify/sync");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class StorageService {
    constructor(dataDir) {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        this.gamesPath = path.join(dataDir, 'master_games.csv');
        this.statsPath = path.join(dataDir, 'master_player_stats.csv');
    }
    // --- Games ---
    loadGames() {
        if (!fs.existsSync(this.gamesPath)) {
            return [];
        }
        const fileContent = fs.readFileSync(this.gamesPath, 'utf-8');
        try {
            const records = (0, sync_1.parse)(fileContent, {
                columns: true,
                cast: (value, context) => {
                    if (context.column === 'home_score' || context.column === 'away_score') {
                        return value === '' ? null : Number(value);
                    }
                    if (context.column === 'source_urls') {
                        try {
                            return JSON.parse(value);
                        }
                        catch {
                            return {};
                        }
                    }
                    return value;
                }
            }); // Cast to Game[]
            return records;
        }
        catch (e) {
            console.error('Failed to load games CSV', e);
            return [];
        }
    }
    saveGames(games) {
        const output = (0, sync_2.stringify)(games, {
            header: true,
            columns: [
                'game_id', 'date', 'home_team_name', 'away_team_name',
                'home_score', 'away_score', 'location_type', 'status', 'dedupe_key',
                { key: 'source_urls', header: 'source_urls' }
                // Note: handling object stringification for source_urls might need a custom caster if stringify doesn't do it automatically for objects in cells.
                // csv-stringify usually handles objects if we provide a cast or transform, but default might be [object Object].
                // Let's handle it by mapping before stringify.
            ]
        });
        // Better approach: map games to flat objects for CSV
        const flatGames = games.map(g => ({
            ...g,
            source_urls: JSON.stringify(g.source_urls)
        }));
        const csvContent = (0, sync_2.stringify)(flatGames, { header: true });
        fs.writeFileSync(this.gamesPath, csvContent);
    }
    upsertGames(newGames) {
        const existing = this.loadGames();
        const map = new Map();
        // Load existing into map
        existing.forEach(g => map.set(g.dedupe_key, g));
        let added = 0;
        let updated = 0;
        for (const game of newGames) {
            if (map.has(game.dedupe_key)) {
                // Update logic: merge or overwrite?
                // For now, overwrite is generally safer if we trust the latest scrape
                // But we might want to preserve some fields if needed.
                // Simple overwrite for now.
                map.set(game.dedupe_key, game);
                updated++;
            }
            else {
                map.set(game.dedupe_key, game);
                added++;
            }
        }
        const allGames = Array.from(map.values());
        // valid sort by date?
        allGames.sort((a, b) => a.date.localeCompare(b.date));
        this.saveGames(allGames);
        return { added, updated };
    }
    // --- Player Stats ---
    // (Stubbed for now, implementing similarly later)
    upsertPlayerStats(newStats) {
        // TODO
    }
}
exports.StorageService = StorageService;
//# sourceMappingURL=service.js.map