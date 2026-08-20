import { Game } from '@ncaa/shared';
import { Parser, ParseResult, ParserOptions } from '../types';
import { TeamNameResolver } from '../names';
export interface WmtWordpressOptions extends ParserOptions {
    teamName?: string;
    nameResolver?: TeamNameResolver;
    /** Fall season the page was requested for, e.g. 2025. */
    seasonYear?: number;
    /** IANA zone used to read `data-order` timestamps. */
    timeZone?: string;
}
export declare class WmtWordpressParser implements Parser {
    name: string;
    parseSchedule(html: string, options?: WmtWordpressOptions): Promise<Game[]>;
    /** Box scores on these sites are separate pages; see the box-score stage. */
    parseBoxScore(_html: string, _options?: ParserOptions): Promise<ParseResult>;
}
//# sourceMappingURL=wordpress.d.ts.map