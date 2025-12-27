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
exports.SidearmParser = void 0;
const zod_1 = require("zod");
const boxscore_1 = require("./boxscore");
const cheerio = __importStar(require("cheerio"));
const SidearmGameSchema = zod_1.z.object({
    id: zod_1.z.number(),
    date: zod_1.z.string(),
    type: zod_1.z.string(),
    status: zod_1.z.string().optional().nullable(),
    location: zod_1.z.string().optional().nullable(),
    location_indicator: zod_1.z.string().optional().nullable(), // H, A, N
    neutral_hometeam: zod_1.z.boolean().optional().nullable(),
    opponent: zod_1.z.object({
        name: zod_1.z.string(),
        image: zod_1.z.string().optional().nullable()
    }),
    result: zod_1.z.object({
        status: zod_1.z.string().optional().nullable(), // W, L, T
        team_score: zod_1.z.string().optional().nullable(),
        opponent_score: zod_1.z.string().optional().nullable(),
        boxscore: zod_1.z.string().optional().nullable()
    }).optional().nullable(),
    schedule: zod_1.z.object({
        url: zod_1.z.string().optional().nullable()
    }).optional().nullable()
});
const SidearmResponseSchema = zod_1.z.array(SidearmGameSchema);
class SidearmParser {
    constructor() {
        this.name = 'sidearm';
    }
    async parseSchedule(input, options) {
        const games = [];
        let domain = '';
        // Try to parse as JSON first
        try {
            const data = JSON.parse(input);
            const parsed = SidearmResponseSchema.safeParse(data);
            if (parsed.success) {
                return this.parseJsonSchedule(parsed.data, options);
            }
        }
        catch (e) {
            // Not JSON, continue to HTML parsing
        }
        // HTML Parsing
        const $ = cheerio.load(input);
        const gameCards = $('.s-game-card');
        // If we found any game cards with this selector
        if (gameCards.length > 0) {
            gameCards.each((_, el) => {
                const card = $(el);
                const game = this.parseHtmlGame(card, $, options);
                if (game)
                    games.push(game);
            });
            return games;
        }
        // Fallback for older Sidearm layouts (if any, e.g. .sidearm-schedule-game as backup)
        // ...
        return games;
    }
    parseJsonSchedule(data, options) {
        const games = [];
        let domain = '';
        for (const item of data) {
            // Try to infer domain from schedule URL if available and not yet set
            if (!domain && item.schedule?.url) {
                try {
                    const url = new URL(item.schedule.url);
                    domain = url.origin;
                }
                catch (e) { }
            }
            const dateObj = new Date(item.date);
            const dateStr = dateObj.toISOString().split('T')[0];
            // Determine Home/Away
            const loc = item.location_indicator || 'H';
            let isHome = false;
            if (loc === 'H') {
                isHome = true;
            }
            else if (loc === 'A') {
                isHome = false;
            }
            else if (loc === 'N') {
                if (item.neutral_hometeam) {
                    isHome = true;
                }
                else {
                    isHome = false;
                }
            }
            let home_team_name = '';
            let away_team_name = '';
            let home_score = null;
            let away_score = null;
            let location_type = "unknown";
            if (loc === 'H')
                location_type = 'home';
            else if (loc === 'A')
                location_type = 'away';
            else if (loc === 'N')
                location_type = 'neutral';
            const contextTeamName = options?.teamName || 'Unknown Team';
            if (isHome) {
                home_team_name = contextTeamName;
                away_team_name = item.opponent.name;
                if (item.result) {
                    home_score = item.result.team_score ? parseInt(item.result.team_score, 10) : null;
                    away_score = item.result.opponent_score ? parseInt(item.result.opponent_score, 10) : null;
                }
            }
            else {
                home_team_name = item.opponent.name;
                away_team_name = contextTeamName;
                if (item.result) {
                    home_score = item.result.opponent_score ? parseInt(item.result.opponent_score, 10) : null;
                    away_score = item.result.team_score ? parseInt(item.result.team_score, 10) : null;
                }
            }
            let boxscore_url = item.result?.boxscore;
            if (boxscore_url && !boxscore_url.startsWith('http') && domain) {
                boxscore_url = `${domain}${boxscore_url.startsWith('/') ? '' : '/'}${boxscore_url}`;
            }
            // Map status
            let gameStatus = "scheduled";
            if (item.status === 'O' || item.result?.status) {
                gameStatus = 'final';
            }
            else if (item.status === 'P') {
                gameStatus = 'postponed';
            }
            else if (item.status === 'C') {
                gameStatus = 'canceled';
            }
            const game = {
                game_id: `sidearm-${item.id}`,
                date: dateStr,
                home_team_name,
                away_team_name,
                home_score,
                away_score,
                location_type,
                status: gameStatus,
                source_urls: {
                    schedule_url: item.schedule?.url || undefined,
                    boxscore_url: boxscore_url || undefined
                },
                dedupe_key: `${dateStr}-${home_team_name}-${away_team_name}`
            };
            games.push(game);
        }
        return games;
    }
    parseHtmlGame(card, $, options) {
        try {
            const opponentName = card.find('.s-game-card__header__team .s-text-paragraph-bold').text().trim() || 'Unknown Opponent';
            // Date extraction: "Aug 10"
            const dateText = card.find('[data-test-id="s-game-card-standard__header-game-date-details"] span').first().text().trim();
            // TODO: Handle year properly. For now assume current/next based on month? 
            // Or pass year in options.
            const year = "2025"; // Hardcoded for this phase based on file name context, needs improvement
            const dateStr = this.parseDate(dateText, year);
            const locationText = card.find('[data-test-id="s-game-card-utility-bar__location-details"]').text().trim();
            // Note: The debug output showed specific location classes but data-test-id is more reliable if present.
            // Using text found in debug: "Dorrance Field Chapel Hill, N.C." 
            // Score / Status
            // Look for result in .s-game-card__header__game-score-time
            const scoreText = card.find('.s-game-card__header__game-score-time .s-text-paragraph-bold').text().trim();
            let home_score = null;
            let away_score = null;
            let status = 'scheduled';
            // Detect W/L/T or scores
            if (scoreText.includes('-')) {
                status = 'final';
                // Parse score.. tricky without knowing who is home/away strictly from text 'W, 2-1'
                // Usually Sidearm puts "W, 3-0" or "L, 0-1" relative to the primary team
            }
            // Determine Home/Away/Neutral
            // Logic: "at" vs "vs" usually in a stamp or text
            const stampText = card.find('.s-stamp__text').text().trim().toLowerCase();
            let location_type = "unknown";
            let isHome = true;
            if (stampText === 'at') {
                location_type = 'away';
                isHome = false;
            }
            else if (stampText === 'vs') {
                location_type = 'home';
            }
            const contextTeamName = options?.teamName || 'Unknown Team';
            let home_team_name = isHome ? contextTeamName : opponentName;
            let away_team_name = isHome ? opponentName : contextTeamName;
            // Generate ID
            const derivedId = `sidearm-html-${dateStr}-${opponentName.replace(/\s+/g, '-')}`;
            return {
                game_id: derivedId,
                date: dateStr,
                home_team_name,
                away_team_name,
                home_score,
                away_score,
                location_type,
                status,
                source_urls: {},
                dedupe_key: `${dateStr}-${home_team_name}-${away_team_name}`
            };
        }
        catch (e) {
            console.error('Error parsing HTML game card', e);
            return null;
        }
    }
    parseDate(dateText, year) {
        // Simple parser for "Aug 10" -> "2025-08-10"
        try {
            const date = new Date(`${dateText} ${year}`);
            if (isNaN(date.getTime()))
                return `${year}-01-01`; // Fallback
            return date.toISOString().split('T')[0];
        }
        catch (e) {
            return `${year}-01-01`;
        }
    }
    async parseBoxScore(html, options) {
        const boxScoreParser = new boxscore_1.SidearmBoxScoreParser();
        return boxScoreParser.parse(html, options);
    }
}
exports.SidearmParser = SidearmParser;
//# sourceMappingURL=schedule.js.map