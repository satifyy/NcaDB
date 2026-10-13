export * from './types';
import { Parser } from './types';
export * from './sidearm/schedule';
import { SidearmParser } from './sidearm/schedule';
export * from './sidearm/boxscore';
export * from './names';
export * from './game_type';
export * from './wmt/client';
export * from './wmt/schedule';
export * from './wmt/boxscore';
export * from './wmt/wordpress';
import { WmtParser } from './wmt/schedule';
import { WmtWordpressParser } from './wmt/wordpress';

export class ParserRegistry {
    private parsers: Map<string, Parser> = new Map();

    constructor() {
        this.register(new SidearmParser());
        this.register(new WmtParser());
        this.register(new WmtWordpressParser());
    }

    register(parser: Parser) {
        this.parsers.set(parser.name, parser);
    }

    get(name: string): Parser | undefined {
        return this.parsers.get(name);
    }
}
