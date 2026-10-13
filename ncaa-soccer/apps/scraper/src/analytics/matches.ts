/**
 * Every fixture in the dataset, in one chronological list with one name per school.
 *
 * `games.csv` is written per season and per school, so reading it for a rating system
 * needs three things doing to it that no single season's file does for itself: teams
 * resolved onto canonical names (an Elo rating filed under "Colgate University" is a
 * team missing from the table filed under "Colgate"), rows ordered by date across season
 * boundaries, and played games separated from scheduled ones — a rating may only ever be
 * updated by a result, while a prediction is only ever wanted for a fixture without one.
 */

import { GameType, classifyGameType, cleanTeamName, isGameType } from '@ncaa/parsers';
import { GameCsvRow, gamesCsv, readAllIfExists, score } from '@ncaa/storage';

export interface Match {
    game_id: string;
    season: string;
    /** ISO date, `YYYY-MM-DD`. */
    date: string;
    /** Monday of the week this was played in — the unit predictions are grouped by. */
    week: string;
    home: string;
    away: string;
    /** Null until the game is played. */
    home_score: number | null;
    away_score: number | null;
    neutral: boolean;
    status: string;
    /** A result exists and both scores parsed. */
    played: boolean;
    /**
     * What kind of fixture this is, from the `game_type` column.
     *
     * `regular` is the absence of a marker rather than a positive finding — most bracket
     * games say nothing about their round, so it covers real postseason fixtures too.
     */
    game_type: GameType;
    /**
     * A friendly rather than a fixture, by the marker the school hung on the opponent
     * ("Western Iowa Tech (Exhib.)").
     *
     * Kept in the ratings — beating anyone is evidence — but excluded from anything that
     * reasons about a school's calendar, because an exhibition is exactly what a team
     * plays *in addition* to a real game on a given day.
     */
    exhibition: boolean;
}

/**
 * The Monday of the week a date falls in.
 *
 * College soccer is a Friday/Sunday sport with midweek fill-ins, so a Monday-start week
 * keeps a weekend's two fixtures in the same bucket. A Sunday start would split them and
 * make every team's "week" a single game.
 */
