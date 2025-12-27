export * from './types';
import { Parser } from './types';
export * from './sidearm/schedule';
import { SidearmParser } from './sidearm/schedule';
export * from './sidearm/boxscore';

export class ParserRegistry {
    private parsers: Map<string, Parser> = new Map();

    constructor() {
        this.register(new SidearmParser());
    }

    register(parser: Parser) {
        this.parsers.set(parser.name, parser);
    }

    get(name: string): Parser | undefined {
        return this.parsers.get(name);
    }
}
