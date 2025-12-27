import { Parser, ParseResult, ParserOptions } from './types';
export declare class NotImplementedParser implements Parser {
    name: string;
    parseSchedule(html: string, options?: ParserOptions): Promise<any[]>;
    parseBoxScore(html: string, options?: ParserOptions): Promise<ParseResult>;
}
export declare class ParserRegistry {
    private parserMap;
    private parsers;
    constructor();
    registerParser(key: string, parser: Parser): void;
    mapTeamToParser(teamId: string, parserKey: string): void;
    getParser(teamId: string): Parser;
}
export declare const registry: ParserRegistry;
//# sourceMappingURL=registry.d.ts.map