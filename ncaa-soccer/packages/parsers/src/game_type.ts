/**
 * What kind of fixture a row is — and, just as importantly, how well we know it.
 *
 * Not every game in the dataset is worth the same. A friendly against a nearby NAIA side
 * is evidence, but it is not the evidence a conference final is, and rating the two
 * identically is how a team that opened against three D2 programs ends up flattered. The
 * ratings can only weight what the rows actually say, so the fixture kind has to survive
 * onto disk instead of being inferred again by whoever reads the file next.
 *
 * The signals differ sharply in quality, and this module keeps that difference visible
 * rather than flattening it into one label:
 *
 * - **Exhibitions are stated.** WMT returns `is_exhibition` outright, and Sidearm schools
 *   hang the marker on the opponent — "Marist (Exhibition)", "Clemson (Exhib.)". Both are
 *   direct claims by the school about its own fixture.
 *
 * - **Postseason rounds are stated only sometimes.** A minority of bracket games carry
 *   the round in the opponent name ("Stony Brook (CAA Semifinals)", "Syracuse - First
 *   Round"); most carry nothing at all. The round marker is therefore a *floor* on the
 *   postseason, never a census of it, and `regular` here means "nothing said otherwise",
 *   not "known to be a regular-season game".
 *
 * - **Conference vs non-conference is not represented at all.** Sidearm marks conference
 *   opponents with an asterisk, `cleanTeamName` strips it, and no asterisk survives into
 *   any stored row. Deriving it from a membership table instead would need membership by
 *   season, which `data/teams/*.json` does not carry — it lists Stanford as ACC, true
 *   from 2024 and wrong for the seven Pac-12 seasons before it. So this module does not
 *   guess: there is deliberately no `conference` value below.
 *
 * The `evidence` field on the result says which of those cases produced the label, so a
 * consumer can weight a stated exhibition differently from a round inferred off the
 * calendar, and so a backfill can report what it actually knew.
 *
 * Markers are read from the ids as well as the names because the pipeline destroys them
 * on the way in: `normalizeRow` runs {@link cleanTeamName} over the team-name columns,
 * which strips "(Exhibition)" from the name but leaves `game_id` and `dedupe_key` exactly
 * as the site published them. The ids are where the marker still lives.
 */

import { EXHIBITION_RE } from './names';

/**
 * The kinds a stored fixture can be labelled with.
 *
 * `regular` is the absence of a marker rather than a positive finding — see the module
 * note above before treating it as one.
 */
export type GameType = 'exhibition' | 'ncaa_tournament' | 'conference_tournament' | 'regular';

/**
 * How the label was arrived at, in descending order of how much it should be trusted.
 *
 * - `flag` — the source said so in a structured field (WMT's `is_exhibition`).
 * - `marker` — the source wrote it into the fixture text ("(Exhibition)", "NCAA First Round").
 * - `date` — a round marker was present but the NCAA tournament was not named, and the
 *   calendar decided which bracket it was. A row reading "Stony Brook (CAA Semifinals)"
 *   lands here rather than on `marker`: the school did name its bracket, but only the
 *   NCAA one is recognised by name, because a list of conference spellings would have to
 *   be maintained against realignment to earn the extra confidence.
 * - `default` — nothing said anything; the row fell through to `regular`.
 */
export type GameTypeEvidence = 'flag' | 'marker' | 'date' | 'default';

export const GAME_TYPES: readonly GameType[] = [
    'exhibition',
    'ncaa_tournament',
    'conference_tournament',
    'regular'
];

/**
 * Bracket rounds, as schools write them.
 *
 * Matched against fixture text only — team names and the ids built from them — never
 * against the `status` column, where "final" means a played game and would otherwise
 * label the entire dataset a postseason.
 */
