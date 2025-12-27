import { Game, PlayerStat } from '@ncaa/shared';

export interface ParserOptions {
    teamId?: string;
    teamName?: string;
    sourceUrl?: string;
}

export interface ParseResult {
    game: Partial<Game>;
    playerStats: PlayerStat[];
}

export interface Parser {
    name: string;
    // Returns a list of games found on the schedule page
    parseSchedule(html: string, options?: ParserOptions): Promise<Game[]>;
    // Returns detailed stats for a single game
    parseBoxScore(html: string, options?: ParserOptions): Promise<ParseResult>;
}