export function weekOf(isoDate: string): string {
    const date = new Date(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return isoDate;
    const shift = (date.getUTCDay() + 6) % 7; // Monday = 0
    date.setUTCDate(date.getUTCDate() - shift);
    return date.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A fixture with no result, dated before the season starts, is a date that failed to
 * parse rather than a game.
 *
 * College soccer is played from August to December. Where a schedule row carries no date,
 * some Sidearm sites emit January 1 of the season year, and one school's whole schedule
 * lands on that day — Loyola Chicago's eight opponents and Iona's twelve, all on
 * 2026-01-01. Kept, they become the first "week" of the season and a prediction page opens
 * on a week that does not exist.
 *
 * Only unplayed rows are dropped. Spring dates with a final score are real: the 2020
 * season was played in spring 2021 for most of the country, and those results belong to
 * the season they are filed under.
 */
const SEASON_STARTS = '-08-01';

/**
 * Strings that appear where an opponent should and are not schools.
 *
 * Tournament schedules publish the *other* game in the bracket as a placeholder — a row
 * whose opponent is "Elon vs. UNC Asheville" is waiting to find out who it plays — and
 * some sites list "Alumni Game", "MAC Tournament Semifinals" or a bare "TBD". Each one
 * becomes a team with a rating and a schedule if it is let through.
 *
 * Safe against real schools because none of them carry these words in their names, and
 * because a genuine opponent that arrived decorated with its round ("Boston College - ACC
 * Semifinals") has the decoration stripped by `cleanTeamName` before it reaches here,
 * leaving only the school to test.
 */
const NOT_A_TEAM = new RegExp(
    [
        String.raw`\svs\.?\s`,
        String.raw`^\s*(?:tba|tbd|alumni|bye|open)\b`,
        // Words no school has in its name, and every bracket placeholder does.
        String.raw`\b(?:tournament|championship|bracket|playoffs?|scrimmage|intrasquad)\b`,
        // The round on its own, which is what a site publishes before the draw is made:
        // "First Round", "CAA Quarterfinals", "American Conference".
        String.raw`\b(?:quarter-?finals?|semi-?finals?|finals?|conference|league|division|ncaa)\b`,
        String.raw`\b(?:first|second|third|fourth|opening|play-?in|elite|sweet)\s+(?:round|eight|sixteen)\b`,
        String.raw`^\s*round\s*\d*\s*$`
    ].join('|'),
    'i'
);

/**
 * Loads the seasons given, resolved and sorted oldest first.
 *
 * Rows without a usable date are dropped rather than sorted to the front: a game with no
 * date cannot be placed in the sequence a rating depends on, and guessing its position
 * would let it update ratings in the wrong order.
 */
export function loadMatches(
    seasons: string[],
    resolveTeam: (raw: string) => string,
    /**
     * The Division I inventory. Supplied, the schedule itself is used to resolve
     * spellings the inventory does not hold; omitted, that step is skipped.
     */
    rated?: Set<string>
): Match[] {
    const matches: Match[] = [];

    for (const season of seasons) {
        for (const row of readAllIfExists<GameCsvRow>(gamesCsv(season))) {
            if (!ISO_DATE.test(row.date)) continue;
            const unplayed = row.status !== 'final' || row.home_score === '' || row.away_score === '';
            if (unplayed && row.date < `${season}${SEASON_STARTS}`) continue;
            // Tested against the cleaned name, not the raw one: "Charlotte/Alumni Weekend"
            // is a real Charlotte fixture once the weekend is stripped off it, while
            // "Intrasquad Scrimmage" is nothing whichever way it is read.
            const cleanHome = cleanTeamName(row.home_team_name);
            const cleanAway = cleanTeamName(row.away_team_name);
            if (NOT_A_TEAM.test(cleanHome.name) || NOT_A_TEAM.test(cleanAway.name)) continue;
            // The stored column is read in preference to the names, because the names are
            // where this used to be read *from* and they no longer carry the marker: the
            // pipeline strips "(Exhibition)" on the way in, leaving it only on the ids.
            // Rows from a season not yet backfilled fall through to deriving it here.
            const game_type: GameType = isGameType(row.game_type)
                ? row.game_type
                : classifyGameType(row).type;
            const exhibition = game_type === 'exhibition' || cleanHome.exhibition || cleanAway.exhibition;
            const home = resolveTeam(row.home_team_name);
            const away = resolveTeam(row.away_team_name);
            // A school cannot play itself. Where both sides resolve to one name the row is
            // a merge artefact, not a fixture, and rating it would hand a team free points.
            if (!home || !away || home === away) continue;

            const homeScore = score(row.home_score);
            const awayScore = score(row.away_score);
            const played =
                row.status === 'final' &&
                homeScore !== null &&
                awayScore !== null &&
                Number.isFinite(homeScore) &&
                Number.isFinite(awayScore);

            matches.push({
                game_id: row.game_id,
                season,
                date: row.date,
                week: weekOf(row.date),
                home,
                away,
                home_score: played ? homeScore : null,
                away_score: played ? awayScore : null,
                neutral: row.location_type === 'neutral',
                status: row.status,
                played,
                game_type,
                exhibition
            });
        }
    }

    // Date first, then id, so a re-run processes the same games in the same order and two
    // runs of the same data produce identical ratings.
    matches.sort((a, b) => a.date.localeCompare(b.date) || a.game_id.localeCompare(b.game_id));

    if (rated) {
        const aliases = learnAliases(matches, rated);
        if (aliases.size > 0) {
            for (const match of matches) {
                match.home = aliases.get(match.home) ?? match.home;
                match.away = aliases.get(match.away) ?? match.away;
            }
        }
    }
    return dedupeFixtures(matches.filter(match => match.home !== match.away));
}

/** Two fixtures on one date that share a team, and the team each of them does not share. */
function sharedTeamPairs(matches: Match[]): { shared: string; a: Match; b: Match; oa: string; ob: string }[] {
    const byDate = new Map<string, Match[]>();
    for (const match of matches) {
        const list = byDate.get(match.date) ?? [];
        list.push(match);
        byDate.set(match.date, list);
    }

    const pairs: { shared: string; a: Match; b: Match; oa: string; ob: string }[] = [];
    for (const list of byDate.values()) {
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i];
                const b = list[j];
                const left = [a.home, a.away];
                const right = [b.home, b.away];
                const shared = left.filter(team => right.includes(team));
                if (shared.length !== 1) continue;
                pairs.push({
                    shared: shared[0],
                    a,
                    b,
                    oa: left.find(team => team !== shared[0])!,
                    ob: right.find(team => team !== shared[0])!
                });
            }
        }
    }
    return pairs;
}

/** Whether two rows could be the same fixture: unplayed together, or the same result. */
function consistent(shared: string, a: Match, b: Match): boolean {
    if (!a.played && !b.played) return true;
    if (a.played !== b.played) return false;
    const from = (match: Match) =>
        match.home === shared
            ? [match.home_score, match.away_score]
            : [match.away_score, match.home_score];
    const [scoredA, concededA] = from(a);
    const [scoredB, concededB] = from(b);
    return scoredA === scoredB && concededA === concededB;
}

