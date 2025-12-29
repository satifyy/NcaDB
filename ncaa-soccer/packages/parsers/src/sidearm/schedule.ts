// @ts-nocheck
import { Parser, ParseResult, ParserOptions } from '../types';
import { Game, GameSchema, PlayerStat } from '@ncaa/shared';
import { z } from 'zod';
import { SidearmBoxScoreParser } from './boxscore';
import * as cheerio from 'cheerio';

const SidearmGameSchema = z.object({
    id: z.number(),
    date: z.string(),
    type: z.string(),
    status: z.string().optional().nullable(),
    location: z.string().optional().nullable(),
    location_indicator: z.string().optional().nullable(), // H, A, N
    neutral_hometeam: z.boolean().optional().nullable(),
    opponent: z.object({
        name: z.string(),
        image: z.string().optional().nullable()
    }),
    result: z.object({
        status: z.string().optional().nullable(), // W, L, T
        team_score: z.string().optional().nullable(),
        opponent_score: z.string().optional().nullable(),
        boxscore: z.string().optional().nullable()
    }).optional().nullable(),
    schedule: z.object({
        url: z.string().optional().nullable()
    }).optional().nullable()
});

const SidearmResponseSchema = z.array(SidearmGameSchema);

export class SidearmParser implements Parser {
    name = 'sidearm';
    
    // Helper to create normalized dedupe key (alphabetically sorted teams to avoid duplicates)
    private makeDedupeKey(date: string, homeTeam: string, awayTeam: string): string {
        const teams = [homeTeam, awayTeam].sort();
        // Normalize by replacing spaces with hyphens
        const team1 = teams[0].replace(/\s+/g, '-');
        const team2 = teams[1].replace(/\s+/g, '-');
        return `${date}-${team1}-${team2}`;
    }
    
