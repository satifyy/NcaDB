import { Parser, ParseResult, ParserOptions } from './types';
import { Game } from '@ncaa/shared';

export class NotImplementedParser implements Parser {
    name = 'not-implemented';
    async parseSchedule(html: string, options?: ParserOptions): Promise<any[]> {
        return [];
    }
    async parseBoxScore(html: string, options?: ParserOptions): Promise<ParseResult> {
        return { game: {}, playerStats: [] };
    }
}

export class ParserRegistry {
    private parserMap: Map<string, string> = new Map(); // school/team_id -> parserKey
    private parsers: Map<string, Parser> = new Map();

    constructor() {
        this.registerParser("default", new NotImplementedParser());
    }

    registerParser(key: string, parser: Parser) {
        this.parsers.set(key, parser);
    }

    mapTeamToParser(teamId: string, parserKey: string) {
        this.parserMap.set(teamId, parserKey);
    }

    getParser(teamId: string): Parser {
        const parserKey = this.parserMap.get(teamId) || "default";
        return this.parsers.get(parserKey) || new NotImplementedParser();
    }
}

export const registry = new ParserRegistry();
