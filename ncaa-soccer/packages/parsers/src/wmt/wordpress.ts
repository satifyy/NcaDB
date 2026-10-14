import { Game } from '@ncaa/shared';
import * as cheerio from 'cheerio';
import { Parser, ParseResult, ParserOptions } from '../types';
import { TeamNameResolver, cleanTeamName, makeDedupeKey } from '../names';

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

const MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

interface Theme {
    row: string;
    date: string;
    prefix: string;
    opponent: string;
    ranking: string;
    result: string;
    links: string;
}

const THEMES: Theme[] = [
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

export interface WmtWordpressOptions extends ParserOptions {
    teamName?: string;
    nameResolver?: TeamNameResolver;
    /** Fall season the page was requested for, e.g. 2025. */
    seasonYear?: number;
    /** IANA zone used to read `data-order` timestamps. */
    timeZone?: string;
}

const DEFAULT_TIME_ZONE = 'America/New_York';

function isoInZone(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

/** "Thu. Aug 21" plus a season year -> "2025-08-21". */
function dateFromText(dateText: string, seasonYear: number): string | null {
    const match = dateText.replace(/\s+/g, ' ').match(/([A-Za-z]{3,})\.?\s+(\d{1,2})/);
    if (!match) return null;
    const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
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
function parseResult(text: string): { teamScore: number; opponentScore: number } | null {
    const match = text.replace(/\s+/g, ' ').trim().match(/^([WLT])[,\s]*(\d+)\s*-\s*(\d+)/i);
    if (!match) return null;
    const [, outcome, first, second] = match;
    const a = Number(first);
    const b = Number(second);
    if (/w/i.test(outcome)) return { teamScore: Math.max(a, b), opponentScore: Math.min(a, b) };
    if (/l/i.test(outcome)) return { teamScore: Math.min(a, b), opponentScore: Math.max(a, b) };
    return { teamScore: a, opponentScore: b };
}

export class WmtWordpressParser implements Parser {
    name = 'wmt_wp';

    async parseSchedule(html: string, options?: WmtWordpressOptions): Promise<Game[]> {
        const $ = cheerio.load(html);
        const resolver = options?.nameResolver || new TeamNameResolver();
        const seasonYear = options?.seasonYear || new Date().getFullYear();
        const timeZone = options?.timeZone || DEFAULT_TIME_ZONE;
        const contextTeam = resolver.canonical(options?.teamName || 'Unknown Team');
        const origin = options?.baseUrl ? new URL(options.baseUrl).origin : '';

        const theme = THEMES.find(candidate => $(candidate.row).length > 0);
        if (!theme) return [];

        const games: Game[] = [];
        $(theme.row).each((_, element) => {
            const item = $(element);
            // Nested matches would otherwise yield the same fixture twice.
            if (item.parents(theme.row).length > 0) return;

            // `data-order` is a unix timestamp and needs no year inference.
            const order = Number(item.attr('data-order'));
            const date = Number.isFinite(order) && order > 0
                ? isoInZone(new Date(order * 1000), timeZone)
                : dateFromText(item.find(theme.date).first().text(), seasonYear);
            if (!date) return;
            if (options?.seasonYear && Number(date.slice(0, 4)) !== options.seasonYear) return;

            const teamBlock = item.find(theme.opponent).first();
            if (teamBlock.length === 0) return;
            const rawOpponent = teamBlock
                .clone()
                .children('small, span')  // "(EXH)" and similar qualifiers
                .remove()
                .end()
                .text();
            const opponentInfo = cleanTeamName(rawOpponent);
            if (!opponentInfo.name) return;
            const opponent = resolver.canonical(opponentInfo.name);
            if (opponent === contextTeam) return;

            const prefix = item.find(theme.prefix).first().text().trim().toLowerCase();
            const classes = (item.attr('class') || '').toLowerCase();
            const locationType: Game['location_type'] = /\bneutral\b/.test(classes)
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
            const absolute = (href: string): string | undefined => {
                if (!href) return undefined;
                try {
                    return new URL(href, origin || undefined).toString();
                } catch {
                    return undefined;
                }
            };
            const boxLink =
                links.find(l => /box\s*score/i.test(l.title) && !/\.pdf(\?|$)/i.test(l.href)) ||
                links.find(l => /box\s*score/i.test(l.title));
            const recapLink = links.find(l => /recap/i.test(l.title));

            // The ranking badge is rendered against the opponent's side of the row.
            const opponentRanked =
                opponentInfo.ranked || item.find(theme.ranking).first().text().trim().length > 0;

            const dedupeKey = makeDedupeKey(date, homeTeam, awayTeam);
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
    async parseBoxScore(_html: string, _options?: ParserOptions): Promise<ParseResult> {
        return { game: {}, playerStats: [] };
    }
}
