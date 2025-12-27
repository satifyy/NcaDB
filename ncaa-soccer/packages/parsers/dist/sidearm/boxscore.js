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
exports.SidearmBoxScoreParser = void 0;
const cheerio = __importStar(require("cheerio"));
// import { z } from 'zod'; // Not needed for HTML parsing unless we validate the final object
class SidearmBoxScoreParser {
    parse(html, options) {
        const $ = cheerio.load(html);
        const playerStats = [];
        const gameId = options?.sourceUrl ? this.extractGameId(options.sourceUrl) : 'unknown-game';
        // Find tables with class 'sidearm-table overall-stats'
        // There are usually two: one for visitor, one for home. 
        // We need to identify which is which. 
        // The captions usually say "Home Team - Player Stats" or similar.
        const tables = $('table.sidearm-table.overall-stats');
        tables.each((i, table) => {
            const caption = $(table).find('caption').text().trim();
            // Heuristic to detect team from caption (e.g. "SMU - Player Stats")
            // We need to associate this with options.teamName or similar?
            // Actually, we should probably return stats with "team_name" field populated from the caption or context.
            // For now, let's assume we can pass the team names in options or infer them.
            // But wait, the shared PlayerStat schema needs `team_id` or `team_name`.
            let teamName = 'Unknown';
            if (caption) {
                teamName = caption.split('-')[0].trim();
            }
            const rows = $(table).find('tbody tr');
            rows.each((j, row) => {
                const cols = $(row).find('td');
                if (cols.length < 8)
                    return; // Skip invalid rows
                // Column Mapping (based on inspection):
                // 0: Pos (fw, df, etc)
                // 1: # (Jersey)
                // 2: Player (Name, Link)
                // 3: SH
                // 4: SOG
                // 5: G
                // 6: A
                // 7: MIN
                const playerCell = $(cols[2]);
                const playerName = playerCell.text().trim();
                // Extract Player ID from link? e.g. /sports/mens-soccer/roster/bailey-sparks/1234
                const playerLink = playerCell.find('a').attr('href');
                let playerId = playerName.replace(/\s+/g, '-').toLowerCase(); // fallback
                if (playerLink) {
                    const parts = playerLink.split('/');
                    const potentialId = parts[parts.length - 1];
                    if (potentialId && !isNaN(Number(potentialId))) {
                        playerId = `sidearm-${potentialId}`;
                    }
                }
                const jerseyNumber = $(cols[1]).text().trim();
                // Construct normalized key
                // For now, use teamId (if derived from header, e.g. "SMU") + player name
                const normalizedName = playerName.toLowerCase().replace(/[^a-z0-9]/g, '');
                const playerKey = `${teamName.toLowerCase().replace(/[^a-z0-9]/g, '')}:${normalizedName}`;
                // Stats
                const shots = parseInt($(cols[3]).text().trim(), 10) || 0;
                const sog = parseInt($(cols[4]).text().trim(), 10) || 0;
                const goals = parseInt($(cols[5]).text().trim(), 10) || 0;
                const assists = parseInt($(cols[6]).text().trim(), 10) || 0;
                const minutes = parseInt($(cols[7]).text().trim(), 10) || 0;
                const stat = {
                    game_id: gameId,
                    team_id: teamName, // Use inferred team name
                    player_name: playerName,
                    player_key: playerKey,
                    jersey_number: jerseyNumber || null,
                    // Populate convenience fields
                    minutes,
                    goals,
                    assists,
                    shots,
                    // Dynamic stats map
                    stats: {
                        shots_on_goal: sog,
                        saves: 0
                    }
                };
                // Validate against schema?
                // const valid = PlayerStatSchema.safeParse(stat);
                // if (valid.success) playerStats.push(valid.data);
                playerStats.push(stat);
            });
        });
        return {
            game: {}, // We generally don't re-parse game info from boxscore unless needed
            playerStats
        };
    }
    extractGameId(url) {
        const match = url.match(/\/(\d+)(?:$|\?)/);
        return match ? `sidearm-${match[1]}` : 'unknown'; // Align with schedule ID format
    }
}
exports.SidearmBoxScoreParser = SidearmBoxScoreParser;
//# sourceMappingURL=boxscore.js.map