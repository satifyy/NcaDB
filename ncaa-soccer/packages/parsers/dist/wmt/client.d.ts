/**
 * Minimal client for the JSON API behind WMT Digital athletics sites — in the ACC:
 * Clemson, Notre Dame, Stanford, Virginia and Virginia Tech.
 *
 * These sites are Nuxt apps whose schedule pages are either rendered client-side
 * (Notre Dame) or server-rendered without the year on each row (Clemson), and whose
 * season switcher only changes the URL after hydration. Every site exposes the same
 * `/website-api` REST surface that the page itself calls, so we go there instead of
 * scraping the DOM: it carries exact UTC kickoff times, scores, and box-score links,
 * and it needs no browser.
 */
export interface WmtOpponent {
    id?: number;
    name?: string | null;
    long_name?: string | null;
    /** The opponent's own athletics site, when the school has filled it in. */
    website_url?: string | null;
}
export interface WmtEventResult {
    result?: string | null;
    text?: string | null;
    winning_score?: string | null;
    losing_score?: string | null;
}
export interface WmtEventLink {
    title?: string | null;
    link?: string | null;
}
export interface WmtScheduleEvent {
    id: number;
    datetime: string;
    location?: string | null;
    opponent?: WmtOpponent | null;
    opponent_name?: string | null;
    opponent_school_name?: string | null;
    opponent_ranking?: string | number | null;
    ranking?: string | number | null;
    venue_type?: string | null;
    neutral_event?: boolean | null;
    is_exhibition?: boolean | null;
    is_conference?: boolean | null;
    status?: string | null;
    schedule_event_result?: WmtEventResult | null;
    schedule_event_links?: WmtEventLink[] | null;
    has_box_score?: boolean | null;
    box_score_url?: string | null;
    wmt_stats2_game_id?: number | null;
    wmt_stats2_iframe_url?: string | null;
}
export interface WmtClientOptions {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** Attempts per request, including the first. */
    retries?: number;
}
export declare class WmtHttpError extends Error {
    readonly status?: number | undefined;
    readonly url?: string | undefined;
    constructor(message: string, status?: number | undefined, url?: string | undefined);
}
export declare class WmtClient {
    private readonly origin;
    private readonly fetchImpl;
    private readonly timeoutMs;
    private readonly retries;
    /** @param siteUrl any URL on the school's site, e.g. its schedule page */
    constructor(siteUrl: string, options?: WmtClientOptions);
    getOrigin(): string;
    private getJson;
    /** Numeric sport id for a sport slug ("mens-soccer" at Clemson, "msoc" at Notre Dame). */
    getSportId(sportSlug: string): Promise<number | null>;
    /**
     * Numeric season id for a season display name, or null when the site has none.
     *
     * Season *slugs* differ by site ("2026" at Clemson, "2025-26" at Notre Dame),
     * and so does the naming convention: Clemson, Notre Dame and Virginia label the
     * fall of 2025 "2025-26", while Stanford and Virginia Tech call it "2025".
     */
    getSeasonId(seasonName: string): Promise<number | null>;
    /** The schedule that joins one sport to one season. */
    getScheduleId(sportId: number, seasonId: number): Promise<number | null>;
    /** Every event on a schedule, oldest first, following pagination. */
    getScheduleEvents(scheduleId: number): Promise<WmtScheduleEvent[]>;
    /**
     * Resolves a season's events, merging every schedule that could hold them.
     *
     * Sites disagree about what a season is called and how many schedules it spans.
     * Stanford files men's soccer under "2025" while Clemson calls the same season
     * "2025-26"; Penn State has both, with the fall season under "2025" and a separate
     * spring schedule under "2025-26". Stopping at the first candidate that resolves
     * therefore picks the wrong half at Penn State, so every candidate is followed and
     * the results are unioned by event id. Callers narrow to the games they want with
     * the parser's `seasonYear` filter.
     *
     * @param sportSlug sport slug from the schedule URL path
     * @param seasonNames season display names to try, e.g. ["2025-26", "2025"]
     */
    fetchSeasonEvents(sportSlug: string, seasonNames: string | string[]): Promise<WmtScheduleEvent[]>;
}
/** Sport slug out of a WMT schedule URL ("/sports/msoc/schedule" -> "msoc"). */
export declare function sportSlugFromScheduleUrl(scheduleUrl: string): string | null;
/**
 * Season display names a WMT site might use for a fall season, most specific first.
 * Academic-year naming ("2025-26") is the common case; Stanford and Virginia Tech
 * use the plain calendar year ("2025").
 */
export declare function seasonNameCandidates(year: number): string[];
//# sourceMappingURL=client.d.ts.map