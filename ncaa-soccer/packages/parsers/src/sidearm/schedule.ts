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

    async parseSchedule(input: string, options?: ParserOptions): Promise<Game[]> {
        const games: Game[] = [];
        let domain = '';

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

        // HTML Parsing
        const $ = cheerio.load(input);
        const gameCards = $('.s-game-card');

        // If we found any game cards with this selector
        if (gameCards.length > 0) {
            gameCards.each((_, el) => {
                const card = $(el);
                const game = this.parseHtmlGame(card, $, options);
                if (game) games.push(game);
            });
            return games;
        }

        // Fallback for older Sidearm layouts (if any, e.g. .sidearm-schedule-game as backup)
        // ...

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
            const home_team_name = isHome ? contextTeamName : opponentName;
            const away_team_name = isHome ? opponentName : contextTeamName;

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
                home_score,
                away_score,
                location_type,
                status,
                source_urls: {},
                dedupe_key: `${dateStr}-${home_team_name}-${away_team_name}`
            };
        } catch (e) {
            console.error('Error parsing HTML game card', e);
            return null;
        }
    }

    private parseDate(dateText: string, year: string): string {
        // Simple parser for "Aug 10" -> "2025-08-10"
        try {
            const date = new Date(`${dateText} ${year}`);
            if (isNaN(date.getTime())) return `${year}-01-01`; // Fallback
            return date.toISOString().split('T')[0];
        } catch (e) {
            return `${year}-01-01`;
        }
    }

    async parseBoxScore(html: string, options?: ParserOptions): Promise<ParseResult> {
        const boxScoreParser = new SidearmBoxScoreParser();
        return boxScoreParser.parse(html, options);
    }
}
