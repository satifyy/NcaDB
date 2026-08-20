export * from './types';
import { Parser } from './types';
export * from './sidearm/schedule';
export * from './sidearm/boxscore';
export * from './names';
export * from './wmt/client';
export * from './wmt/schedule';
export * from './wmt/boxscore';
export * from './wmt/wordpress';
export declare class ParserRegistry {
    private parsers;
    constructor();
    register(parser: Parser): void;
    get(name: string): Parser | undefined;
}
//# sourceMappingURL=index.d.ts.map