/**
 * Spellings the schedule itself identifies, which the inventory does not hold.
 *
 * A school's own site and its opponent's disagree about what to call it — SMU's schedule
 * says "HCU" where Houston Christian's says "Houston Christian", and a hundred fixtures
 * are filed under "Massachusetts" against UMass's own "UMass". Neither spelling is
 * resolvable by name: no string rule turns "HCU" into "Houston Christian" without also
 * turning something else into the wrong school, and roster overlap cannot help because
 * these names appear only as opponents in `games.csv`, never as a box score with players
 * in it.
 *
 * The schedule can, because **a team plays one game a day**. If one row has SMU playing
 * "HCU" and another has SMU playing "Houston Christian" on the same date, with the same
 * result, they are one fixture — so those two names are one school.
 *
 * The rule only ever names an *unknown* spelling after a *known* one, and only when the
 * known candidate is unanimous. Two known schools disagreeing is not an alias, it is a
 * genuine conflict — "Boston College" against "Boston University" on Lehigh's schedule is
 * a name that was resolved wrongly at scrape time, and quietly merging the two would pick
 * a winner rather than admit the problem.
 */
/**
 * How much of a spelling's season the school it is supposed to be also played.
 *
 * Sharing one date is not enough on its own, and assuming it was is how "Colgate" became
 * Drake and "Coker" became Queens: those are real schools that merely played on the same
 * day as the team they were mistaken for. A spelling that is genuinely another name for a
 * school shadows that school's whole season, because every fixture it appears in *is* one
 * of that school's fixtures. So the alias has to account for most of the spelling's
 * calendar, not one day of it.
 */
const MIN_SCHEDULE_SUPPORT = 0.6;

export function learnAliases(matches: Match[], rated: Set<string>): Map<string, string> {
    // Exhibitions are the one thing a team really does play alongside a real fixture on
    // the same day, which is the whole basis of this inference. St. Thomas's friendly
    // against Western Iowa Tech sat on the same date as its game with Houston Christian,
    // and taking the pair at face value made the two opponents one school.
    const scheduled = matches.filter(match => !match.exhibition);

    const votes = new Map<string, Set<string>>();
    for (const { shared, a, b, oa, ob } of sharedTeamPairs(scheduled)) {
        if (oa === ob) continue;
        const knownA = rated.has(oa);
        const knownB = rated.has(ob);
        if (knownA === knownB) continue;
        if (!consistent(shared, a, b)) continue;
        const [unknown, known] = knownA ? [ob, oa] : [oa, ob];
        const candidates = votes.get(unknown) ?? new Set<string>();
        candidates.add(known);
        votes.set(unknown, candidates);
    }

    // Who each name played, by date, to test a candidate against the whole season rather
    // than the one fixture that suggested it.
    const schedule = new Map<string, Map<string, Set<string>>>();
    for (const match of scheduled) {
        for (const [team, opponent] of [
            [match.home, match.away],
            [match.away, match.home]
        ]) {
            const dates = schedule.get(team) ?? new Map<string, Set<string>>();
            const opponents = dates.get(match.date) ?? new Set<string>();
            opponents.add(opponent);
            dates.set(match.date, opponents);
            schedule.set(team, dates);
        }
    }

    const aliases = new Map<string, string>();
    for (const [unknown, candidates] of votes) {
        // Several candidates means the spelling is used by more than one school, which is
        // the case the whole rule exists to avoid guessing at.
        if (candidates.size !== 1) continue;
        const known = [...candidates][0];

        const theirs = schedule.get(unknown);
        const ours = schedule.get(known);
        if (!theirs || !ours) continue;

        // Two schools, not two names: a spelling that ever plays the school it is
        // supposed to be is a different school from it.
        if ([...theirs.values()].some(opponents => opponents.has(known))) continue;

        let corroborated = 0;
        let contradicted = 0;
        for (const [date, opponents] of theirs) {
            const sameDay = ours.get(date);
            if (!sameDay) continue;
            // On a shared date the two names should be in the same fixture, facing the
            // same opponent. Facing different ones means two games, so two schools.
            if ([...opponents].some(opponent => sameDay.has(opponent))) corroborated++;
            else contradicted++;
        }
        if (contradicted > 0) continue;
        if (corroborated / theirs.size < MIN_SCHEDULE_SUPPORT) continue;

        aliases.set(unknown, known);
    }
    return aliases;
}

