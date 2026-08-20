import { ParseResult, ParserOptions } from '../types';
import { TeamNameResolver } from '../names';
export interface WmtStatsCompetitor {
    teamId?: number;
    score?: number | null;
    homeTeam?: boolean | null;
    nameTabular?: string | null;
}
export interface WmtStatsPlayer {
    team_id?: number;
    xml_name?: string | null;
    xml_short_name?: string | null;
    xml_uni?: string | null;
    xml_position?: string | null;
    games_started?: number | null;
    statistic?: Array<{
        period?: number;
        statistic?: Record<string, number>;
    }>;
}
export interface WmtStatsGame {
    id?: number;
    game_date?: string | null;
    game_date_utc?: string | null;
    local_time_zone?: string | null;
    competitors?: WmtStatsCompetitor[];
    /** Empty games return a bare array here instead of the usual wrapper. */
    players?: {
        data?: WmtStatsPlayer[];
    } | WmtStatsPlayer[];
}
/**
 * Pulls the `wmt.games` match id out of a school box-score page.
 * Nuxt escapes slashes as `/`, so both forms are matched.
 */
export declare function extractStatsGameId(html: string): number | null;
export declare function statsApiUrl(gameId: number): string;
export interface WmtBoxScoreOptions extends ParserOptions {
    nameResolver?: TeamNameResolver;
}
export declare class WmtBoxScoreParser {
    /** Builds player rows from a `api.wmt.games` statistics payload. */
    parseStats(payload: unknown, options?: WmtBoxScoreOptions): ParseResult;
    /**
     * Fetches and parses a box score.
     *
     * @param boxScoreUrl either a school `/boxscore/<id>` page or a `wmt.games` match URL
     */
    fetchBoxScore(boxScoreUrl: string, options?: WmtBoxScoreOptions & {
        fetchImpl?: typeof fetch;
        timeoutMs?: number;
    }): Promise<ParseResult>;
}
//# sourceMappingURL=boxscore.d.ts.map