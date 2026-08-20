"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WmtParser = void 0;
exports.toLocalDate = toLocalDate;
const names_1 = require("../names");
const DEFAULT_TIME_ZONE = 'America/New_York';
/**
 * WMT stores kickoff as UTC, so a 7pm Eastern game is stamped the *next* calendar
 * day. Formatting in the school's own zone is what makes a WMT row dedupe against
 * the Sidearm row for the same fixture.
 */
function toLocalDate(isoUtc, timeZone) {
    const date = new Date(isoUtc);
    if (Number.isNaN(date.getTime()))
        return '';
    // en-CA renders as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}
function parseScore(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
}
function mapStatus(event) {
    switch ((event.status || '').toLowerCase()) {
        case 'completed':
            return 'final';
        case 'cancelled':
        case 'canceled':
            return 'canceled';
        case 'postponed':
            return 'postponed';
        case 'as_scheduled':
        case 'scheduled':
            return 'scheduled';
        default:
            return event.schedule_event_result?.result ? 'final' : 'unknown';
    }
}
/** Prefer a real box-score page; fall back to a PDF only when that is all there is. */
function pickBoxscoreUrl(event, origin) {
    const absolute = (url) => {
        if (!url)
            return undefined;
        const trimmed = url.trim();
        if (!trimmed)
            return undefined;
        // Some links are entered by hand and arrive malformed, e.g. "http://https://...".
        const repaired = trimmed.replace(/^https?:\/\/(?=https?:\/\/)/i, '');
        try {
            return new URL(repaired, origin).toString();
        }
        catch {
            return undefined;
        }
    };
    if (event.has_box_score && event.box_score_url) {
        const url = absolute(event.box_score_url);
        if (url)
            return url;
    }
    const links = event.schedule_event_links || [];
    const htmlLink = links.find(link => /box\s*score/i.test(link.title || '') && !/\.pdf(\?|$)/i.test(link.link || ''));
    if (htmlLink) {
        const url = absolute(htmlLink.link);
        if (url)
            return url;
    }
    const pdfLink = links.find(link => /box\s*score/i.test(link.title || ''));
    return pdfLink ? absolute(pdfLink.link) : undefined;
}
function pickRecapUrl(event, origin) {
    const link = (event.schedule_event_links || []).find(item => /recap/i.test(item.title || ''));
    if (!link?.link)
        return undefined;
    try {
        return new URL(link.link.replace(/^https?:\/\/(?=https?:\/\/)/i, ''), origin).toString();
    }
    catch {
        return undefined;
    }
}
/**
 * Turns WMT `/website-api/schedule-events` payloads into `Game` rows.
 *
 * `parseSchedule` takes the JSON text so the parser stays offline-testable;
 * {@link WmtClient} does the fetching.
 */
class WmtParser {
    constructor() {
        this.name = 'wmt';
    }
    async parseSchedule(input, options) {
        let payload;
        try {
            payload = JSON.parse(input);
        }
        catch {
            throw new Error('WmtParser.parseSchedule expects a schedule-events JSON payload');
        }
        const events = Array.isArray(payload)
            ? payload
            : (payload.data || []);
        return this.parseEvents(events, options);
    }
    parseEvents(events, options) {
        const timeZone = options?.timeZone || DEFAULT_TIME_ZONE;
        const resolver = options?.nameResolver || new names_1.TeamNameResolver();
        const contextTeam = resolver.canonical(options?.teamName || 'Unknown Team');
        const origin = options?.baseUrl ? new URL(options.baseUrl).origin : '';
        // Decided once per school: which of the two opponent fields holds schools.
        const { preferSecondary } = resolver.detectSchoolNameField(events.map(event => ({
            primary: event.opponent_name ?? event.opponent?.name,
            secondary: event.opponent_school_name ?? event.opponent?.long_name
        })));
        const games = [];
        for (const event of events) {
            const date = toLocalDate(event.datetime, timeZone);
            if (!date)
                continue;
            if (options?.seasonYear && Number(date.slice(0, 4)) !== options.seasonYear)
                continue;
            const opponentInfo = resolver.pickSchoolName(event.opponent_name ?? event.opponent?.name, event.opponent_school_name ?? event.opponent?.long_name, preferSecondary);
            if (!opponentInfo.name)
                continue;
            const isExhibition = Boolean(event.is_exhibition) || opponentInfo.exhibition;
            if (options?.excludeExhibitions && isExhibition)
                continue;
            const opponent = resolver.canonical(opponentInfo.name);
            const contextInfo = (0, names_1.cleanTeamName)(contextTeam);
            const venueType = (event.venue_type || '').toLowerCase();
            const locationType = venueType === 'home' || venueType === 'away' || venueType === 'neutral'
                ? venueType
                : event.neutral_event
                    ? 'neutral'
                    : 'unknown';
            // A neutral-site game has no true host; WMT lists the context team first,
            // which is the same convention the Sidearm parser uses.
            const contextIsHome = locationType !== 'away';
            const homeTeam = contextIsHome ? contextInfo.name : opponent;
            const awayTeam = contextIsHome ? opponent : contextInfo.name;
            // Results are recorded as winner/loser scores relative to the context team.
            const result = event.schedule_event_result;
            let teamScore = null;
            let opponentScore = null;
            if (result?.result) {
                const winning = parseScore(result.winning_score);
                const losing = parseScore(result.losing_score);
                const outcome = result.result.toLowerCase();
                if (outcome === 'win') {
                    teamScore = winning;
                    opponentScore = losing;
                }
                else if (outcome === 'loss') {
                    teamScore = losing;
                    opponentScore = winning;
                }
                else {
                    // A tie stores the same value twice.
                    teamScore = winning ?? losing;
                    opponentScore = losing ?? winning;
                }
            }
            const homeScore = contextIsHome ? teamScore : opponentScore;
            const awayScore = contextIsHome ? opponentScore : teamScore;
            const opponentRanked = opponentInfo.ranked ||
                Boolean(event.opponent_ranking !== null && event.opponent_ranking !== undefined && event.opponent_ranking !== '');
            const contextRanked = contextInfo.ranked ||
                Boolean(event.ranking !== null && event.ranking !== undefined && event.ranking !== '');
            const dedupeKey = (0, names_1.makeDedupeKey)(date, homeTeam, awayTeam);
            games.push({
                game_id: `wmt-${dedupeKey}`,
                date,
                home_team_name: homeTeam,
                away_team_name: awayTeam,
                home_team_ranked: contextIsHome ? contextRanked : opponentRanked,
                away_team_ranked: contextIsHome ? opponentRanked : contextRanked,
                home_score: homeScore,
                away_score: awayScore,
                location_type: locationType,
                status: mapStatus(event),
                source_urls: {
                    schedule_url: options?.sourceUrl || options?.baseUrl,
                    boxscore_url: pickBoxscoreUrl(event, origin),
                    recap_url: pickRecapUrl(event, origin)
                },
                dedupe_key: dedupeKey
            });
        }
        return games;
    }
    /** Box scores are handled by `WmtBoxScoreParser`, which reads the stats API. */
    async parseBoxScore(_html, _options) {
        return { game: {}, playerStats: [] };
    }
}
exports.WmtParser = WmtParser;
//# sourceMappingURL=schedule.js.map