const ROUND_RE = new RegExp(
    String.raw`\b(?:` +
        String.raw`quarter\s?-?finals?|semi\s?-?finals?|finals?|championships?` +
        String.raw`|(?:first|second|third|fourth|opening)\s+round` +
        String.raw`|round\s+of\s+\d{1,2}` +
        String.raw`|play\s?-?in` +
        String.raw`|elite\s+eight|sweet\s+sixteen` +
    String.raw`)\b`,
    'i'
);

const NCAA_RE = /\bncaa\b/i;

/**
 * The earliest the NCAA tournament has opened, as `MM-DD`.
 *
 * Used only to break a tie a round marker left open — "(Semifinals)" names a round but
 * not a bracket. Across 2022-2025 the first round fell on Nov 19-21 and conference
 * championship weekend ended Nov 16-17, so the two never met at this boundary. It is a
 * tiebreak on rows already known to be postseason, not a test for whether one is.
 */
const NCAA_ROUND_ONE_EARLIEST = '11-18';

/**
 * The earliest a round marker means the postseason rather than a preseason bracket.
 *
 * August and September carry "finals" too — schools play in kickoff classics and
 * invitationals whose last game is a final in exactly the same words. No conference
 * bracket starts before November, so a round marker before then is not one.
 */
const POSTSEASON_EARLIEST = '11-01';

export interface GameTypeInput {
    home_team_name?: string | null;
    away_team_name?: string | null;
    /**
     * Ids are built from the names the site published, so they keep the markers the
     * cleaned name columns lost. Pass them whenever they are available.
     */
    game_id?: string | null;
    dedupe_key?: string | null;
    /** ISO `YYYY-MM-DD`. Only used to resolve a round marker onto a bracket. */
    date?: string | null;
    /** WMT states this outright; no other source does. */
    is_exhibition?: boolean | null;
}

export interface GameTypeResult {
    type: GameType;
    evidence: GameTypeEvidence;
}

export function isGameType(value: unknown): value is GameType {
    return typeof value === 'string' && (GAME_TYPES as readonly string[]).includes(value);
}

/**
 * Everything about a row that could carry a fixture marker, as one searchable string.
 *
 * Ids join their parts with hyphens, so "NCAA-First-Round" has to become "NCAA First
 * Round" before a word-boundary pattern will see it. Hyphens inside school names go the
 * same way — "Gardner-Webb" reads as two words here, which costs nothing, since no
 * pattern in this module matches a school.
 */
function fixtureText(input: GameTypeInput): string {
    return [input.home_team_name, input.away_team_name, input.game_id, input.dedupe_key]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' ')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** `MM-DD` of an ISO date, or null if the value is not one. */
function monthDay(date: string | null | undefined): string | null {
    const match = /^\d{4}-(\d{2}-\d{2})$/.exec(date || '');
    return match ? match[1] : null;
}

export function classifyGameType(input: GameTypeInput): GameTypeResult {
    if (input.is_exhibition) return { type: 'exhibition', evidence: 'flag' };

    const text = fixtureText(input);
    if (!text) return { type: 'regular', evidence: 'default' };

    // Exhibition first: a school that plays a friendly inside a preseason bracket labels
    // it both ways, and the friendly is the fact that changes how the game should count.
    if (EXHIBITION_RE.test(text)) return { type: 'exhibition', evidence: 'marker' };

    if (!ROUND_RE.test(text)) return { type: 'regular', evidence: 'default' };

    const md = monthDay(input.date);
    // A round marker with no date behind it could be either bracket or neither. Saying
    // "regular" understates it, but it is the only claim the row supports.
    if (!md || md < POSTSEASON_EARLIEST) return { type: 'regular', evidence: 'default' };

    if (NCAA_RE.test(text)) return { type: 'ncaa_tournament', evidence: 'marker' };
    if (md >= NCAA_ROUND_ONE_EARLIEST) return { type: 'ncaa_tournament', evidence: 'date' };
    return { type: 'conference_tournament', evidence: 'date' };
}
