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
    result?: string | null; // "win" | "loss" | "tie"
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
    datetime: string; // UTC
    location?: string | null;
    opponent?: WmtOpponent | null;
    opponent_name?: string | null;
    opponent_school_name?: string | null;
    opponent_ranking?: string | number | null;
    ranking?: string | number | null;
    venue_type?: string | null; // "home" | "away" | "neutral"
    neutral_event?: boolean | null;
    is_exhibition?: boolean | null;
    is_conference?: boolean | null;
    status?: string | null; // "completed" | "as_scheduled" | "cancelled" | "postponed"
    schedule_event_result?: WmtEventResult | null;
    schedule_event_links?: WmtEventLink[] | null;
    has_box_score?: boolean | null;
    box_score_url?: string | null;
    wmt_stats2_game_id?: number | null;
    wmt_stats2_iframe_url?: string | null;
}

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

export interface WmtClientOptions {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** Attempts per request, including the first. */
    retries?: number;
}

export class WmtHttpError extends Error {
    constructor(message: string, readonly status?: number, readonly url?: string) {
        super(message);
        this.name = 'WmtHttpError';
    }
}

export class WmtClient {
    private readonly origin: string;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;
    private readonly retries: number;

    /** @param siteUrl any URL on the school's site, e.g. its schedule page */
    constructor(siteUrl: string, options: WmtClientOptions = {}) {
        this.origin = new URL(siteUrl).origin;
        this.fetchImpl = options.fetchImpl || fetch;
        this.timeoutMs = options.timeoutMs ?? 30000;
        this.retries = options.retries ?? 3;
    }

    getOrigin(): string {
        return this.origin;
    }

    private async getJson<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
        const url = new URL(`${this.origin}/website-api/${path.replace(/^\//, '')}`);
        for (const [key, value] of Object.entries(query)) {
            url.searchParams.set(key, String(value));
        }

        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= this.retries; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                const response = await this.fetchImpl(url.toString(), {
                    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
                    signal: controller.signal
                });
                if (!response.ok) {
                    throw new WmtHttpError(`HTTP ${response.status} for ${url}`, response.status, url.toString());
                }
                return (await response.json()) as T;
            } catch (error) {
                lastError = error as Error;
                // 4xx means the resource is genuinely absent; only retry transport/5xx faults.
                const status = (error as WmtHttpError).status;
                if (status && status >= 400 && status < 500) break;
                if (attempt < this.retries) {
                    await new Promise(resolve => setTimeout(resolve, 750 * attempt));
                }
            } finally {
                clearTimeout(timer);
            }
        }
        throw lastError || new WmtHttpError(`Failed to fetch ${url}`, undefined, url.toString());
    }

    /** Numeric sport id for a sport slug ("mens-soccer" at Clemson, "msoc" at Notre Dame). */
    async getSportId(sportSlug: string): Promise<number | null> {
        const body = await this.getJson<{ data: Array<{ id: number; slug: string }> }>('sports', {
            'filter[slug]': sportSlug
        });
        const match = (body.data || []).find(sport => sport.slug === sportSlug) || (body.data || [])[0];
        return match ? match.id : null;
    }

    /**
     * Numeric season id for a season display name, or null when the site has none.
     *
     * Season *slugs* differ by site ("2026" at Clemson, "2025-26" at Notre Dame),
     * and so does the naming convention: Clemson, Notre Dame and Virginia label the
     * fall of 2025 "2025-26", while Stanford and Virginia Tech call it "2025".
     */
    async getSeasonId(seasonName: string): Promise<number | null> {
        const body = await this.getJson<{ data: Array<{ id: number; name: string }> }>('seasons', {
            'filter[name]': seasonName
        });
        const match = (body.data || []).find(season => season.name === seasonName);
        return match ? match.id : null;
    }

    /** The schedule that joins one sport to one season. */
    async getScheduleId(sportId: number, seasonId: number): Promise<number | null> {
        const body = await this.getJson<{ data: Array<{ id: number }> }>('schedules', {
            'filter[sport.id]': sportId,
            'filter[season.id]': seasonId
        });
        return body.data && body.data.length ? body.data[0].id : null;
    }

    /** Every event on a schedule, oldest first, following pagination. */
    async getScheduleEvents(scheduleId: number): Promise<WmtScheduleEvent[]> {
        const events: WmtScheduleEvent[] = [];
        for (let page = 1; page <= 10; page++) {
            const body = await this.getJson<{
                data: WmtScheduleEvent[];
                meta?: { current_page?: number; last_page?: number };
            }>('schedule-events', {
                'filter[schedule_id]': scheduleId,
                'filter[hide_from_specific_sport_schedule]': 'false',
                include: 'opponent,scheduleEventLinks,scheduleEventResult',
                per_page: 100,
                sort: 'datetime',
                page
            });
            events.push(...(body.data || []));
            const lastPage = body.meta?.last_page ?? 1;
            if (page >= lastPage) break;
        }
        return events;
    }

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
    async fetchSeasonEvents(
        sportSlug: string,
        seasonNames: string | string[]
    ): Promise<WmtScheduleEvent[]> {
        const wanted = Array.isArray(seasonNames) ? seasonNames : [seasonNames];
        const sportId = await this.getSportId(sportSlug);
        if (sportId === null) {
            throw new WmtHttpError(`No sport with slug "${sportSlug}" on ${this.origin}`);
        }

        const byEventId = new Map<number, WmtScheduleEvent>();
        let matchedAnySchedule = false;
        for (const seasonName of wanted) {
            const seasonId = await this.getSeasonId(seasonName);
            if (seasonId === null) continue;
            const scheduleId = await this.getScheduleId(sportId, seasonId);
            if (scheduleId === null) continue;
            matchedAnySchedule = true;
            for (const event of await this.getScheduleEvents(scheduleId)) {
                if (!byEventId.has(event.id)) byEventId.set(event.id, event);
            }
        }

        if (!matchedAnySchedule) {
            throw new WmtHttpError(
                `No ${sportSlug} schedule for season ${wanted.map(name => `"${name}"`).join(' or ')} on ${this.origin}`
            );
        }
        return [...byEventId.values()];
    }
}

/** Sport slug out of a WMT schedule URL ("/sports/msoc/schedule" -> "msoc"). */
export function sportSlugFromScheduleUrl(scheduleUrl: string): string | null {
    const match = new URL(scheduleUrl).pathname.match(/\/sports\/([^/]+)/);
    return match ? match[1] : null;
}

/**
 * Season display names a WMT site might use for a fall season, most specific first.
 * Academic-year naming ("2025-26") is the common case; Stanford and Virginia Tech
 * use the plain calendar year ("2025").
 */
export function seasonNameCandidates(year: number): string[] {
    const next = String((year + 1) % 100).padStart(2, '0');
    return [`${year}-${next}`, String(year)];
}
