/**
 * Whether a season is complete enough to be counted.
 *
 * A backfill does not fail loudly. A season where half the schools' sites no longer serve
 * that year produces a `games.csv` and a `player_stats.csv` like any other, just smaller,
 * and every total computed from it is quietly wrong — a scoring leaderboard built on the
 * two thirds of teams that happened to answer is not a leaderboard, and an Elo table
 * where a third of the league never played is not a table.
 *
 * So each season is measured against the inventory before it is used, and one that falls
 * short is flagged and excluded rather than silently averaged in. The threshold is a
 * fifth: a season missing more than 20% of Division I is not a season this dataset can
 * make claims about.
 *
 * 2020 is the case this exists for. Most of Division I moved its 2020 season to spring
 * 2021 or did not play it, so the year is real, partial, and not comparable with any
 * other — exactly the thing that has to be labelled rather than averaged.
 */

import { Match } from './matches';

/** A team must field this many distinct players before it counts as having a roster. */
export const ROSTER_MINIMUM = 11;

/** How much of Division I may be missing before the season is not usable. */
export const MAX_MISSING_SHARE = 0.2;

export interface SeasonCoverage {
    season: string;
    /** Division I programs in the inventory — the denominator. */
    rated_teams: number;
    /** Of those, how many have a roster in this season's box scores. */
    teams_with_roster: number;
    /** Of those, how many played at least one game with a final score. */
    teams_with_games: number;
    roster_share: number;
    missing_share: number;
    games: number;
    played_games: number;
    players: number;
    /** False when too much of the league is missing to count the season. */
    usable: boolean;
    /** Why it was excluded, for the reader of the dashboard rather than the log. */
    note: string | null;
}

export interface CoverageInput {
    season: string;
    /** Canonical team name -> distinct players in that season's box scores. */
    rosterSizes: Map<string, number>;
    matches: Match[];
    players: number;
}

export function assessSeason(input: CoverageInput, rated: Set<string>): SeasonCoverage {
    const withRoster = [...input.rosterSizes.entries()].filter(
        ([team, size]) => rated.has(team) && size >= ROSTER_MINIMUM
    ).length;

    const playing = new Set<string>();
    let played = 0;
    for (const match of input.matches) {
        if (!match.played) continue;
        played++;
        if (rated.has(match.home)) playing.add(match.home);
        if (rated.has(match.away)) playing.add(match.away);
    }

    const denominator = Math.max(rated.size, 1);
    const rosterShare = withRoster / denominator;
    const missingShare = 1 - rosterShare;
    const usable = missingShare <= MAX_MISSING_SHARE;

    return {
        season: input.season,
        rated_teams: rated.size,
        teams_with_roster: withRoster,
        teams_with_games: playing.size,
        roster_share: rosterShare,
        missing_share: missingShare,
        games: input.matches.length,
        played_games: played,
        players: input.players,
        usable,
        note: usable
            ? null
            : `${Math.round(missingShare * 100)}% of Division I has no roster in this season, ` +
              `over the ${Math.round(MAX_MISSING_SHARE * 100)}% limit. Excluded from ratings and totals.`
    };
}
