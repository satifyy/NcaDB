"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WmtWordpressParser = void 0;
const cheerio = __importStar(require("cheerio"));
const names_1 = require("../names");
/**
 * Schedule parser for WMT Digital's WordPress platform (Kentucky, South Carolina).
 *
 * WMT runs two products. The Nuxt one is handled by {@link WmtParser} through its
 * `/website-api` JSON; this one is WordPress and exposes no equivalent schedule API —
 * `wp-json` carries only editor-facing routes. It does render the whole season into
 * HTML server-side, so this reads that markup directly.
 *
 * Schools theme it differently, so two row shapes are supported: Kentucky's
 * `.schedule-item` and South Carolina's `.schedule-table_row`. They differ in every
 * selector but carry the same fields, so each is described once in {@link THEMES}.
 */
const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
const THEMES = [
    {
        row: '.schedule-item',
        date: '.schedule-item__date time',
        prefix: '.schedule-item__info .prefix',
        opponent: '.schedule-item__team h3',
        ranking: '.schedule-item__info .ranking',
        result: '.schedule-item__result',
        links: '.schedule-item__bottom a'
    },
    {
        row: '.schedule-table_row',
        date: '.schedule-list__top > time',
        prefix: '.schedule-list__teams > span',
        opponent: '.schedule-list__opponent strong',
        ranking: '.schedule-list__opponent .ranking',
        result: '.schedule-list__result',
        links: '.schedule-list__bottom a'
    }
];
const DEFAULT_TIME_ZONE = 'America/New_York';
function isoInZone(date, timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}
/** "Thu. Aug 21" plus a season year -> "2025-08-21". */
function dateFromText(dateText, seasonYear) {
    const match = dateText.replace(/\s+/g, ' ').match(/([A-Za-z]{3,})\.?\s+(\d{1,2})/);
    if (!match)
        return null;
    const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
    if (!month)
        return null;
    // Aug-Dec belong to the season year; Jan-Jul are the spring half that follows it.
    const year = month >= 8 ? seasonYear : seasonYear + 1;
    return `${year}-${String(month).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
}
/**
 * "W 2-1" or "W3-2" from the context team's perspective.
 *
 * Themes render the outcome letter and the score as one string or two elements, and
 * always write the winning score first, so the letter decides which side is ours.
 */
function parseResult(text) {
    const match = text.replace(/\s+/g, ' ').trim().match(/^([WLT])[,\s]*(\d+)\s*-\s*(\d+)/i);
    if (!match)
        return null;
    const [, outcome, first, second] = match;
    const a = Number(first);
    const b = Number(second);
    if (/w/i.test(outcome))
        return { teamScore: Math.max(a, b), opponentScore: Math.min(a, b) };
    if (/l/i.test(outcome))
        return { teamScore: Math.min(a, b), opponentScore: Math.max(a, b) };
    return { teamScore: a, opponentScore: b };
}
class WmtWordpressParser {
    constructor() {
        this.name = 'wmt_wp';
    }
    async parseSchedule(html, options) {
        const $ = cheerio.load(html);
        const resolver = options?.nameResolver || new names_1.TeamNameResolver();
        const seasonYear = options?.seasonYear || new Date().getFullYear();
        const timeZone = options?.timeZone || DEFAULT_TIME_ZONE;
        const contextTeam = resolver.canonical(options?.teamName || 'Unknown Team');
        const origin = options?.baseUrl ? new URL(options.baseUrl).origin : '';
        const theme = THEMES.find(candidate => $(candidate.row).length > 0);
        if (!theme)
            return [];
        const games = [];
        $(theme.row).each((_, element) => {
            const item = $(element);
            // Nested matches would otherwise yield the same fixture twice.
            if (item.parents(theme.row).length > 0)
                return;
            // `data-order` is a unix timestamp and needs no year inference.
            const order = Number(item.attr('data-order'));
            const date = Number.isFinite(order) && order > 0
                ? isoInZone(new Date(order * 1000), timeZone)
                : dateFromText(item.find(theme.date).first().text(), seasonYear);
            if (!date)
                return;
            if (options?.seasonYear && Number(date.slice(0, 4)) !== options.seasonYear)
                return;
            const teamBlock = item.find(theme.opponent).first();
            if (teamBlock.length === 0)
                return;
            const rawOpponent = teamBlock
                .clone()
                .children('small, span') // "(EXH)" and similar qualifiers
                .remove()
                .end()
                .text();
            const opponentInfo = (0, names_1.cleanTeamName)(rawOpponent);
            if (!opponentInfo.name)
                return;
            const opponent = resolver.canonical(opponentInfo.name);
            if (opponent === contextTeam)
                return;
            const prefix = item.find(theme.prefix).first().text().trim().toLowerCase();
            const classes = (item.attr('class') || '').toLowerCase();
            const locationType = /\bneutral\b/.test(classes)
                ? 'neutral'
                : /\baway\b/.test(classes) || prefix === 'at'
                    ? 'away'
                    : /\bhome\b/.test(classes) || prefix.startsWith('vs')
                        ? 'home'
                        : 'unknown';
            const contextIsHome = locationType !== 'away';
            const homeTeam = contextIsHome ? contextTeam : opponent;
            const awayTeam = contextIsHome ? opponent : contextTeam;
            const result = parseResult(item.find(theme.result).first().text());
            const homeScore = result ? (contextIsHome ? result.teamScore : result.opponentScore) : null;
            const awayScore = result ? (contextIsHome ? result.opponentScore : result.teamScore) : null;
            const links = item.find(theme.links).toArray().map(link => ({
                title: $(link).text().replace(/\s+/g, ' ').trim(),
                href: $(link).attr('href') || ''
            }));
            const absolute = (href) => {
                if (!href)
                    return undefined;
                try {
                    return new URL(href, origin || undefined).toString();
                }
                catch {
                    return undefined;
                }
            };
            const boxLink = links.find(l => /box\s*score/i.test(l.title) && !/\.pdf(\?|$)/i.test(l.href)) ||
                links.find(l => /box\s*score/i.test(l.title));
            const recapLink = links.find(l => /recap/i.test(l.title));
            // The ranking badge is rendered against the opponent's side of the row.
            const opponentRanked = opponentInfo.ranked || item.find(theme.ranking).first().text().trim().length > 0;
            const dedupeKey = (0, names_1.makeDedupeKey)(date, homeTeam, awayTeam);
            games.push({
                game_id: `wmtwp-${dedupeKey}`,
                date,
                home_team_name: homeTeam,
                away_team_name: awayTeam,
                home_team_ranked: contextIsHome ? false : opponentRanked,
                away_team_ranked: contextIsHome ? opponentRanked : false,
                home_score: homeScore,
                away_score: awayScore,
                location_type: locationType,
                status: result ? 'final' : 'scheduled',
                source_urls: {
                    schedule_url: options?.sourceUrl || options?.baseUrl,
                    boxscore_url: boxLink ? absolute(boxLink.href) : undefined,
                    recap_url: recapLink ? absolute(recapLink.href) : undefined
                },
                dedupe_key: dedupeKey
            });
        });
        return games;
    }
    /** Box scores on these sites are separate pages; see the box-score stage. */
    async parseBoxScore(_html, _options) {
        return { game: {}, playerStats: [] };
    }
}
exports.WmtWordpressParser = WmtWordpressParser;
//# sourceMappingURL=wordpress.js.map