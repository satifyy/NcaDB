import { Game } from '@ncaa/shared';
import { Parser, ParseResult, ParserOptions } from '../types';
import { WmtScheduleEvent } from './client';
import { TeamNameResolver } from '../names';
export interface WmtParserOptions extends ParserOptions {
    /** Canonical name of the school whose schedule this is. */
    teamName?: string;
    /** IANA zone the school's kickoff times are quoted in. */
    timeZone?: string;
    /** Maps site spellings onto dataset-canonical names. */
    nameResolver?: TeamNameResolver;
    /** Keep only games in this calendar year, matching the season directory. */
    seasonYear?: number;
    /** Drop exhibitions and scrimmages. Off by default: Sidearm scrapes keep them. */
    excludeExhibitions?: boolean;
}
/**
 * WMT stores kickoff as UTC, so a 7pm Eastern game is stamped the *next* calendar
 * day. Formatting in the school's own zone is what makes a WMT row dedupe against
 * the Sidearm row for the same fixture.
 */
export declare function toLocalDate(isoUtc: string, timeZone: string): string;
/**
 * Turns WMT `/website-api/schedule-events` payloads into `Game` rows.
 *
 * `parseSchedule` takes the JSON text so the parser stays offline-testable;
 * {@link WmtClient} does the fetching.
 */
export declare class WmtParser implements Parser {
    name: string;
    parseSchedule(input: string, options?: WmtParserOptions): Promise<Game[]>;
    parseEvents(events: WmtScheduleEvent[], options?: WmtParserOptions): Game[];
    /** Box scores are handled by `WmtBoxScoreParser`, which reads the stats API. */
    parseBoxScore(_html: string, _options?: ParserOptions): Promise<ParseResult>;
}
//# sourceMappingURL=schedule.d.ts.map