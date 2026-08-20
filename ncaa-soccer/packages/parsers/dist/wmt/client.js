"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.WmtClient = exports.WmtHttpError = void 0;
exports.sportSlugFromScheduleUrl = sportSlugFromScheduleUrl;
exports.seasonNameCandidates = seasonNameCandidates;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
class WmtHttpError extends Error {
    constructor(message, status, url) {
        super(message);
        this.status = status;
        this.url = url;
        this.name = 'WmtHttpError';
    }
}
exports.WmtHttpError = WmtHttpError;
class WmtClient {
    /** @param siteUrl any URL on the school's site, e.g. its schedule page */
    constructor(siteUrl, options = {}) {
        this.origin = new URL(siteUrl).origin;
        this.fetchImpl = options.fetchImpl || fetch;
        this.timeoutMs = options.timeoutMs ?? 30000;
        this.retries = options.retries ?? 3;
    }
    getOrigin() {
        return this.origin;
    }
    async getJson(path, query = {}) {
        const url = new URL(`${this.origin}/website-api/${path.replace(/^\//, '')}`);
        for (const [key, value] of Object.entries(query)) {
            url.searchParams.set(key, String(value));
        }
        let lastError = null;
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
                return (await response.json());
            }
            catch (error) {
                lastError = error;
                // 4xx means the resource is genuinely absent; only retry transport/5xx faults.
                const status = error.status;
                if (status && status >= 400 && status < 500)
                    break;
                if (attempt < this.retries) {
                    await new Promise(resolve => setTimeout(resolve, 750 * attempt));
                }
            }
            finally {
                clearTimeout(timer);
            }
        }
        throw lastError || new WmtHttpError(`Failed to fetch ${url}`, undefined, url.toString());
    }
    /** Numeric sport id for a sport slug ("mens-soccer" at Clemson, "msoc" at Notre Dame). */
    async getSportId(sportSlug) {
        const body = await this.getJson('sports', {
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
    async getSeasonId(seasonName) {
        const body = await this.getJson('seasons', {
            'filter[name]': seasonName
        });
        const match = (body.data || []).find(season => season.name === seasonName);
        return match ? match.id : null;
    }
    /** The schedule that joins one sport to one season. */
    async getScheduleId(sportId, seasonId) {
        const body = await this.getJson('schedules', {
            'filter[sport.id]': sportId,
            'filter[season.id]': seasonId
        });
        return body.data && body.data.length ? body.data[0].id : null;
    }
    /** Every event on a schedule, oldest first, following pagination. */
    async getScheduleEvents(scheduleId) {
        const events = [];
        for (let page = 1; page <= 10; page++) {
            const body = await this.getJson('schedule-events', {
                'filter[schedule_id]': scheduleId,
                'filter[hide_from_specific_sport_schedule]': 'false',
                include: 'opponent,scheduleEventLinks,scheduleEventResult',
                per_page: 100,
                sort: 'datetime',
                page
            });
            events.push(...(body.data || []));
            const lastPage = body.meta?.last_page ?? 1;
            if (page >= lastPage)
                break;
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
    async fetchSeasonEvents(sportSlug, seasonNames) {
        const wanted = Array.isArray(seasonNames) ? seasonNames : [seasonNames];
        const sportId = await this.getSportId(sportSlug);
        if (sportId === null) {
            throw new WmtHttpError(`No sport with slug "${sportSlug}" on ${this.origin}`);
        }
        const byEventId = new Map();
        let matchedAnySchedule = false;
        for (const seasonName of wanted) {
            const seasonId = await this.getSeasonId(seasonName);
            if (seasonId === null)
                continue;
            const scheduleId = await this.getScheduleId(sportId, seasonId);
            if (scheduleId === null)
                continue;
            matchedAnySchedule = true;
            for (const event of await this.getScheduleEvents(scheduleId)) {
                if (!byEventId.has(event.id))
                    byEventId.set(event.id, event);
            }
        }
        if (!matchedAnySchedule) {
            throw new WmtHttpError(`No ${sportSlug} schedule for season ${wanted.map(name => `"${name}"`).join(' or ')} on ${this.origin}`);
        }
        return [...byEventId.values()];
    }
}
exports.WmtClient = WmtClient;
/** Sport slug out of a WMT schedule URL ("/sports/msoc/schedule" -> "msoc"). */
function sportSlugFromScheduleUrl(scheduleUrl) {
    const match = new URL(scheduleUrl).pathname.match(/\/sports\/([^/]+)/);
    return match ? match[1] : null;
}
/**
 * Season display names a WMT site might use for a fall season, most specific first.
 * Academic-year naming ("2025-26") is the common case; Stanford and Virginia Tech
 * use the plain calendar year ("2025").
 */
function seasonNameCandidates(year) {
    const next = String((year + 1) % 100).padStart(2, '0');
    return [`${year}-${next}`, String(year)];
}
//# sourceMappingURL=client.js.map