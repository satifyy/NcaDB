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
    parseSchedule(html: string, options?: ParserOptions): Promise<Game[]>;
    parseBoxScore(html: string, options?: ParserOptions): Promise<ParseResult>;
}
//# sourceMappingURL=types.d.ts.map