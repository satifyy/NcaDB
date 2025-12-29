import { Parser, ParseResult, ParserOptions } from '../types';
import { Game } from '@ncaa/shared';
export declare class SidearmParser implements Parser {
    name: string;
    private makeDedupeKey;
    private cleanTeamName;
    parseSchedule(input: string, options?: ParserOptions): Promise<Game[]>;
    private parseJsonSchedule;
    private parseHtmlGame;
    private parseScoreboardItem;
    private parseListBasedGame;
    private parseTableRow;
    private parseDate;
    private resolveUrl;
    private extractOrigin;
    private findCanonical;
    parseBoxScore(html: string, options?: ParserOptions): Promise<ParseResult>;
    private parseNextGenJson;
}
//# sourceMappingURL=schedule.d.ts.map