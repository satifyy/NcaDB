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
const isPdf = (url) => /\.pdf(\?|#|$)/i.test(url || '');
/**
 * Both schools in a fixture publish their own box score, and one of them is sometimes
 * empty — a school's stats feed can carry no players at all, or offer only a PDF.
 * Keeping the second URL as `boxscore_url_alt` gives the box-score stage somewhere to
 * fall back to instead of losing the game. A parseable HTML page always takes the
 * primary slot over a PDF.
 */
function mergeBoxscoreUrls(merged, from) {
    const candidates = [merged.boxscore_url, merged.boxscore_url_alt, from.boxscore_url, from.boxscore_url_alt]
        .map(url => (url || '').trim())
        .filter(Boolean);
    const unique = [];
    for (const url of candidates) {
        if (!unique.includes(url))
            unique.push(url);
    }
    // Stable sort that lifts HTML box scores above PDFs without reordering equals.
    const ranked = unique
        .map((url, index) => ({ url, index }))
        .sort((a, b) => Number(isPdf(a.url)) - Number(isPdf(b.url)) || a.index - b.index)
        .map(entry => entry.url);
    merged.boxscore_url = ranked[0] || '';
    merged.boxscore_url_alt = ranked[1] || '';
}
/**
 * Keeps whichever side of a duplicate pair actually has the field filled in.
 *
 * The two rows describe one fixture from two schools' points of view, so they often
 * disagree on which team is listed first. Per-team fields are read through that
 * orientation rather than by column name — otherwise a 4-0 would be copied in as 0-4.
 */
function mergeRows(into, from) {
    const merged = { ...into };
    const aligned = merged.home_team_name === from.home_team_name && merged.away_team_name === from.away_team_name;
    const inverted = merged.home_team_name === from.away_team_name && merged.away_team_name === from.home_team_name;
    if (merged.location_type === 'unknown' && from.location_type && from.location_type !== 'unknown') {
        merged.location_type = from.location_type;
    }
    if (merged.status === 'scheduled' && from.status && from.status !== 'scheduled') {
        merged.status = from.status;
    }
    for (const field of ['schedule_url', 'game_id']) {
        if (!merged[field] && from[field])
            merged[field] = from[field];
    }
    mergeBoxscoreUrls(merged, from);
    if (aligned || inverted) {
        // When inverted, the other row's "home" value describes our away team.
        for (const side of ['home', 'away']) {
            const other = inverted ? (side === 'home' ? 'away' : 'home') : side;
            if (!merged[`${side}_score`] && from[`${other}_score`]) {
                merged[`${side}_score`] = from[`${other}_score`];
            }
            if (from[`${other}_team_ranked`] === 'true') {
                merged[`${side}_team_ranked`] = 'true';
            }
        }
    }
    return merged;
}
class GameStorageAdapter {
    constructor(baseDir, options) {
        this.baseDir = baseDir;
        this.verbose = options?.verbose || false;
        this.normalizeRow = options?.normalizeRow || (row => row);
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
            'home_team_ranked', 'away_team_ranked',
            'home_score', 'away_score', 'location_type', 'status',
            'schedule_url', 'boxscore_url', 'boxscore_url_alt', 'dedupe_key'
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
                for (const raw of records) {
                    const record = this.normalizeRow(raw);
                    if (!record.dedupe_key)
                        continue;
                    const existing = gamesMap.get(record.dedupe_key);
                    if (existing) {
                        // Two stored rows normalised onto the same fixture; keep the
                        // richer of the pair rather than whichever was read last.
                        gamesMap.set(record.dedupe_key, mergeRows(existing, record));
                    }
                    else {
                        gamesMap.set(record.dedupe_key, record);
                    }
                }
            }
            catch (e) {
                console.warn(`Error reading existing CSV at ${filePath}:`, e);
            }
        }
        // 2. Upsert new games with smart merging
        for (const game of games) {
            // Flatten game object to match CSV structure
            const row = this.normalizeRow({
                game_id: game.game_id,
                date: game.date,
                home_team_name: game.home_team_name,
                away_team_name: game.away_team_name,
                home_team_ranked: game.home_team_ranked ? 'true' : 'false',
                away_team_ranked: game.away_team_ranked ? 'true' : 'false',
                home_score: game.home_score !== null ? String(game.home_score) : '',
                away_score: game.away_score !== null ? String(game.away_score) : '',
                location_type: game.location_type,
                status: game.status,
                schedule_url: game.source_urls?.schedule_url || '',
                boxscore_url: game.source_urls?.boxscore_url || '',
                boxscore_url_alt: '',
                dedupe_key: game.dedupe_key
            });
            // Smart merge: if game already exists, update with better data
            const existing = gamesMap.get(row.dedupe_key);
            if (existing) {
                if (this.verbose) {
                    console.log(`🔄 Duplicate detected: ${row.dedupe_key}`);
                }
                gamesMap.set(row.dedupe_key, mergeRows(existing, row));
            }
            else {
                gamesMap.set(row.dedupe_key, row);
            }
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