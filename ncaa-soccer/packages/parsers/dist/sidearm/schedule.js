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
        let domain = options?.baseUrl ? this.extractOrigin(options.baseUrl) : '';
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
        if (!domain) {
            domain = this.extractOrigin(this.findCanonical($));
        }
        const gameCards = $('.s-game-card');
        const scoreboardItems = $('.c-scoreboard__item');
        const tableRows = $('.c-schedule__table tbody tr, table tbody tr');
        const gamesByKey = {};
        // If we found any game cards with this selector
        if (gameCards.length > 0) {
            gameCards.each((_, el) => {
                const card = $(el);
                const game = this.parseHtmlGame(card, $, { ...options, baseUrl: domain });
                if (game) {
                    gamesByKey[game.dedupe_key] = game;
                }
            });
        }
        // Parse tabular schedule view if present (often shows full season)
        if (tableRows.length > 0) {
            tableRows.each((_, el) => {
                const row = $(el);
                const game = this.parseTableRow(row, $, { ...options, baseUrl: domain });
                if (game) {
                    gamesByKey[game.dedupe_key] = game;
                }
            });
        }
        // Also try the scoreboard slider, which often has scores even when the game cards do not.
        if (scoreboardItems.length > 0) {
            scoreboardItems.each((_, el) => {
                const item = $(el);
                const game = this.parseScoreboardItem(item, $, { ...options, baseUrl: domain });
                if (game && !gamesByKey[game.dedupe_key]) {
                    gamesByKey[game.dedupe_key] = game;
                }
            });
        }
        if (Object.keys(gamesByKey).length > 0) {
            return Object.values(gamesByKey);
        }
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
            // Date extraction (e.g., "Aug 10")
            const dateText = card.find('[data-test-id="s-game-card-standard__header-game-date-details"] span').first().text().trim();
            const year = new Date().getFullYear().toString(); // Dynamically determine current year
            const dateStr = this.parseDate(dateText, year);
            // Determine location type and whether the context team is home
            const stampText = card.find('.s-stamp__text').text().trim().toLowerCase();
            let location_type = "unknown";
            let isHome = true;
            if (stampText === 'at') {
                location_type = 'away';
                isHome = false;
            }
            else if (stampText === 'vs') {
                location_type = 'home';
                isHome = true;
            }
            const contextTeamName = options?.teamName || 'Unknown Team';
            const home_team_name = isHome ? contextTeamName : opponentName;
            const away_team_name = isHome ? opponentName : contextTeamName;
            // Score extraction (e.g., "W 2-1" or "L 0-3")
            const scoreText = card.find('.c-scoreboard__scores').text().trim().replace(/\s+/g, '');
            let home_score = null;
            let away_score = null;
            let status = 'scheduled';
            const scoreMatch = scoreText.match(/(?:([WL])\s*)?(\d+)-(\d+)/i);
            if (scoreMatch) {
                status = 'final';
                const first = parseInt(scoreMatch[2], 10);
                const second = parseInt(scoreMatch[3], 10);
                if (isHome) {
                    home_score = first;
                    away_score = second;
                }
                else {
                    home_score = second;
                    away_score = first;
                }
            }
            const safeHome = home_team_name.replace(/\s+/g, '-');
            const safeAway = away_team_name.replace(/\s+/g, '-');
            const derivedId = `sidearm-${dateStr}-${safeHome}-${safeAway}`;
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
    parseTableRow(row, $, options) {
        try {
            const cells = row.find('td');
            if (cells.length === 0)
                return null;
            const headerCells = row.closest('table').find('thead th');
            const headers = [];
            headerCells.each((_, h) => headers.push($(h).text().trim().toLowerCase()));
            const getCellByHeader = (label) => {
                const idx = headers.findIndex(h => h.includes(label));
                if (idx === -1)
                    return null;
                return $(cells.get(idx));
            };
            const dateCell = getCellByHeader('date') || $(cells.get(0));
            const opponentCell = getCellByHeader('opponent') || $(cells.get(1));
            const resultCell = getCellByHeader('result') || $(cells.get(cells.length - 1));
            const dateTextRaw = dateCell.text().trim();
            const dateTextMatch = dateTextRaw.match(/([A-Za-z]{3,})\s+(\d{1,2})/);
            const monthDay = dateTextMatch ? `${dateTextMatch[1]} ${dateTextMatch[2]}` : dateTextRaw.split(/\s+/).slice(0, 2).join(' ');
            const year = new Date().getFullYear().toString();
            const dateStr = this.parseDate(monthDay, year);
            const opponentText = opponentCell.text().replace(/\s+/g, ' ').trim();
            const stampMatch = opponentText.match(/^(vs|at)\s+/i);
            const stamp = stampMatch ? stampMatch[1].toLowerCase() : '';
            let opponentName = opponentText.replace(/^(vs|at)\s+/i, '').trim();
            if (!opponentName)
                opponentName = 'Unknown Opponent';
            let location_type = 'unknown';
            let isHome = true;
            if (stamp === 'at') {
                location_type = 'away';
                isHome = false;
            }
            else if (stamp === 'vs') {
                location_type = 'home';
                isHome = true;
            }
            const contextTeamName = options?.teamName || 'Unknown Team';
            const home_team_name = isHome ? contextTeamName : opponentName;
            const away_team_name = isHome ? opponentName : contextTeamName;
            const resultText = resultCell.text().replace(/\s+/g, ' ').trim();
            let home_score = null;
            let away_score = null;
            let status = 'scheduled';
            const scoreMatch = resultText.match(/(\d+)\s*-\s*(\d+)/);
            if (scoreMatch) {
                status = 'final';
                const first = parseInt(scoreMatch[1], 10);
                const second = parseInt(scoreMatch[2], 10);
                if (isHome) {
                    home_score = first;
                    away_score = second;
                }
                else {
                    home_score = second;
                    away_score = first;
                }
            }
            else if (/final/i.test(resultText)) {
                status = 'final';
            }
            else if (/post/i.test(resultText)) {
                status = 'postponed';
            }
            else if (/cancel/i.test(resultText)) {
                status = 'canceled';
            }
            // Attempt to capture boxscore / stats link from the links cell
            let boxscore_url;
            const linkCell = getCellByHeader('links') || getCellByHeader('media') || (row.find('a').length ? row : null);
            if (linkCell) {
                const firstHref = linkCell.find('a').first().attr('href');
                if (firstHref)
                    boxscore_url = this.resolveUrl(firstHref, options?.baseUrl);
            }
            const safeHome = home_team_name.replace(/\s+/g, '-');
            const safeAway = away_team_name.replace(/\s+/g, '-');
            const derivedId = `sidearm-${dateStr}-${safeHome}-${safeAway}`;
            return {
                game_id: derivedId,
                date: dateStr,
                home_team_name,
                away_team_name,
                home_score,
                away_score,
                location_type,
                status,
                source_urls: {
                    boxscore_url
                },
                dedupe_key: `${dateStr}-${home_team_name}-${away_team_name}`
            };
        }
        catch (e) {
            console.error('Error parsing table row', e);
            return null;
        }
    }
    parseScoreboardItem(item, $, options) {
        try {
            const opponentName = item.find('.c-scoreboard__logo img').attr('alt')?.trim() || 'Unknown Opponent';
            const dateText = item.find('.c-scoreboard__date span').first().text().trim();
            const year = new Date().getFullYear().toString();
            const dateStr = this.parseDate(dateText, year);
            const atVsText = item.find('.c-scoreboard__atvs').text().trim().toLowerCase();
            let location_type = 'unknown';
            let isHome = true;
            if (item.hasClass('c-scoreboard__item--home') || atVsText === 'vs') {
                location_type = 'home';
                isHome = true;
            }
            else if (item.hasClass('c-scoreboard__item--away') || atVsText === 'at') {
                location_type = 'away';
                isHome = false;
            }
            const contextTeamName = options?.teamName || 'Unknown Team';
            const home_team_name = isHome ? contextTeamName : opponentName;
            const away_team_name = isHome ? opponentName : contextTeamName;
            const scoreText = item.find('.c-scoreboard__scores').text().trim().replace(/\s+/g, '');
            let home_score = null;
            let away_score = null;
            let status = 'scheduled';
            const scoreMatch = scoreText.match(/(?:([WL])\s*)?(\d+)-(\d+)/i);
            if (scoreMatch) {
                status = 'final';
                const first = parseInt(scoreMatch[2], 10);
                const second = parseInt(scoreMatch[3], 10);
                if (isHome) {
                    home_score = first;
                    away_score = second;
                }
                else {
                    home_score = second;
                    away_score = first;
                }
            }
            else {
                const statusText = item.find('.c-scoreboard__status').text().toLowerCase();
                if (statusText.includes('final'))
                    status = 'final';
                else if (statusText.includes('post'))
                    status = 'postponed';
                else if (statusText.includes('cancel'))
                    status = 'canceled';
            }
            const boxscore_url = item.find('.s-icon-boxscore').closest('a').attr('href') || undefined;
            const safeHome = home_team_name.replace(/\s+/g, '-');
            const safeAway = away_team_name.replace(/\s+/g, '-');
            const derivedId = `sidearm-${dateStr}-${safeHome}-${safeAway}`;
            return {
                game_id: derivedId,
                date: dateStr,
                home_team_name,
                away_team_name,
                home_score,
                away_score,
                location_type,
                status,
                source_urls: {
                    boxscore_url: boxscore_url ? this.resolveUrl(boxscore_url, options?.baseUrl) : undefined
                },
                dedupe_key: `${dateStr}-${home_team_name}-${away_team_name}`
            };
        }
        catch (e) {
            console.error('Error parsing scoreboard item', e);
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
    resolveUrl(href, baseUrl) {
        if (!href)
            return href;
        if (href.startsWith('http'))
            return href;
        if (!baseUrl)
            return href;
        const origin = this.extractOrigin(baseUrl);
        if (!origin)
            return href;
        if (href.startsWith('/'))
            return `${origin}${href}`;
        return `${origin}/${href}`;
    }
    extractOrigin(url) {
        if (!url)
            return '';
        try {
            const u = new URL(url);
            return u.origin;
        }
        catch (_a) {
            return '';
        }
    }
    findCanonical($) {
        const link = $('link[rel="canonical"]').attr('href');
        return link || undefined;
    }
    async parseBoxScore(html, options) {
        const boxScoreParser = new boxscore_1.SidearmBoxScoreParser();
        return boxScoreParser.parse(html, options);
    }
}
exports.SidearmParser = SidearmParser;
//# sourceMappingURL=schedule.js.map
