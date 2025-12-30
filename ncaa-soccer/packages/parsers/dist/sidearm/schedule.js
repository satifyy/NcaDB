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
    // Helper to create normalized dedupe key (alphabetically sorted teams to avoid duplicates)
    makeDedupeKey(date, homeTeam, awayTeam) {
        const teams = [homeTeam, awayTeam].sort();
        // Normalize by replacing spaces with hyphens
        const team1 = teams[0].replace(/\s+/g, '-');
        const team2 = teams[1].replace(/\s+/g, '-');
        return `${date}-${team1}-${team2}`;
    }
    // Helper to clean team names and detect rankings
    cleanTeamName(name) {
        let cleanName = name;
        let isRanked = false;
        // Normalize whitespace early to avoid embedded newlines/indentation from scraped HTML
        cleanName = cleanName.replace(/\s+/g, ' ').trim();
        // Collapse exact double repeats like "UC Davis UC Davis"
        const repeatMatch = cleanName.match(/^(.+?)\s+\1$/i);
        if (repeatMatch) {
            cleanName = repeatMatch[1].trim();
        }
        // Check for rankings: "No. 7 Stanford", "#5 Duke", etc.
        if (/^(No\.?|#)\s*\d+\s+/i.test(cleanName)) {
            isRanked = true;
            cleanName = cleanName.replace(/^(No\.?|#)\s*\d+\s+/i, '').trim();
        }
        // Remove stars and asterisks: "Clemson * *" -> "Clemson"
        cleanName = cleanName.replace(/\s*\*+\s*/g, ' ').trim();
        return { cleanName, isRanked };
    }
    async parseSchedule(input, options) {
        if (options?.debug)
            console.log('[sidearm] parseSchedule called with debug=true (v5 - stdout)');
        // Enable parseDate debug logging when requested
        if (options?.debug)
            globalThis.__sidearmDebugDates = true;
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
        // Try to parse NextGen embedded JSON (Nuxt hydration data)
        const nextGenGames = this.parseNextGenJson(input, options);
        if (nextGenGames.length > 0) {
            if (options?.debug)
                console.log(`[sidearm] Found ${nextGenGames.length} games via NextGen JSON`);
            return nextGenGames;
        }
        // HTML Parsing
        const $ = cheerio.load(input);
        if (!domain) {
            domain = this.extractOrigin(this.findCanonical($));
        }
        const debug = options?.debug;
        const gameCards = $('.s-game-card');
        const scoreboardItems = $('.c-scoreboard__item');
        const gamesByKey = {};
        // Include both table rows and list items (some sites use ul.sidearm-schedule-games-container)
        const tableRows = $('.c-schedule__table tbody tr, table tbody tr, .s-table-body__row, .sidearm-schedule-game');
        if (debug) {
            console.log(`[sidearm] domain=${domain || 'n/a'} cards=${gameCards.length} tables=${tableRows.length} scoreboardItems=${scoreboardItems.length}`);
        }
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
                else if (debug) {
                    console.log('[sidearm] table row skipped');
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
        // Fall back to ld+json SportsEvent scripts when table parsing drops dates to 01-01 (e.g., SMU, Cal)
        const ldJsonGames = this.parseLdJsonSchedule(input, { ...options, baseUrl: domain });
        if (ldJsonGames.length > 0) {
            ldJsonGames.forEach(ldGame => {
                const matchKey = this.findMatchingGame(gamesByKey, ldGame);
                if (matchKey) {
                    const existing = gamesByKey[matchKey];
                    const needsDateFix = !existing.date || existing.date.endsWith('-01-01');
                    if (needsDateFix && ldGame.date) {
                        this.updateGameIdentifiers(existing, ldGame.date);
                        if (matchKey !== existing.dedupe_key) {
                            delete gamesByKey[matchKey];
                            gamesByKey[existing.dedupe_key] = existing;
                        }
                    }
                    if (existing.location_type === 'unknown' && ldGame.location_type !== 'unknown') {
                        existing.location_type = ldGame.location_type;
                    }
                    const ldHasScores = ldGame.home_score !== null && ldGame.away_score !== null;
                    const existingHasScores = existing.home_score !== null && existing.away_score !== null;
                    if (!existingHasScores && ldHasScores) {
                        existing.home_score = ldGame.home_score;
                        existing.away_score = ldGame.away_score;
                    }
                    if ((existing.status === 'scheduled' || existing.status === 'unknown') && ldGame.status === 'final') {
                        existing.status = 'final';
                    }
                    if ((!existing.source_urls?.boxscore_url) && ldGame.source_urls?.boxscore_url) {
                        existing.source_urls = {
                            ...existing.source_urls,
                            boxscore_url: ldGame.source_urls.boxscore_url
                        };
                    }
                }
                else {
                    gamesByKey[ldGame.dedupe_key] = ldGame;
                }
            });
        }
        if (Object.keys(gamesByKey).length > 0) {
            if (debug) {
                console.log(`[sidearm] returning ${Object.keys(gamesByKey).length} games`);
            }
            return Object.values(gamesByKey);
        }
        if (ldJsonGames.length > 0) {
            return ldJsonGames;
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
            // Clean team names and detect rankings
            const homeInfo = this.cleanTeamName(home_team_name);
            const awayInfo = this.cleanTeamName(away_team_name);
            home_team_name = homeInfo.cleanName;
            away_team_name = awayInfo.cleanName;
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
                home_team_ranked: homeInfo.isRanked,
                away_team_ranked: awayInfo.isRanked,
                home_score,
                away_score,
                location_type,
                status: gameStatus,
                source_urls: {
                    schedule_url: item.schedule?.url || undefined,
                    boxscore_url: boxscore_url || undefined
                },
                dedupe_key: this.makeDedupeKey(dateStr, home_team_name, away_team_name)
            };
            games.push(game);
        }
        return games;
    }
    parseHtmlGame(card, $, options) {
        try {
            // Opponent name (the team opposite of the context team)
            const opponentName = card.find('.s-game-card__header__team .s-text-paragraph-bold').text().trim() || 'Unknown Opponent';
            // Date extraction (e.g., "Aug 10" or "Aug 10, 2024")
            const dateText = card.find('[data-test-id="s-game-card-standard__header-game-date-details"] span').first().text().trim();
            // Extract year from text if present, otherwise use current year as default
            const yearMatch = dateText.match(/\b(20\d{2})\b/);
            const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
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
            let home_team_name = isHome ? contextTeamName : opponentName;
            let away_team_name = isHome ? opponentName : contextTeamName;
            // Clean team names and detect rankings
            const homeInfo = this.cleanTeamName(home_team_name);
            const awayInfo = this.cleanTeamName(away_team_name);
            home_team_name = homeInfo.cleanName;
            away_team_name = awayInfo.cleanName;
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
                home_team_ranked: homeInfo.isRanked,
                away_team_ranked: awayInfo.isRanked,
                home_score,
                away_score,
                location_type,
                status,
                source_urls: {},
                dedupe_key: this.makeDedupeKey(dateStr, home_team_name, away_team_name)
            };
        }
        catch (e) {
            console.error('Error parsing HTML game card', e);
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
            let home_team_name = isHome ? contextTeamName : opponentName;
            let away_team_name = isHome ? opponentName : contextTeamName;
            // Clean team names and detect rankings
            const homeInfo = this.cleanTeamName(home_team_name);
            const awayInfo = this.cleanTeamName(away_team_name);
            home_team_name = homeInfo.cleanName;
            away_team_name = awayInfo.cleanName;
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
                home_team_ranked: homeInfo.isRanked,
                away_team_ranked: awayInfo.isRanked,
                home_score,
                away_score,
                location_type,
                status,
                source_urls: {
                    boxscore_url: boxscore_url ? this.resolveUrl(boxscore_url, options?.baseUrl) : undefined
                },
                dedupe_key: this.makeDedupeKey(dateStr, home_team_name, away_team_name)
            };
        }
        catch (e) {
            console.error('Error parsing scoreboard item', e);
            return null;
        }
    }
    parseListBasedGame(item, $, options) {
        try {
            // Parse list-based schedule items like li.sidearm-schedule-game (SMU, Cal, etc.)
            // Extract year from page heading
            let year = '2025'; // default fallback
            $('h1, h2, h3').each((_, el) => {
                const text = $(el).text();
                const yearMatch = text.match(/\b(20\d{2})\b/);
                if (yearMatch) {
                    year = yearMatch[1];
                    return false; // break
                }
            });
            // Extract date from .sidearm-schedule-game-opponent-date
            const dateSpan = item.find('.sidearm-schedule-game-opponent-date span').first();
            const dateText = dateSpan.text().trim(); // e.g., "Aug 21 (Thu)"
            const date = this.parseDate(dateText, year);
            // Extract opponent
            const opponentName = item.find('.sidearm-schedule-game-opponent-name').text().trim();
            if (!opponentName)
                return null;
            // Check for home/away
            const isHome = item.hasClass('sidearm-schedule-home-game');
            const contextTeamName = options?.teamName || 'Unknown Team';
            // Normalize names to strip newlines/extra spacing from Sidearm markup
            const homeInfo = this.cleanTeamName(isHome ? contextTeamName : opponentName);
            const awayInfo = this.cleanTeamName(isHome ? opponentName : contextTeamName);
            const homeTeam = homeInfo.cleanName;
            const awayTeam = awayInfo.cleanName;
            // Extract result if available
            const resultText = item.find('.sidearm-schedule-game-result').text().trim();
            let homeScore = null;
            let awayScore = null;
            let status = 'scheduled';
            if (resultText && resultText.match(/\d+-\d+/)) {
                const scoreMatch = resultText.match(/(\d+)-(\d+)/);
                if (scoreMatch) {
                    // The score format depends on if it's showing "us vs them" or "them vs us"
                    const score1 = parseInt(scoreMatch[1]);
                    const score2 = parseInt(scoreMatch[2]);
                    if (isHome) {
                        homeScore = score1;
                        awayScore = score2;
                    }
                    else {
                        awayScore = score1;
                        homeScore = score2;
                    }
                    status = 'final';
                }
            }
            // Extract boxscore link
            let boxscoreUrl;
            item.find('.sidearm-schedule-game-links a, a').each((_, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().toLowerCase();
                if (href && (text.includes('boxscore') || text.includes('recap') || text.includes('stats'))) {
                    boxscoreUrl = this.resolveUrl(href, options?.baseUrl);
                    return false;
                }
            });
            const gameId = `sidearm-${date}-${homeTeam.replace(/\s+/g, '-')}-${awayTeam.replace(/\s+/g, '-')}`;
            const dedupeKey = `${date}-${homeTeam}-${awayTeam}`;
            return {
                game_id: gameId,
                date,
                home_team_name: homeTeam,
                away_team_name: awayTeam,
                home_team_ranked: homeInfo.isRanked,
                away_team_ranked: awayInfo.isRanked,
                home_score: homeScore,
                away_score: awayScore,
                location_type: isHome ? 'home' : 'away',
                status,
                source_urls: { boxscore_url: boxscoreUrl },
                dedupe_key: dedupeKey
            };
        }
        catch (err) {
            if (options?.debug)
                console.log('Error parsing list-based game:', err);
            return null;
        }
    }
    parseTableRow(row, $, options) {
        try {
            // Check if this is a list-based game item (e.g., li.sidearm-schedule-game)
            // Only use list parser for actual <li> elements, not <tr> elements with same class
            if (row.hasClass('sidearm-schedule-game') && row.prop('tagName') === 'LI') {
                return this.parseListBasedGame(row, $, options);
            }
            // Include both th and td cells (Stanford uses th for date column)
            const allCells = row.find('th, td');
            const cells = row.find('td');
            if (allCells.length === 0 && cells.length === 0)
                return null;
            // Use allCells if we have th elements (like Stanford)
            const workingCells = allCells.length > cells.length ? allCells : cells;
            // Drop obvious advertisement spacer rows (e.g., single cell that says "Skip Ad")
            if (workingCells.length === 1) {
                const soloText = workingCells.text().trim().toLowerCase();
                if (soloText.includes('skip ad') || soloText === '') {
                    if (options?.debug)
                        console.log('[debug] Skipping ad/spacer row');
                    return null;
                }
            }
            // Try to infer columns by header labels if available
            // Look in multiple places: immediate table, parent structures, or sibling header rows
            let headerCells = row.closest('table').find('thead th, thead td');
            if (headerCells.length === 0) {
                // Try finding header row as sibling
                headerCells = row.prevAll('tr').find('th, td').filter((_, el) => {
                    const text = $(el).text().trim().toLowerCase();
                    return text.includes('date') || text.includes('opponent') || text.includes('result');
                });
            }
            if (headerCells.length === 0) {
                // Try finding any row with class containing "header"
                headerCells = row.closest('table').find('tr[class*="header"] th, tr[class*="header"] td, .s-table-header__row th, .s-table-header__row td');
            }
            const headers = [];
            headerCells.each((_, h) => {
                headers.push($(h).text().trim().toLowerCase());
            });
            const isNextGen = row.hasClass('s-table-body__row');
            if (options?.debug)
                console.log(`[debug] Row isNextGen=${isNextGen} headers=${headers.length} cells=${workingCells.length}`);
            const getCellByHeader = (label) => {
                const idx = headers.findIndex(h => h.includes(label));
                if (idx === -1)
                    return null;
                return $(workingCells.get(idx));
            };
            let dateCell = getCellByHeader('date') || $(workingCells.get(0));
            let opponentCell = getCellByHeader('opponent') || getCellByHeader('teams') || null;
            let resultCell = getCellByHeader('result') || getCellByHeader('time/results') || null;
            // Debug: log what we found
            if (options?.debug) {
                console.log(`[debug] Headers: ${JSON.stringify(headers)}`);
                console.log(`[debug] Date cell text: "${dateCell.text().trim()}"`);
                console.log(`[debug] Opponent cell text: "${opponentCell ? opponentCell.text().trim() : ''}"`);
                console.log(`[debug] Result cell text: "${resultCell ? resultCell.text().trim() : ''}"`);
            }
            // Skip obvious boxscore/stat tables (team/period/f) that are not schedule rows
            if (headers.length && headers.every(h => ['team', 'period', 'f'].includes(h))) {
                if (options?.debug)
                    console.log('[debug] Skipping boxscore/stat table row');
                return null;
            }
            // Fallback: If headers didn't provide the cells, use heuristics to find them
            if (!opponentCell) {
                // Look for opponent: typically a longer text cell that's not the first or last
                for (let i = 1; i < workingCells.length - 1; i++) {
                    const cellText = $(workingCells.get(i)).text().trim();
                    // Opponent typically has 5+ characters and isn't a date, time, or score
                    if (cellText.length >= 5 &&
                        !cellText.match(/^\d{1,2}:\d{2}/) && // not time
                        !cellText.match(/^\d{1,2}\/\d{1,2}/) && // not date
                        !cellText.match(/^[A-Za-z]+\s*\d{1,2}/) && // not "Aug 21" style
                        !cellText.match(/^\d+\s*-\s*\d+/)) { // not score
                        opponentCell = $(workingCells.get(i));
                        break;
                    }
                }
                // Last resort: use position-based fallback
                if (!opponentCell) {
                    opponentCell = $(workingCells.get(Math.min(3, workingCells.length - 2)));
                }
            }
            if (!resultCell) {
                // Look for result: search for cells with score patterns or W/L indicators
                for (let i = workingCells.length - 3; i < workingCells.length; i++) {
                    if (i < 0 || i >= workingCells.length)
                        continue;
                    const cellText = $(workingCells.get(i)).text().trim();
                    // Match score patterns: "2-1", "W 2-1", "T, 2-2", "L,2-1"
                    if (cellText.match(/\d+\s*-\s*\d+/) || // score like "2-1" anywhere in text
                        cellText.toLowerCase().includes('postponed') ||
                        cellText.toLowerCase().includes('canceled')) {
                        resultCell = $(workingCells.get(i));
                        break;
                    }
                }
                // Last resort: assume second-to-last column (before links)
                if (!resultCell) {
                    resultCell = $(workingCells.get(Math.max(0, workingCells.length - 2)));
                }
            }
            const dateTextRaw = dateCell.text().trim();
            // Extract year from date text if present, otherwise use current year as default
            const yearMatch = dateTextRaw.match(/\b(20\d{2})\b/);
            const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
            // Normalize date text (flatten newlines like "August<br> 08, 2025")
            const dateTextNormalized = dateTextRaw.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
            const inlineYear = (dateTextNormalized.match(/\b(20\d{2})\b/) || [])[1] || year;
            // Try to grab an ISO-like date from attributes or the row HTML first (prevents fallback 01-01)
            const attrDateCandidates = [
                dateCell.attr('data-game-date'),
                dateCell.attr('data-date'),
                dateCell.attr('data-datetime'),
                row.attr('data-game-date'),
                row.attr('data-date'),
                row.attr('data-datetime')
            ].filter(Boolean);
            let dateStr = '';
            for (const candidate of attrDateCandidates) {
                dateStr = this.parseDate(candidate, year);
                if (dateStr && !dateStr.endsWith('-01-01'))
                    break;
            }
            // If no attr-based date, look for ISO in the raw HTML
            if (!dateStr || dateStr.endsWith('-01-01')) {
                const html = (row.html() || '') + (dateCell.html() || '');
                const isoMatch = html.match(/(\d{4}-\d{2}-\d{2})/);
                if (isoMatch) {
                    dateStr = isoMatch[1];
                }
            }
            // Try the full normalized text (with year appended if missing)
            if (!dateStr || dateStr.endsWith('-01-01')) {
                const withYear = /\b20\d{2}\b/.test(dateTextNormalized) ? dateTextNormalized : `${dateTextNormalized} ${inlineYear}`;
                dateStr = this.parseDate(withYear, inlineYear);
            }
            // Finally, fall back to text parsing for "Aug 21" style strings (with or without weekday prefixes)
            if (!dateStr || dateStr.endsWith('-01-01')) {
                // Match patterns like "Aug 21" or "Thu, Aug 21"
                let monthDay = '';
                // Prefer a direct month-day capture to avoid chopping the month name (e.g., "August" being seen as weekday)
                const plainMonth = dateTextRaw.match(/([A-Za-z]{3,})\.?,?\s+(\d{1,2})/);
                const weekdayMonth = dateTextRaw.match(/^[A-Za-z]{3},\s*([A-Za-z]{3,})\.?,?\s+(\d{1,2})/);
                if (plainMonth) {
                    monthDay = `${plainMonth[1]} ${plainMonth[2]}`;
                }
                else if (weekdayMonth) {
                    monthDay = `${weekdayMonth[1]} ${weekdayMonth[2]}`;
                }
                else {
                    monthDay = dateTextRaw.split(/\s+/).slice(0, 2).join(' ');
                }
                // Append year if the text lost it (e.g., "August 08,")
                const monthDayWithYear = /\b20\d{2}\b/.test(monthDay) ? monthDay : `${monthDay} ${inlineYear}`;
                dateStr = this.parseDate(monthDayWithYear, inlineYear);
            }
            if (options?.debug) {
                console.log(`[debug] Parsed date: ${dateStr}`);
            }
            // Extract opponent text more carefully to avoid nested/duplicate content
            // Both Stanford and VT have desktop dividers, but use different class names
            let opponentText = '';
            let stampFromDesktop = '';
            // Strategy 1: Look for Stanford-style structure
            const stanfordDivider = opponentCell.find('.schedule-event-item-team__divider--desktop').first();
            if (stanfordDivider.length) {
                stampFromDesktop = stanfordDivider.text().trim().toLowerCase();
            }
            // Strategy 2: Look for Virginia Tech-style structure (uses different classes)
            const vtDivider = opponentCell.find('.schedule-default-team__divider').first();
            if (!stampFromDesktop && vtDivider.length) {
                stampFromDesktop = vtDivider.text().trim().toLowerCase();
            }
            // Now get opponent name - try both Stanford and VT class names
            let opponentNameElement = opponentCell.find('.schedule-event-item-team__opponent-name').first();
            if (!opponentNameElement.length) {
                opponentNameElement = opponentCell.find('.schedule-default-team__opponent-name').first();
            }
            if (opponentNameElement.length) {
                // Get all text nodes directly (not from descendants) to avoid nested elements
                let textParts = [];
                opponentNameElement.contents().each((_, node) => {
                    if (node.type === 'text') {
                        const text = $(node).text().trim();
                        if (text)
                            textParts.push(text);
                    }
                });
                const cleanName = textParts.join(' ').replace(/\s+/g, ' ').trim();
                // Combine stamp with clean name
                opponentText = stampFromDesktop ? `${stampFromDesktop} ${cleanName}` : cleanName;
            }
            // Strategy 2: If no Stanford-style structure, clean up the cell
            if (!opponentText) {
                const cellClone = opponentCell.clone();
                cellClone.find('.schedule-event-item-team__promo-title').remove();
                cellClone.find('.schedule-event-item-team__divider').remove();
                opponentText = cellClone.text().replace(/\s+/g, ' ').trim();
            }
            if (options?.debug && opponentText) {
                console.log(`[debug] Extracted opponent text: "${opponentText}"`);
            }
            const stampMatch = opponentText.match(/^(vs|at)\.?\s+/i);
            const stamp = stampMatch ? stampMatch[1].toLowerCase() : '';
            let opponentName = opponentText.replace(/^(vs|at)\.?\s+/i, '').trim();
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
            let home_team_name = isHome ? contextTeamName : opponentName;
            let away_team_name = isHome ? opponentName : contextTeamName;
            // Clean team names and detect rankings
            const homeInfo = this.cleanTeamName(home_team_name);
            const awayInfo = this.cleanTeamName(away_team_name);
            home_team_name = homeInfo.cleanName;
            away_team_name = awayInfo.cleanName;
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
            // Attempt to capture boxscore / stats link from the row. Strategy:
            // 1) Prefer inline anchors with text containing "box" / "box score".
            // 2) If absent, look inside the links/media cell (dropdown content is still in the DOM when fetched server-side).
            // 3) Fallback to any anchor that looks like stats/boxscore or, as a last resort, regex the row HTML for boxscore URLs.
            let boxscore_url;
            const linkCell = getCellByHeader('links') || getCellByHeader('media');
            const potentialLinkCell = linkCell || (workingCells.length >= 8 ? $(workingCells.get(7)) : null) || row;
            const findBoxAnchor = (scope) => {
                const anchors = scope.find('a');
                if (options?.debug && anchors.length) {
                    const linkSummaries = anchors.map((_, a) => `${$(a).text().trim()} -> ${$(a).attr('href') || ''}`).get().join(' | ');
                    console.log(`[debug] Link candidates: ${linkSummaries}`);
                }
                // Most specific: text mentions box / box score
                let anchor = anchors.filter((_, a) => {
                    const text = $(a).text().toLowerCase();
                    return text.includes('box score') || text === 'box';
                }).first();
                // Next: href hints at boxscore/stats even if text is generic
                if (!anchor.length) {
                    anchor = anchors.filter((_, a) => {
                        const href = ($(a).attr('href') || '').toLowerCase();
                        return href.includes('boxscore') || href.includes('/stats/');
                    }).first();
                }
                return anchor;
            };
            // Step 1: inline/row-level anchors
            let boxscoreAnchor = findBoxAnchor(row);
            // Step 2: dropdown/links cell anchors
            if (!boxscoreAnchor.length && potentialLinkCell) {
                boxscoreAnchor = findBoxAnchor(potentialLinkCell);
            }
            // Final fallback: scrape from raw HTML for any boxscore-like href
            if (!boxscoreAnchor.length) {
                const html = row.html() || '';
                const match = html.match(/href=\"([^\"]*boxscore[^\"]*)\"/i) || html.match(/"boxscore"\s*:\s*"([^"]+)"/i);
                if (match) {
                    boxscore_url = this.resolveUrl(match[1], options?.baseUrl);
                }
            }
            if (!boxscore_url && boxscoreAnchor.length) {
                const href = boxscoreAnchor.attr('href');
                if (href)
                    boxscore_url = this.resolveUrl(href, options?.baseUrl);
            }
            const safeHome = home_team_name.replace(/\s+/g, '-');
            const safeAway = away_team_name.replace(/\s+/g, '-');
            const derivedId = `sidearm-${dateStr}-${safeHome}-${safeAway}`;
            return {
                game_id: derivedId,
                date: dateStr,
                home_team_name,
                away_team_name,
                home_team_ranked: homeInfo.isRanked,
                away_team_ranked: awayInfo.isRanked,
                home_score,
                away_score,
                location_type,
                status,
                source_urls: {
                    boxscore_url
                },
                dedupe_key: this.makeDedupeKey(dateStr, home_team_name, away_team_name)
            };
        }
        catch (e) {
            console.error('Error parsing table row', e);
            return null;
        }
    }
    parseDate(dateText, year) {
        // More robust parser for Sidearm date formats. Falls back to year-01-01 only when truly unknown.
        if (!dateText)
            return `${year}-01-01`;
        // Normalize whitespace (including NBSP) and strip parenthetical weekday like "(Thursday)"
        const cleaned = dateText
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/[.,]+$/, '')
            .replace(/\s*\([^)]+\)/g, '')
            .trim();
        // Debug date cleaning to track 01-01 issues
        // Note: guarded to avoid noisy logs unless debug enabled upstream
        // eslint-disable-next-line no-console
        if (globalThis.__sidearmDebugDates) {
            console.log(`[parseDate] raw="${dateText}" cleaned="${cleaned}" year=${year}`);
        }
        // Direct ISO
        const isoMatch = cleaned.match(/(\d{4}-\d{2}-\d{2})/);
        if (isoMatch)
            return isoMatch[1];
        // Numeric mm/dd[/yyyy]
        const numeric = cleaned.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
        if (numeric) {
            const month = numeric[1].padStart(2, '0');
            const day = numeric[2].padStart(2, '0');
            let resolvedYear = year;
            if (numeric[3]) {
                resolvedYear = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3];
            }
            return `${resolvedYear}-${month}-${day}`;
        }
        // Month name + day + optional year (e.g., "August 16, 2025" or "Aug 16" or "Thu, Aug 21, 2024")
        const monthDayYear = cleaned.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s*([A-Za-z]{3,})\.?,?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i)
            || cleaned.match(/([A-Za-z]{3,})\.?,?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
        if (monthDayYear) {
            const extractedYear = monthDayYear[3] || year; // Use year from text if present, otherwise use provided year
            const monthName = monthDayYear[1].toLowerCase();
            const monthMap = {
                jan: '01', january: '01',
                feb: '02', february: '02',
                mar: '03', march: '03',
                apr: '04', april: '04',
                may: '05',
                jun: '06', june: '06',
                jul: '07', july: '07',
                aug: '08', august: '08',
                sep: '09', sept: '09', september: '09',
                oct: '10', october: '10',
                nov: '11', november: '11',
                dec: '12', december: '12'
            };
            const monthKey = monthName.slice(0, 3);
            const month = monthMap[monthName] || monthMap[monthKey];
            const day = monthDayYear[2].padStart(2, '0');
            if (month) {
                return `${extractedYear}-${month}-${day}`;
            }
            // Fallback to Date if month map somehow misses
            const date = new Date(`${monthDayYear[1]} ${monthDayYear[2]} ${extractedYear}`);
            if (!isNaN(date.getTime())) {
                return date.toISOString().split('T')[0];
            }
        }
        // Last ditch: let JS try with provided year appended
        const guess = new Date(`${cleaned} ${year}`);
        if (!isNaN(guess.getTime())) {
            return guess.toISOString().split('T')[0];
        }
        return `${year}-01-01`;
    }
    parseLdJsonSchedule(html, options) {
        const games = [];
        try {
            const $ = cheerio.load(html);
            const scripts = $('script[type="application/ld+json"]');
            if (!scripts.length)
                return games;
            const parsed = [];
            scripts.each((_, el) => {
                const content = $(el).contents().text();
                if (!content)
                    return;
                try {
                    parsed.push(JSON.parse(content));
                }
                catch (e) {
                    // ignore invalid JSON blocks
                }
            });
            const events = [];
            const collectEvents = (node) => {
                if (!node)
                    return;
                if (Array.isArray(node)) {
                    node.forEach(collectEvents);
                    return;
                }
                if (node['@graph']) {
                    collectEvents(node['@graph']);
                }
                const type = node['@type'];
                if (type === 'SportsEvent' || (Array.isArray(type) && type.includes('SportsEvent'))) {
                    events.push(node);
                }
            };
            parsed.forEach(collectEvents);
            const contextTeamName = options?.teamName || 'Unknown Team';
            const extractTeamName = (team) => {
                if (!team)
                    return '';
                if (typeof team === 'string')
                    return team;
                if (Array.isArray(team) && team.length)
                    return extractTeamName(team[0]);
                return team.name || team.Team || '';
            };
            for (const evt of events) {
                const rawDate = evt.startDate || evt.start_date || evt.date;
                if (!rawDate)
                    continue;
                const dateStr = String(rawDate).split('T')[0];
                if (!dateStr)
                    continue;
                const title = (evt.name || '').replace(/\s+/g, ' ').trim();
                let location_type = 'unknown';
                let isHome = true;
                let opponentName = '';
                // Prefer explicit matchup strings in the event title
                const matchup = title.match(/(.+?)\s+(vs\.?|at)\s+(.+)/i);
                if (matchup) {
                    const left = matchup[1].trim();
                    const separator = matchup[2].toLowerCase();
                    const right = matchup[3].trim();
                    const leftIsContext = this.namesLikelyMatch(left, contextTeamName);
                    const rightIsContext = this.namesLikelyMatch(right, contextTeamName);
                    if (leftIsContext && !rightIsContext) {
                        isHome = separator.startsWith('vs');
                        opponentName = right;
                    }
                    else if (rightIsContext && !leftIsContext) {
                        isHome = !separator.startsWith('vs');
                        opponentName = left;
                    }
                    else {
                        isHome = separator.startsWith('vs');
                        opponentName = right;
                    }
                    location_type = isHome ? 'home' : 'away';
                }
                // Fallback to schema teams if title did not help
                if (!opponentName) {
                    const homeNameRaw = extractTeamName(evt.homeTeam);
                    const awayNameRaw = extractTeamName(evt.awayTeam);
                    const homeMatchesContext = this.namesLikelyMatch(homeNameRaw, contextTeamName);
                    const awayMatchesContext = this.namesLikelyMatch(awayNameRaw, contextTeamName);
                    if (homeMatchesContext && awayNameRaw) {
                        opponentName = awayNameRaw;
                        isHome = true;
                        location_type = 'home';
                    }
                    else if (awayMatchesContext && homeNameRaw) {
                        opponentName = homeNameRaw;
                        isHome = false;
                        location_type = 'away';
                    }
                    else if (homeNameRaw && awayNameRaw) {
                        // Default to context as home if unknown
                        opponentName = awayNameRaw;
                        isHome = true;
                        location_type = 'home';
                    }
                }
                // Skip schema entries that don't provide a real opponent
                if (!opponentName || /^(unknown opponent|away team|home team)$/i.test(opponentName)) {
                    continue;
                }
                let home_team_name = isHome ? contextTeamName : opponentName;
                let away_team_name = isHome ? opponentName : contextTeamName;
                const homeInfo = this.cleanTeamName(home_team_name);
                const awayInfo = this.cleanTeamName(away_team_name);
                home_team_name = homeInfo.cleanName;
                away_team_name = awayInfo.cleanName;
                const homeScoreRaw = (evt.homeTeam && (evt.homeTeam.score ?? evt.homeTeam.homeScore)) ?? evt.homeScore;
                const awayScoreRaw = (evt.awayTeam && (evt.awayTeam.score ?? evt.awayTeam.awayScore)) ?? evt.awayScore;
                let home_score = null;
                let away_score = null;
                let status = 'scheduled';
                if (homeScoreRaw !== undefined && awayScoreRaw !== undefined) {
                    const hs = parseInt(homeScoreRaw, 10);
                    const as = parseInt(awayScoreRaw, 10);
                    if (!isNaN(hs) && !isNaN(as)) {
                        home_score = hs;
                        away_score = as;
                        status = 'final';
                    }
                }
                const dedupe_key = this.makeDedupeKey(dateStr, home_team_name, away_team_name);
                games.push({
                    game_id: `sidearm-${dateStr}-${home_team_name.replace(/\s+/g, '-')}-${away_team_name.replace(/\s+/g, '-')}`,
                    date: dateStr,
                    home_team_name,
                    away_team_name,
                    home_team_ranked: homeInfo.isRanked,
                    away_team_ranked: awayInfo.isRanked,
                    home_score,
                    away_score,
                    location_type,
                    status,
                    source_urls: { schedule_url: options?.baseUrl },
                    dedupe_key
                });
            }
        }
        catch (e) {
            if (options?.debug)
                console.error('[sidearm] failed to parse ld+json schedule', e);
        }
        return games;
    }
    updateGameIdentifiers(game, newDate) {
        game.date = newDate;
        const safeHome = game.home_team_name.replace(/\s+/g, '-');
        const safeAway = game.away_team_name.replace(/\s+/g, '-');
        game.game_id = `sidearm-${newDate}-${safeHome}-${safeAway}`;
        game.dedupe_key = this.makeDedupeKey(newDate, game.home_team_name, game.away_team_name);
    }
    findMatchingGame(gamesByKey, candidate) {
        const candidateHome = candidate.home_team_name;
        const candidateAway = candidate.away_team_name;
        const candidateDate = candidate.date;
        for (const [key, game] of Object.entries(gamesByKey)) {
            const sameDate = game.date === candidateDate || game.date.endsWith('-01-01');
            const directMatch = this.teamsMatch(game, candidate);
            const looseHome = this.namesLikelyMatch(game.home_team_name, candidateHome);
            const looseAway = this.namesLikelyMatch(game.away_team_name, candidateAway);
            const looseSwap = this.namesLikelyMatch(game.home_team_name, candidateAway) && this.namesLikelyMatch(game.away_team_name, candidateHome);
            if (directMatch || ((looseHome && looseAway) || looseSwap) && sameDate) {
                return key;
            }
        }
        return undefined;
    }
    namesLikelyMatch(a, b) {
        if (!a || !b)
            return false;
        const norm = (val) => val.toLowerCase().replace(/[^a-z0-9]/g, '');
        const initials = (val) => val
            .split(/[^a-zA-Z0-9]+/)
            .filter(Boolean)
            .map(part => part.length <= 3 ? part.toLowerCase() : part[0]?.toLowerCase() || '')
            .join('');
        const na = norm(a);
        const nb = norm(b);
        if (!na || !nb)
            return false;
        return na.includes(nb) || nb.includes(na) || initials(a) === initials(b);
    }
    teamsMatch(a, b) {
        const normalize = (name) => name.toLowerCase().replace(/\s+/g, '-');
        const setA = new Set([normalize(a.home_team_name), normalize(a.away_team_name)]);
        const setB = new Set([normalize(b.home_team_name), normalize(b.away_team_name)]);
        if (setA.size !== setB.size)
            return false;
        for (const name of setA) {
            if (!setB.has(name))
                return false;
        }
        return true;
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
        catch {
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
    parseNextGenJson(html, options) {
        if (options?.debug)
            console.log('[sidearm] parseNextGenJson called');
        const games = [];
        try {
            // Find the script tag containing "schedule": and likely a large array
            // Look for patterns like: var obj = [ ... ]; or window.obj = [ ... ];
            // We use a regex to find the script content first
            const $ = cheerio.load(html);
            let scriptContent = '';
            // Prefer the typed JSON payload if present (id="__NUXT_DATA__")
            let data = null;
            // Fast regex extraction in case cheerio struggles with very large script bodies
            const nuxtRegex = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
            const nuxtMatch = html.match(nuxtRegex);
            if (options?.debug) {
                const markerIdx = html.indexOf('id="__NUXT_DATA__">');
                console.log(`[sidearm] __NUXT_DATA__ regexMatch=${!!nuxtMatch} markerIdx=${markerIdx}`);
            }
            if (nuxtMatch && nuxtMatch[1]) {
                try {
                    const parsed = JSON.parse(nuxtMatch[1]);
                    if (Array.isArray(parsed)) {
                        data = parsed;
                        if (options?.debug)
                            console.log(`[sidearm] Parsed __NUXT_DATA__ via regex length=${parsed.length}`);
                    }
                }
                catch (e) {
                    if (options?.debug)
                        console.error('[sidearm] Regex JSON.parse __NUXT_DATA__ failed', e);
                }
            }
            if (!data) {
                const nuxtJsonScript = $('script#__NUXT_DATA__');
                if (nuxtJsonScript.length) {
                    const content = nuxtJsonScript.contents().text();
                    if (content) {
                        try {
                            const parsed = JSON.parse(content);
                            if (Array.isArray(parsed)) {
                                data = parsed;
                                if (options?.debug)
                                    console.log(`[sidearm] Parsed __NUXT_DATA__ array length=${parsed.length}`);
                            }
                        }
                        catch (e) {
                            if (options?.debug)
                                console.error('[sidearm] Failed to JSON.parse __NUXT_DATA__', e);
                        }
                    }
                }
            }
            // Final fallback: manual slice between marker and closing tag
            if (!data) {
                const marker = 'id="__NUXT_DATA__">';
                const start = html.indexOf(marker);
                if (start !== -1) {
                    const end = html.indexOf('</script>', start);
                    if (end !== -1) {
                        const content = html.slice(start + marker.length, end);
                        try {
                            const parsed = JSON.parse(content);
                            if (Array.isArray(parsed)) {
                                data = parsed;
                                if (options?.debug)
                                    console.log(`[sidearm] Parsed __NUXT_DATA__ via manual slice length=${parsed.length}`);
                            }
                        }
                        catch (e) {
                            if (options?.debug)
                                console.error('[sidearm] Manual slice JSON.parse __NUXT_DATA__ failed', e);
                        }
                    }
                }
            }
            if (!data) {
                $('script').each((_, el) => {
                    const content = $(el).html();
                    if (content && content.includes('"schedule":') && content.includes('ShallowReactive')) {
                        scriptContent = content;
                        return false; // break
                    }
                });
                if (!scriptContent) {
                    if (options?.debug)
                        console.log('[sidearm] No NextGen script found');
                    return [];
                }
                // Extract the array structure
                // It usually starts with [["ShallowReactive" or similar, possibly wrapped in window.__NUXT__ = { data:[ ... ] }
                let parsedFromScript = [];
                const startIdx = scriptContent.indexOf('[["ShallowReactive"');
                if (startIdx !== -1) {
                    // Try to slice from the first ShallowReactive to the matching closing bracket using a bracket counter
                    let endIdx = -1;
                    let depth = 0;
                    for (let i = startIdx; i < scriptContent.length; i++) {
                        const ch = scriptContent[i];
                        if (ch === '[')
                            depth++;
                        if (ch === ']')
                            depth--;
                        if (depth === 0) {
                            endIdx = i;
                            break;
                        }
                    }
                    const rawJson = endIdx !== -1 ? scriptContent.slice(startIdx, endIdx + 1) : scriptContent.slice(startIdx);
                    try {
                        parsedFromScript = new Function(`return ${rawJson}`)();
                    }
                    catch (e) {
                        if (options?.debug)
                            console.error('[sidearm] Failed to eval sliced NextGen array', e);
                    }
                }
                // Fallback: attempt to evaluate window.__NUXT__ object and pull its data array
                if (!Array.isArray(parsedFromScript) || parsedFromScript.length === 0) {
                    try {
                        const wrapped = `(function(){ const window = {}; const globalThis = {}; ${scriptContent}; return (window.__NUXT__ || (globalThis as any).__NUXT__ || (typeof __NUXT__ !== 'undefined' ? __NUXT__ : null)); })()`;
                        const nuxtObj = new Function(wrapped)();
                        if (nuxtObj && Array.isArray(nuxtObj.data)) {
                            // Flatten in case data is nested arrays
                            const flat = [].concat(...nuxtObj.data);
                            const shallow = flat.find((item) => Array.isArray(item) && item[0] === 'ShallowReactive');
                            parsedFromScript = shallow ? flat : nuxtObj.data;
                            if (options?.debug)
                                console.log(`[sidearm] Parsed __NUXT__ payload length=${parsedFromScript.length}`);
                        }
                    }
                    catch (e) {
                        if (options?.debug)
                            console.error('[sidearm] Failed to eval __NUXT__ payload', e);
                    }
                }
                data = parsedFromScript;
            }
            if (!Array.isArray(data) || data.length === 0) {
                if (options?.debug) {
                    console.log('[sidearm] Regex failed to match ShallowReactive array');
                    console.log('[sidearm] Script head:', scriptContent.slice(0, 200));
                }
                return [];
            }
            const resolve = (idx) => {
                if (typeof idx !== 'number')
                    return idx;
                if (idx >= data.length)
                    return null;
                return data[idx];
            };
            // Recursive resolver
            const deepResolve = (obj, depth = 0) => {
                if (depth > 8)
                    return obj;
                if (Array.isArray(obj)) {
                    return obj.map(item => deepResolve(resolve(item), depth + 1));
                }
                if (obj && typeof obj === 'object') {
                    const result = {};
                    for (const [key, val] of Object.entries(obj)) {
                        const resolvedVal = resolve(val);
                        // Recurse only into necessary fields for performance
                        if (['result', 'opponent', 'date', 'location', 'schedule', 'schedules', 'games', 'game_links', 'boxscore'].some(k => key.toLowerCase().includes(k))) {
                            result[key] = deepResolve(resolvedVal, depth + 1);
                        }
                        else {
                            result[key] = resolvedVal;
                        }
                    }
                    return result;
                }
                return obj;
            };
            // Find config object
            const rootConfig = data.find(item => item && typeof item === 'object' && item['schedule']);
            if (!rootConfig)
                return [];
            const scheduleIdx = rootConfig['schedule'];
            const scheduleData = resolve(scheduleIdx);
            if (!scheduleData || !scheduleData['schedules'])
                return [];
            const schedulesIdx = scheduleData['schedules'];
            const schedulesContainer = resolve(schedulesIdx);
            if (!schedulesContainer)
                return [];
            // The container keys are dynamic, e.g. "schedules-mens-soccer"
            // We'll take the first key that looks promising or just the first one
            const scheduleListKey = Object.keys(schedulesContainer)[0];
            const scheduleListIdx = schedulesContainer[scheduleListKey];
            const scheduleList = resolve(scheduleListIdx);
            const resolvedGames = scheduleList ? resolve(scheduleList.games) : null;
            if (!scheduleList || !resolvedGames || !Array.isArray(resolvedGames))
                return [];
            const gameIndices = resolvedGames;
            const contextTeamName = options?.teamName || 'Duke'; // Default or from options
            for (const gameIdx of gameIndices) {
                try {
                    const rawGame = deepResolve(resolve(gameIdx));
                    if (!rawGame)
                        continue;
                    const normalizeBoxscore = (value) => {
                        if (!value)
                            return undefined;
                        if (typeof value === 'string')
                            return value;
                        if (typeof value === 'number')
                            return `${value}`;
                        if (Array.isArray(value)) {
                            const first = value.find((entry) => typeof entry === 'string' || (entry && typeof entry.url === 'string'));
                            if (typeof first === 'string')
                                return first;
                            if (first && typeof first.url === 'string')
                                return first.url;
                            return undefined;
                        }
                        if (typeof value === 'object') {
                            if (typeof value.url === 'string')
                                return value.url;
                            if (typeof value.href === 'string')
                                return value.href;
                            if (typeof value.link === 'string')
                                return value.link;
                        }
                        return undefined;
                    };
                    // Map to Game interface
                    const dateStr = rawGame.date ? rawGame.date.split('T')[0] : '';
                    let opponentName = 'Unknown Opponent';
                    if (rawGame.opponent && rawGame.opponent.title) {
                        opponentName = rawGame.opponent.title;
                    }
                    const isHome = rawGame.location_indicator === 'H';
                    const home_team_name = isHome ? contextTeamName : opponentName;
                    const away_team_name = isHome ? opponentName : contextTeamName;
                    let home_score = null;
                    let away_score = null;
                    let status = 'scheduled';
                    if (rawGame.result) {
                        const teamScore = parseInt(rawGame.result.team_score, 10);
                        const oppScore = parseInt(rawGame.result.opponent_score, 10);
                        // Check if valid scores
                        if (!isNaN(teamScore) && !isNaN(oppScore)) {
                            status = 'final';
                            if (isHome) {
                                home_score = teamScore;
                                away_score = oppScore;
                            }
                            else {
                                home_score = oppScore;
                                away_score = teamScore;
                            }
                        }
                        // Map text status if scores missing
                        if (status === 'scheduled' && rawGame.status) {
                            if (rawGame.status.toLowerCase().includes('post'))
                                status = 'postponed';
                            if (rawGame.status.toLowerCase().includes('canc'))
                                status = 'canceled';
                        }
                    }
                    // Boxscore URL extraction
                    let boxscore_url = normalizeBoxscore(rawGame.result?.boxscore);
                    if (!boxscore_url && rawGame.game_links) {
                        // Sometimes in game_links array
                        const links = rawGame.game_links; // This is extracted as array of objects if recursed
                        if (Array.isArray(links)) {
                            const box = links.find((l) => l.title && l.title.toLowerCase().includes('box score'));
                            if (box)
                                boxscore_url = normalizeBoxscore(box.url ?? box);
                        }
                    }
                    if (typeof boxscore_url === 'string' && boxscore_url) {
                        if (!boxscore_url.startsWith('http')) {
                            const origin = options?.baseUrl ? this.extractOrigin(options.baseUrl) : '';
                            boxscore_url = boxscore_url.startsWith('/') ? `${origin}${boxscore_url}` : `${origin}/${boxscore_url}`;
                        }
                    }
                    else {
                        boxscore_url = undefined;
                    }
                    // Filter duplicates/invalid
                    if (!dateStr)
                        continue;
                    const safeHome = home_team_name.replace(/\s+/g, '-');
                    const safeAway = away_team_name.replace(/\s+/g, '-');
                    const derivedId = `sidearm-${dateStr}-${safeHome}-${safeAway}`;
                    const game = {
                        game_id: derivedId,
                        date: dateStr,
                        home_team_name,
                        away_team_name,
                        home_score,
                        away_score,
                        location_type: isHome ? 'home' : (rawGame.location_indicator === 'A' ? 'away' : 'neutral'),
                        status,
                        source_urls: {
                            boxscore_url: boxscore_url || undefined
                        },
                        dedupe_key: this.makeDedupeKey(dateStr, home_team_name, away_team_name)
                    };
                    games.push(game);
                }
                catch (e) {
                    if (options?.debug)
                        console.error('[sidearm] Error parsing single NextGen game', e);
                }
            }
        }
        catch (e) {
            if (options?.debug)
                console.error('[sidearm] Error in parseNextGenJson', e);
        }
        return games;
    }
}
exports.SidearmParser = SidearmParser;
//# sourceMappingURL=schedule.js.map