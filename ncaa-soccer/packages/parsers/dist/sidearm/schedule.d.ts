import { Parser, ParseResult, ParserOptions } from '../types';
import { Game } from '@ncaa/shared';
export declare class SidearmParser implements Parser {
    name: string;
    parseSchedule(input: string, options?: ParserOptions): Promise<Game[]>;
    private parseJsonSchedule;
    private parseHtmlGame;
    private parseDate;
    parseBoxScore(html: string, options?: ParserOptions): Promise<ParseResult>;
}
//# sourceMappingURL=schedule.d.ts.map