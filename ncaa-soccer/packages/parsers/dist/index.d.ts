export * from './types';
import { Parser } from './types';
export * from './sidearm/schedule';
export * from './sidearm/boxscore';
export declare class ParserRegistry {
    private parsers;
    constructor();
    register(parser: Parser): void;
    get(name: string): Parser | undefined;
}
//# sourceMappingURL=index.d.ts.map