/**
 * Fixtures where two Division I schools are both claimed as the same opponent.
 *
 * Not repairable from here: both names are real schools, so there is no unknown side to
 * name after the known one. Reported so the count is visible rather than silently rated
 * twice. The cause is a short form resolved at scrape time — "Boston" fits both Boston
 * College and Boston University — which the parser now refuses, so these clear on the
 * next scrape of the affected seasons.
 */
export function conflictingFixtures(matches: Match[], rated: Set<string>): { date: string; shared: string; a: string; b: string }[] {
    const seen = new Set<string>();
    const out: { date: string; shared: string; a: string; b: string }[] = [];
    for (const { shared, a, b, oa, ob } of sharedTeamPairs(matches)) {
        if (oa === ob || !rated.has(oa) || !rated.has(ob)) continue;
        if (!consistent(shared, a, b)) continue;
        const key = `${a.date}|${shared}|${[oa, ob].sort().join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ date: a.date, shared, a: oa, b: ob });
    }
    return out;
}

/**
 * One row per fixture, after the team names have been resolved.
 *
 * The storage layer already merges the two schools' versions of a game on a key built
 * from the names as they were scraped, which catches most of it. What survives is the
 * pair that was spelled differently by each side: Cal Baptist's site filed
 * "Cal Baptist vs Denver" and Denver's filed "California Baptist vs University of
 * Denver", so the two rows carry different keys and both reach here. Once both resolve
 * to the same two schools they are plainly one fixture — and left alone they would show
 * up twice on a prediction page and, worse, move both teams' ratings twice for one
 * result.
 *
 * The row with a result wins, since a scheduled duplicate of a played game carries
 * nothing the played one does not.
 */
export function dedupeFixtures(matches: Match[]): Match[] {
    const byFixture = new Map<string, Match>();
    for (const match of matches) {
        const key = `${match.date}|${[match.home, match.away].sort().join('|')}`;
        const existing = byFixture.get(key);
        if (!existing || (!existing.played && match.played)) byFixture.set(key, match);
    }
    return mergeNearDates(
        [...byFixture.values()].sort(
            (a, b) => a.date.localeCompare(b.date) || a.game_id.localeCompare(b.game_id)
        )
    );
}

/** Days apart two dates are, as a number rather than a comparison. */
function daysBetween(a: string, b: string): number {
    return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * The two schools also have to agree on *when* they played, and sometimes they do not.
 *
 * Conference tournaments are where it shows: one school files the semi-final on the
 * Friday and its opponent on the Saturday, so the same 2-0 appears twice, two days apart,
 * and both move the ratings. Forty-one results in this dataset are double-counted that
 * way.
 *
 * Only merged when the two rows agree on everything except the date — the same pair, the
 * same result, within a few days. Two schools genuinely meeting twice inside a week do
 * not also produce the same scoreline both times, and if they somehow did, one of the two
 * is a smaller error than the double-count.
 */
const SAME_FIXTURE_DAYS = 3;

function mergeNearDates(matches: Match[]): Match[] {
    const byPair = new Map<string, Match[]>();
    for (const match of matches) {
        const key = `${match.season}|${[match.home, match.away].sort().join('|')}`;
        const list = byPair.get(key) ?? [];
        list.push(match);
        byPair.set(key, list);
    }

    const dropped = new Set<string>();
    for (const list of byPair.values()) {
        if (list.length < 2) continue;
        const ordered = [...list].sort((a, b) => a.date.localeCompare(b.date));
        for (let i = 1; i < ordered.length; i++) {
            const earlier = ordered[i - 1];
            const later = ordered[i];
            if (dropped.has(earlier.game_id)) continue;
            if (daysBetween(earlier.date, later.date) > SAME_FIXTURE_DAYS) continue;
            if (!consistent(earlier.home, earlier, later)) continue;
            // The earlier date is kept, so which row survives does not depend on the
            // order the season files happened to be read in.
            dropped.add(later.game_id);
        }
    }

    return dropped.size === 0 ? matches : matches.filter(match => !dropped.has(match.game_id));
}

/** Home win / draw / away win, as the index the outcome model uses. */
export type Outcome = 0 | 1 | 2;
export const HOME_WIN: Outcome = 0;
export const DRAW: Outcome = 1;
export const AWAY_WIN: Outcome = 2;

export function outcomeOf(match: Match): Outcome | null {
    if (!match.played) return null;
    if (match.home_score! > match.away_score!) return HOME_WIN;
    if (match.home_score! < match.away_score!) return AWAY_WIN;
    return DRAW;
}