    // Helper to clean team names and detect rankings
    private cleanTeamName(name: string): { cleanName: string; isRanked: boolean } {
        let cleanName = name;
        let isRanked = false;
        
        // Check for rankings: "No. 7 Stanford", "#5 Duke", etc.
        if (/^(No\.?|#)\s*\d+\s+/i.test(cleanName)) {
            isRanked = true;
            cleanName = cleanName.replace(/^(No\.?|#)\s*\d+\s+/i, '').trim();
        }
        
        // Remove stars and asterisks: "Clemson * *" -> "Clemson"
        cleanName = cleanName.replace(/\s*\*+\s*/g, ' ').trim();
        
        return { cleanName, isRanked };
    }

    async parseSchedule(input: string, options?: ParserOptions): Promise<Game[]> {
        if (options?.debug) console.log('[sidearm] parseSchedule called with debug=true (v5 - stdout)');
        const games: Game[] = [];
        let domain = options?.baseUrl ? this.extractOrigin(options.baseUrl) : '';

        // Try to parse as JSON first
        try {
            const data = JSON.parse(input);
            const parsed = SidearmResponseSchema.safeParse(data);
            if (parsed.success) {
                return this.parseJsonSchedule(parsed.data, options);
            }
        } catch (e) {
            // Not JSON, continue to HTML parsing
        }

        // Try to parse NextGen embedded JSON (Nuxt hydration data)
        const nextGenGames = this.parseNextGenJson(input, options);
        if (nextGenGames.length > 0) {
            if (options?.debug) console.log(`[sidearm] Found ${nextGenGames.length} games via NextGen JSON`);
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
        const gamesByKey: Record<string, Game> = {};
        const tableRows = $('.c-schedule__table tbody tr, table tbody tr, .s-table-body__row');

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
                } else if (debug) {
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

        if (Object.keys(gamesByKey).length > 0) {
            if (debug) {
                console.log(`[sidearm] returning ${Object.keys(gamesByKey).length} games`);
            }
            return Object.values(gamesByKey);
        }

        return games;
    }

    private parseJsonSchedule(data: z.infer<typeof SidearmResponseSchema>, options?: ParserOptions): Game[] {
        const games: Game[] = [];
        let domain = '';

        for (const item of data) {
            // Try to infer domain from schedule URL if available and not yet set
            if (!domain && item.schedule?.url) {
                try {
                    const url = new URL(item.schedule.url);
                    domain = url.origin;
                } catch (e) { }
            }

            const dateObj = new Date(item.date);
            const dateStr = dateObj.toISOString().split('T')[0];

            // Determine Home/Away
            const loc = item.location_indicator || 'H';
            let isHome = false;

            if (loc === 'H') {
                isHome = true;
            } else if (loc === 'A') {
                isHome = false;
            } else if (loc === 'N') {
                if (item.neutral_hometeam) {
                    isHome = true;
                } else {
                    isHome = false;
                }
            }

            let home_team_name = '';
            let away_team_name = '';
            let home_score: number | null = null;
            let away_score: number | null = null;
            let location_type: "home" | "away" | "neutral" | "unknown" = "unknown";

            if (loc === 'H') location_type = 'home';
            else if (loc === 'A') location_type = 'away';
            else if (loc === 'N') location_type = 'neutral';

            const contextTeamName = options?.teamName || 'Unknown Team';

            if (isHome) {
                home_team_name = contextTeamName;
                away_team_name = item.opponent.name;
                if (item.result) {
                    home_score = item.result.team_score ? parseInt(item.result.team_score, 10) : null;
                    away_score = item.result.opponent_score ? parseInt(item.result.opponent_score, 10) : null;
                }
            } else {
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
            let gameStatus: "final" | "scheduled" | "canceled" | "postponed" | "unknown" = "scheduled";
            if (item.status === 'O' || item.result?.status) {
                gameStatus = 'final';
            } else if (item.status === 'P') {
                gameStatus = 'postponed';
            } else if (item.status === 'C') {
                gameStatus = 'canceled';
            }

            const game: Game = {
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

    private parseHtmlGame(card: cheerio.Cheerio<any>, $: cheerio.CheerioAPI, options?: ParserOptions): Game | null {
        try {
            // Opponent name (the team opposite of the context team)
            const opponentName = card.find('.s-game-card__header__team .s-text-paragraph-bold').text().trim() || 'Unknown Opponent';

            // Date extraction (e.g., "Aug 10")
            const dateText = card.find('[data-test-id="s-game-card-standard__header-game-date-details"] span').first().text().trim();
            const year = new Date().getFullYear().toString(); // Dynamically determine current year
            const dateStr = this.parseDate(dateText, year);

            // Determine location type and whether the context team is home
            const stampText = card.find('.s-stamp__text').text().trim().toLowerCase();
            let location_type: "home" | "away" | "neutral" | "unknown" = "unknown";
            let isHome = true;
            if (stampText === 'at') {
                location_type = 'away';
                isHome = false;
            } else if (stampText === 'vs') {
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
            let home_score: number | null = null;
            let away_score: number | null = null;
            let status: Game["status"] = 'scheduled';
            const scoreMatch = scoreText.match(/(?:([WL])\s*)?(\d+)-(\d+)/i);
            if (scoreMatch) {
                status = 'final';
                const first = parseInt(scoreMatch[2], 10);
                const second = parseInt(scoreMatch[3], 10);
                if (isHome) {
                    home_score = first;
                    away_score = second;
                } else {
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
        } catch (e) {
            console.error('Error parsing HTML game card', e);
            return null;
        }
    }

    private parseScoreboardItem(item: cheerio.Cheerio<any>, $: cheerio.CheerioAPI, options?: ParserOptions): Game | null {
        try {
            const opponentName = item.find('.c-scoreboard__logo img').attr('alt')?.trim() || 'Unknown Opponent';
            const dateText = item.find('.c-scoreboard__date span').first().text().trim();
            const year = new Date().getFullYear().toString();
            const dateStr = this.parseDate(dateText, year);

            const atVsText = item.find('.c-scoreboard__atvs').text().trim().toLowerCase();
            let location_type: "home" | "away" | "neutral" | "unknown" = 'unknown';
            let isHome = true;

            if (item.hasClass('c-scoreboard__item--home') || atVsText === 'vs') {
                location_type = 'home';
                isHome = true;
            } else if (item.hasClass('c-scoreboard__item--away') || atVsText === 'at') {
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
            let home_score: number | null = null;
            let away_score: number | null = null;
            let status: Game["status"] = 'scheduled';
            const scoreMatch = scoreText.match(/(?:([WL])\s*)?(\d+)-(\d+)/i);
            if (scoreMatch) {
                status = 'final';
                const first = parseInt(scoreMatch[2], 10);
                const second = parseInt(scoreMatch[3], 10);
                if (isHome) {
                    home_score = first;
                    away_score = second;
                } else {
                    home_score = second;
                    away_score = first;
                }
            } else {
                const statusText = item.find('.c-scoreboard__status').text().toLowerCase();
                if (statusText.includes('final')) status = 'final';
                else if (statusText.includes('post')) status = 'postponed';
                else if (statusText.includes('cancel')) status = 'canceled';
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
        } catch (e) {
            console.error('Error parsing scoreboard item', e);
            return null;
        }
    }

    private parseTableRow(row: cheerio.Cheerio<any>, $: cheerio.CheerioAPI, options?: ParserOptions): Game | null {
        try {
            // Include both th and td cells (Stanford uses th for date column)
            const allCells = row.find('th, td');
            const cells = row.find('td');
            if (allCells.length === 0 && cells.length === 0) return null;
            
            // Use allCells if we have th elements (like Stanford)
            const workingCells = allCells.length > cells.length ? allCells : cells;

            // Try to infer columns by header labels if available
            const headerCells = row.closest('table').find('thead th');
            const headers: string[] = [];
            headerCells.each((_, h) => {
                headers.push($(h).text().trim().toLowerCase());
            });

            const isNextGen = row.hasClass('s-table-body__row');
            if (options?.debug) console.log(`[debug] Row isNextGen=${isNextGen} headers=${headers.length} cells=${workingCells.length}`);

            const getCellByHeader = (label: string): cheerio.Cheerio<any> | null => {
                const idx = headers.findIndex(h => h.includes(label));
                if (idx === -1) return null;
                return $(workingCells.get(idx));
            };

            let dateCell = getCellByHeader('date') || $(workingCells.get(0));
            let opponentCell = getCellByHeader('opponent') || getCellByHeader('teams') || $(workingCells.get(1));
            let resultCell = getCellByHeader('result') || getCellByHeader('time/results') || $(workingCells.get(workingCells.length - 2)); // -2 because last is links
            
            // Debug: log what we found
            if (options?.debug) {
                console.log(`[debug] Headers: ${JSON.stringify(headers)}`);
                console.log(`[debug] Date cell text: "${dateCell.text().trim()}"`);
                console.log(`[debug] Opponent cell text: "${opponentCell.text().trim()}"`);
                console.log(`[debug] Result cell text: "${resultCell.text().trim()}"`);
            }

            if (isNextGen && headers.length === 0) {
                // NextGen layout (e.g. Duke)
                // 0: Date, 1: Time, 2: Site, 3: Opponent, 4: Location, 5: ?, 6: Type, 7: Result, 8: Links
                if (workingCells.length >= 8) {
                    dateCell = $(workingCells.get(0));
                    opponentCell = $(workingCells.get(3));
                    resultCell = $(workingCells.get(7));
                    // Links often at index 8
                }
            }

            const dateTextRaw = dateCell.text().trim();
            const year = new Date().getFullYear().toString();

            // Try to grab an ISO-like date from attributes or the row HTML first (prevents fallback 01-01)
            const attrDateCandidates = [
                dateCell.attr('data-game-date'),
                dateCell.attr('data-date'),
                dateCell.attr('data-datetime'),
                row.attr('data-game-date'),
                row.attr('data-date'),
                row.attr('data-datetime')
            ].filter(Boolean) as string[];

            let dateStr = '';
            for (const candidate of attrDateCandidates) {
                dateStr = this.parseDate(candidate, year);
                if (dateStr && !dateStr.endsWith('-01-01')) break;
            }

            // If no attr-based date, look for ISO in the raw HTML
            if (!dateStr || dateStr.endsWith('-01-01')) {
                const html = (row.html() || '') + (dateCell.html() || '');
                const isoMatch = html.match(/(\d{4}-\d{2}-\d{2})/);
                if (isoMatch) {
                    dateStr = isoMatch[1];
                }
            }

            // Finally, fall back to text parsing for "Aug 21" style strings (with or without weekday prefixes)
            if (!dateStr || dateStr.endsWith('-01-01')) {
                // Match patterns like "Aug 21" or "Thu, Aug 21"
                let monthDay = '';
                const weekdayMonth = dateTextRaw.match(/^[A-Za-z]{3},?\s*([A-Za-z]{3,})\.?,?\s+(\d{1,2})/);
                const plainMonth = dateTextRaw.match(/([A-Za-z]{3,})\.?,?\s+(\d{1,2})/);
                if (weekdayMonth) {
                    monthDay = `${weekdayMonth[1]} ${weekdayMonth[2]}`;
                } else if (plainMonth) {
                    monthDay = `${plainMonth[1]} ${plainMonth[2]}`;
                } else {
                    monthDay = dateTextRaw.split(/\s+/).slice(0, 2).join(' ');
                }
                dateStr = this.parseDate(monthDay, year);
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
                let textParts: string[] = [];
                opponentNameElement.contents().each((_, node) => {
                    if (node.type === 'text') {
                        const text = $(node).text().trim();
                        if (text) textParts.push(text);
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
            if (!opponentName) opponentName = 'Unknown Opponent';

            let location_type: "home" | "away" | "neutral" | "unknown" = 'unknown';
            let isHome = true;
            if (stamp === 'at') {
                location_type = 'away';
                isHome = false;
            } else if (stamp === 'vs') {
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
            let home_score: number | null = null;
            let away_score: number | null = null;
            let status: Game["status"] = 'scheduled';
            const scoreMatch = resultText.match(/(\d+)\s*-\s*(\d+)/);
            if (scoreMatch) {
                status = 'final';
                const first = parseInt(scoreMatch[1], 10);
                const second = parseInt(scoreMatch[2], 10);
                if (isHome) {
                    home_score = first;
                    away_score = second;
                } else {
                    home_score = second;
                    away_score = first;
                }
            } else if (/final/i.test(resultText)) {
                status = 'final';
            } else if (/post/i.test(resultText)) {
                status = 'postponed';
            } else if (/cancel/i.test(resultText)) {
                status = 'canceled';
            }

            // Attempt to capture boxscore / stats link from the links cell
            // For Stanford-style: Recap is first, Box Score is second
            let boxscore_url: string | undefined;
            const linkCell = getCellByHeader('links') || getCellByHeader('media') || (row.find('a').length ? row : null);
            if (linkCell) {
                const links = linkCell.find('a');
                // Try to find explicit "Box Score" link
                let boxscoreLink = links.filter((_, a) => {
                    const text = $(a).text().toLowerCase();
                    const href = $(a).attr('href') || '';
                    return text.includes('box score') || href.includes('boxscore');
                }).first();
                
                // Fallback to first link if no boxscore found
                if (!boxscoreLink.length) {
                    boxscoreLink = links.first();
                }
                
                const href = boxscoreLink.attr('href');
                if (href) boxscore_url = this.resolveUrl(href, options?.baseUrl);
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
        } catch (e) {
            console.error('Error parsing table row', e);
            return null;
        }
    }

    private parseDate(dateText: string, year: string): string {
        // More robust parser for Sidearm date formats. Falls back to year-01-01 only when truly unknown.
        if (!dateText) return `${year}-01-01`;

        const cleaned = dateText.replace(/\s+/g, ' ').trim();

        // Direct ISO
        const isoMatch = cleaned.match(/(\d{4}-\d{2}-\d{2})/);
        if (isoMatch) return isoMatch[1];

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

        // Month name + day (with optional weekday prefix)
        const monthDay = cleaned.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s*([A-Za-z]{3,})\.?,?\s+(\d{1,2})/i)
            || cleaned.match(/([A-Za-z]{3,})\.?,?\s+(\d{1,2})/i);
        if (monthDay) {
            const date = new Date(`${monthDay[1]} ${monthDay[2]} ${year}`);
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

    private resolveUrl(href: string, baseUrl?: string): string {
        if (!href) return href;
        if (href.startsWith('http')) return href;
        if (!baseUrl) return href;
        const origin = this.extractOrigin(baseUrl);
        if (!origin) return href;
        if (href.startsWith('/')) return `${origin}${href}`;
        return `${origin}/${href}`;
    }

    private extractOrigin(url?: string): string {
        if (!url) return '';
        try {
            const u = new URL(url);
            return u.origin;
        } catch {
            return '';
        }
    }

    private findCanonical($: cheerio.CheerioAPI): string | undefined {
        const link = $('link[rel="canonical"]').attr('href');
        return link || undefined;
    }

    async parseBoxScore(html: string, options?: ParserOptions): Promise<ParseResult> {
        const boxScoreParser = new SidearmBoxScoreParser();
        return boxScoreParser.parse(html, options);
    }

    private parseNextGenJson(html: string, options?: ParserOptions): Game[] {
        if (options?.debug) console.log('[sidearm] parseNextGenJson called');
        const games: Game[] = [];
        try {
            // Find the script tag containing "schedule": and likely a large array
            // Look for patterns like: var obj = [ ... ]; or window.obj = [ ... ];
            // We use a regex to find the script content first
            const $ = cheerio.load(html);
            let scriptContent = '';

            $('script').each((_, el) => {
                const content = $(el).html();
                if (content && content.includes('"schedule":') && content.includes('ShallowReactive')) {
                    scriptContent = content;
                    return false; // break
                }
            });

            if (!scriptContent) {
                if (options?.debug) console.log('[sidearm] No NextGen script found');
                return [];
            }

            // Extract the array structure
            // It usually starts with [["ShallowReactive" or similar
            // We'll try to find the outermost array
            const match = scriptContent.match(/=\s*(\[\["ShallowReactive".*\]\]);?/s) || scriptContent.match(/(\[\["ShallowReactive".*\]\])/s);
            if (!match) {
                if (options?.debug) console.log('[sidearm] Regex failed to match ShallowReactive array');
                return [];
            }

            const rawJson = match[1];
            let data: any[] = [];

            try {
                // Use a safe approach to parse this JS array literal
                // Since it might contain undefined or other JS values, JSON.parse might fail
                // We'll use Function return
                data = new Function(`return ${rawJson}`)();
            } catch (e) {
                if (options?.debug) console.error('[sidearm] Failed to eval NextGen JSON', e);
                return [];
            }

            if (!Array.isArray(data)) {
                if (options?.debug) console.log('[sidearm] Evaluated data is not an array');
                return [];
            }

            const resolve = (idx: any) => {
                if (typeof idx !== 'number') return idx;
                if (idx >= data.length) return null;
                return data[idx];
            }

            // Recursive resolver
            const deepResolve = (obj: any, depth = 0): any => {
                if (depth > 5) return obj;
                if (Array.isArray(obj)) {
                    return obj.map(item => deepResolve(resolve(item), depth + 1));
                }
                if (obj && typeof obj === 'object') {
                    const result: any = {};
                    for (const [key, val] of Object.entries(obj)) {
                        const resolvedVal = resolve(val);
                        // Recurse only into necessary fields for performance
                        if (['result', 'opponent', 'date', 'location', 'schedule', 'schedules', 'games', 'game_links', 'boxscore'].some(k => key.toLowerCase().includes(k))) {
                            result[key] = deepResolve(resolvedVal, depth + 1);
                        } else {
                            result[key] = resolvedVal;
                        }
                    }
                    return result;
                }
                return obj;
            }

            // Find config object
            const rootConfig = data.find(item => item && typeof item === 'object' && item['schedule']);
            if (!rootConfig) return [];

            const scheduleIdx = rootConfig['schedule'];
            const scheduleData = resolve(scheduleIdx);

            if (!scheduleData || !scheduleData['schedules']) return [];

            const schedulesIdx = scheduleData['schedules'];
            const schedulesContainer = resolve(schedulesIdx);

            if (!schedulesContainer) return [];

            // The container keys are dynamic, e.g. "schedules-mens-soccer"
            // We'll take the first key that looks promising or just the first one
            const scheduleListKey = Object.keys(schedulesContainer)[0];
            const scheduleListIdx = schedulesContainer[scheduleListKey];
            const scheduleList = resolve(scheduleListIdx);

            if (!scheduleList || !scheduleList.games || !Array.isArray(scheduleList.games)) return [];

            const gameIndices = scheduleList.games;
            const contextTeamName = options?.teamName || 'Duke'; // Default or from options

            for (const gameIdx of gameIndices) {
                try {
                    const rawGame = deepResolve(resolve(gameIdx));
                    if (!rawGame) continue;

                    // Map to Game interface
                    const dateStr = rawGame.date ? rawGame.date.split('T')[0] : '';

                    let opponentName = 'Unknown Opponent';
                    if (rawGame.opponent && rawGame.opponent.title) {
                        opponentName = rawGame.opponent.title;
                    }

                    const isHome = rawGame.location_indicator === 'H';
                    const home_team_name = isHome ? contextTeamName : opponentName;
                    const away_team_name = isHome ? opponentName : contextTeamName;

                    let home_score: number | null = null;
                    let away_score: number | null = null;
                    let status: Game['status'] = 'scheduled';

                    if (rawGame.result) {
                        const teamScore = parseInt(rawGame.result.team_score, 10);
                        const oppScore = parseInt(rawGame.result.opponent_score, 10);

                        // Check if valid scores
                        if (!isNaN(teamScore) && !isNaN(oppScore)) {
                            status = 'final';
                            if (isHome) {
                                home_score = teamScore;
                                away_score = oppScore;
                            } else {
                                home_score = oppScore;
                                away_score = teamScore;
                            }
                        }

                        // Map text status if scores missing
                        if (status === 'scheduled' && rawGame.status) {
                            if (rawGame.status.toLowerCase().includes('post')) status = 'postponed';
                            if (rawGame.status.toLowerCase().includes('canc')) status = 'canceled';
                        }
                    }

                    // Boxscore URL extraction
                    let boxscore_url = rawGame.result?.boxscore;
                    if (!boxscore_url && rawGame.game_links) {
                        // Sometimes in game_links array
                        const links = rawGame.game_links; // This is extracted as array of objects if recursed
                        if (Array.isArray(links)) {
                            const box = links.find((l: any) => l.title && l.title.toLowerCase().includes('box score'));
                            if (box && box.url) boxscore_url = box.url;
                        }
                    }

                    if (boxscore_url && !boxscore_url.startsWith('http')) {
                        const origin = options?.baseUrl ? this.extractOrigin(options.baseUrl) : '';
                        boxscore_url = boxscore_url.startsWith('/') ? `${origin}${boxscore_url}` : `${origin}/${boxscore_url}`;
                    }

                    // Filter duplicates/invalid
                    if (!dateStr) continue;

                    const safeHome = home_team_name.replace(/\s+/g, '-');
                    const safeAway = away_team_name.replace(/\s+/g, '-');
                    const derivedId = `sidearm-${dateStr}-${safeHome}-${safeAway}`;

                    const game: Game = {
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

                } catch (e) {
                    if (options?.debug) console.error('[sidearm] Error parsing single NextGen game', e);
                }
            }

        } catch (e) {
            if (options?.debug) console.error('[sidearm] Error in parseNextGenJson', e);
        }
        return games;
    }
}
