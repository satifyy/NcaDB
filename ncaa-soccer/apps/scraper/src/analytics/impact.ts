/**
 * Player impact, from the only six numbers a college box score gives us.
 *
 * Minutes, goals, assists, shots, shots on goal, saves. There is no xG feed, no
 * possession, no lineup or substitution detail, so any honest impact metric here is a
 * valuation of those six events and nothing more. What it can do that a scoring
 * leaderboard cannot is three things:
 *
 * **Put everything in one unit.** Goals, chances and saves are all converted into goal
 * equivalents, so a goalkeeper and a forward are on the same axis and a team's whole
 * contribution adds up to one number that means something.
 *
 * **Adjust for who it came against.** Two goals against a 1900-rated opponent is not two
 * goals against an NAIA exhibition side, and roughly a third of this dataset's fixtures
 * are outside Division I. Production is scaled by the opponent's Elo at kickoff.
 *
 * **Adjust for how much was played.** A rate per 90 minutes rewards a substitute who
 * scored once in twenty minutes as the best player in the country, so rates are shrunk
 * toward the league mean by a prior worth about five games. A player has to keep it up to
 * keep the rating.
 *
 * The weights are stated, not fitted, with one exception: the value of a chance is the
 * season's own goals-per-shot-on-target, so a shot is credited with the goals a shot like
 * it actually produces that year. Because a goal is credited at 1.0 separately and
 * removed from the chance count, nothing is counted twice.
 *
 * What it deliberately does not claim: there is no defensive component for outfield
 * players, because nothing in a box score measures defending. A centre back's rating here
 * reflects their attacking contribution only, and the dashboard says so.
 */

import { BASELINE } from './elo';

/** A goal is the unit. An assist is worth this much of one. */
export const ASSIST_VALUE = 0.75;

/**
 * An off-target shot produced nothing, so it is credited at half the value of an average
 * attempt: shot volume repeats from season to season more reliably than accuracy does,
 * but a miss is still a miss.
 */
export const OFF_TARGET_DISCOUNT = 0.5;

/** How hard opponent quality scales production. Larger is gentler. */
const OPPONENT_SCALE = 1000;
const OPPONENT_MIN = 0.65;
const OPPONENT_MAX = 1.5;

/** Minutes of league-average play mixed into every player's rate. About five games. */
export const PRIOR_MINUTES = 450;

/** Minutes a player needs, in a completed season, before they appear on a leaderboard. */
export const QUALIFYING_MINUTES = 270;

/**
 * The share of a regular's workload that qualifies a player.
 *
 * A fixed 270 minutes is right for a finished season and wrong for a season four games
 * old, where nobody has played 270 minutes yet and every leaderboard comes back empty.
 * So the bar is a fraction of what the busiest tenth of players have actually played,
 * capped at the full-season figure: in August it is one game, in November it is three.
 */
const QUALIFYING_SHARE = 0.35;
const QUALIFYING_FLOOR = 90;

/** The minutes bar for this particular set of games. */
export function qualifyingMinutes(byPlayer: number[]): number {
    if (byPlayer.length === 0) return QUALIFYING_MINUTES;
    const sorted = [...byPlayer].sort((a, b) => b - a);
    const busiest = sorted[Math.floor(sorted.length / 10)];
    return Math.max(QUALIFYING_FLOOR, Math.min(QUALIFYING_MINUTES, Math.round(busiest * QUALIFYING_SHARE)));
}

/** Minutes a player needs in a single game to be eligible for a weekly award. */
export const WEEKLY_MINUTES = 20;

export interface PlayerGameRow {
    game_id: string;
    /** Canonical team. */
    team: string;
    player_name: string;
    /** `team::normalisedname`, stable within a season. */
    identity: string;
    jersey_number: string;
    minutes: number;
    goals: number;
    assists: number;
    shots: number;
    shots_on_goal: number;
    saves: number;
}

/** What the impact model needs to know about the game a row was recorded in. */
export interface GameContext {
    game_id: string;
    season: string;
    date: string;
    week: string;
    /** Canonical opponent of the row's team. */
    opponentOf: (team: string) => string | null;
    /** Elo of the opponent at kickoff. */
    opponentElo: (team: string) => number;
    /** Goals the row's team conceded. Null when the game has no final score. */
    concededBy: (team: string) => number | null;
    /** Goals the row's team scored. */
    scoredBy: (team: string) => number | null;
    /**
     * Whether this team's box score recorded any saves in this game.
     *
     * Half of them do not, and a keeper in one of those looks like a keeper who faced
     * nothing but the goals — every one of which then reads as a goal they should have
     * stopped. Where the column is missing the game contributes nothing to their rating
     * rather than a penalty for the box score's shortcomings.
     */
    savesRecorded: (team: string) => boolean;
}

export interface LeagueRates {
    /** Goals per shot on target — what one chance is worth. */
    chanceValue: number;
    /** Goals per shot of any kind, before the off-target discount. */
    shotValue: number;
    /** Share of shots on target that a keeper saves. */
    saveRate: number;
}

/**
 * Saves, and the goals conceded alongside them, from the games where saves were recorded.
 *
 * Half of the team-games in this dataset carry no saves at all — the box score simply does
 * not have the column, or has no keeper row. Dividing all the season's saves by all its
 * goals therefore does not give the league save rate; it gives a number dragged down by
 * every game where the saves went missing and the goals did not. In 2025 that is 0.54
 * against a true 0.71, which would have credited every keeper with roughly three times the
 * goals they actually prevented.
 */
export interface SaveSample {
    saves: number;
    /** Goals conceded in the same team-games, so the ratio is like for like. */
    conceded: number;
}

/** Fallback save rate for a season with no usable save data at all. */
const DEFAULT_SAVE_RATE = 0.7;

/** The season's own conversion rates, so a chance is valued at what chances produced. */
export function leagueRates(rows: PlayerGameRow[], saveSample: SaveSample): LeagueRates {
    let goals = 0;
    let shots = 0;
    let onTarget = 0;
    for (const row of rows) {
        goals += row.goals;
        shots += row.shots;
        onTarget += row.shots_on_goal;
    }
    const faced = saveSample.saves + saveSample.conceded;
    return {
        chanceValue: onTarget > 0 ? goals / onTarget : 0.3,
        shotValue: shots > 0 ? goals / shots : 0.1,
        saveRate: faced > 0 ? saveSample.saves / faced : DEFAULT_SAVE_RATE
    };
}

export function opponentFactor(opponentElo: number): number {
    const raw = 1 + (opponentElo - BASELINE) / OPPONENT_SCALE;
    return Math.min(OPPONENT_MAX, Math.max(OPPONENT_MIN, raw));
}

export interface GameImpact {
    identity: string;
    player_name: string;
    team: string;
    jersey_number: string;
    game_id: string;
    season: string;
    date: string;
    week: string;
    opponent: string | null;
    opponent_elo: number;
    minutes: number;
    goals: number;
    assists: number;
    shots: number;
    shots_on_goal: number;
    saves: number;
    /** Goals conceded while this player was in goal, if they are a keeper. */
    goals_against: number;
    /** Goal equivalents from attacking, before the opponent adjustment. */
    attacking: number;
    /** Goal equivalents from keeping: goals a league-average keeper would have conceded
     *  from the same shots, minus the goals this one actually did. */
    keeping: number;
    /** The opponent-adjusted total. This is the number everything else is built from. */
    impact: number;
    /** The team's result, for context on a weekly award. */
    result: 'W' | 'D' | 'L' | null;
    scored: number | null;
    conceded: number | null;
}

/**
 * Values one player's game.
 *
 * Keepers are identified across the whole season rather than by whether they made a save
 * in this one: a keeper who conceded three without a save has saves of zero, and judging
 * per game would let exactly the worst performances escape being counted.
 */
export function valueGame(
    row: PlayerGameRow,
    context: GameContext,
    rates: LeagueRates,
    isKeeper: boolean
): GameImpact {
    const nonScoringChances = Math.max(0, row.shots_on_goal - row.goals);
    const offTarget = Math.max(0, row.shots - row.shots_on_goal);
    const attacking =
        row.goals +
        ASSIST_VALUE * row.assists +
        rates.chanceValue * nonScoringChances +
        rates.shotValue * OFF_TARGET_DISCOUNT * offTarget;

    const conceded = context.concededBy(row.team);
    const scored = context.scoredBy(row.team);

    // Only where the box score has the column at all; see `savesRecorded`.
    const keeps = isKeeper && context.savesRecorded(row.team);

    // A share of the goals conceded proportional to time on the pitch, so two keepers
    // splitting a game split what went past them.
    const share = Math.min(1, row.minutes / 90);
    const goalsAgainst = keeps && conceded !== null ? conceded * share : 0;
    // Goals prevented: what a league-average keeper would have conceded from the same
    // shots, minus what this one did. Shots faced is saves plus goals conceded, which is
    // what "on target" means from the other end.
    const faced = row.saves + goalsAgainst;
    const keeping = keeps ? faced * (1 - rates.saveRate) - goalsAgainst : 0;

    const opponentElo = context.opponentElo(row.team);
    const impact = (attacking + keeping) * opponentFactor(opponentElo);

    return {
        identity: row.identity,
        player_name: row.player_name,
        team: row.team,
        jersey_number: row.jersey_number,
        game_id: context.game_id,
        season: context.season,
        date: context.date,
        week: context.week,
        opponent: context.opponentOf(row.team),
        opponent_elo: Math.round(opponentElo),
        minutes: row.minutes,
        goals: row.goals,
        assists: row.assists,
        shots: row.shots,
        shots_on_goal: row.shots_on_goal,
        saves: row.saves,
        goals_against: goalsAgainst,
        attacking,
        keeping,
        impact,
        result:
            scored === null || conceded === null ? null : scored > conceded ? 'W' : scored < conceded ? 'L' : 'D',
        scored,
        conceded
    };
}

export interface SeasonImpact {
    identity: string;
    player_name: string;
    team: string;
    conference: string;
    season: string;
    jersey_number: string;
    games: number;
    minutes: number;
    goals: number;
    assists: number;
    shots: number;
    shots_on_goal: number;
    saves: number;
    goals_against: number;
    is_keeper: boolean;
    /**
     * Games whose box score recorded saves, and so the only ones the keeping half of this
     * player's rating could be measured over. Around half of them, league-wide.
     */
    keeper_games: number;
    /** Total opponent-adjusted goal equivalents. */
    impact: number;
    /** Per 90 minutes, shrunk toward the league mean by {@link PRIOR_MINUTES}. */
    impact_per90: number;
    /** Average Elo of the opponents faced — what the schedule was worth. */
    opponent_strength: number;
    /** 0–100 within this season's qualified Division I players. */
    rating: number;
    /** Enough minutes to be ranked; the bar scales with the season, see below. */
    qualified: boolean;
    /**
     * Whether this player's school is in the Division I inventory.
     *
     * Roughly a third of the players in this dataset are not: schools open against nearby
     * D2, D3 and NAIA programs and those rosters get scraped like anyone's. They are kept
     * — dropping a third of the players would misstate every season total — but they are
     * not ranked against Division I by default, because a D2 forward's twenty goals
     * against D2 defences is not a Division I leaderboard entry.
     */
    division_one: boolean;
}

/**
 * Totals a season and turns it into a rating.
 *
 * The shrinkage is the part that matters. A raw per-90 leaderboard in this dataset is a
 * list of players who came off the bench once and scored, so every player's rate is mixed
 * with five games of league-average play before it is ranked. A regular's rate barely
 * moves; a cameo's collapses back toward the middle, which is all the evidence there is
 * for it.
 */
export function summariseSeason(
    games: GameImpact[],
    conferenceOf: (team: string) => string,
    isDivisionOne: (team: string) => boolean = () => true
): SeasonImpact[] {
    const byPlayer = new Map<string, GameImpact[]>();
    for (const game of games) {
        const list = byPlayer.get(game.identity);
        if (list) list.push(game);
        else byPlayer.set(game.identity, [game]);
    }

    let leagueImpact = 0;
    let leagueMinutes = 0;
    for (const game of games) {
        leagueImpact += game.impact;
        leagueMinutes += game.minutes;
    }
    const leagueRate = leagueMinutes > 0 ? (leagueImpact / leagueMinutes) * 90 : 0;

    const minutesByPlayer = [...byPlayer.values()].map(played =>
        played.reduce((total, game) => total + game.minutes, 0)
    );
    const bar = qualifyingMinutes(minutesByPlayer);

    const totals: SeasonImpact[] = [];
    for (const [identity, played] of byPlayer) {
        const last = played[played.length - 1];
        const sum = (pick: (g: GameImpact) => number) => played.reduce((total, g) => total + pick(g), 0);
        const minutes = sum(g => g.minutes);
        const impact = sum(g => g.impact);
        const saves = sum(g => g.saves);

        // Rate per 90 with a prior of league-average play, so short samples are pulled to
        // the middle rather than to the top.
        const per90 = ((impact + (leagueRate * PRIOR_MINUTES) / 90) / (minutes + PRIOR_MINUTES)) * 90;

        totals.push({
            identity,
            player_name: last.player_name,
            team: last.team,
            conference: conferenceOf(last.team),
            season: last.season,
            jersey_number: last.jersey_number,
            games: played.length,
            minutes,
            goals: sum(g => g.goals),
            assists: sum(g => g.assists),
            shots: sum(g => g.shots),
            shots_on_goal: sum(g => g.shots_on_goal),
            saves,
            goals_against: sum(g => g.goals_against),
            is_keeper: saves > 0,
            keeper_games: played.filter(g => g.saves > 0 || g.goals_against > 0).length,
            impact,
            impact_per90: per90,
            opponent_strength: played.length > 0 ? sum(g => g.opponent_elo) / played.length : BASELINE,
            rating: 0,
            qualified: minutes >= bar,
            division_one: isDivisionOne(last.team)
        });
    }

    // 0–100 by percentile among the qualified Division I players, so the scale means the
    // same thing every season even as the league's scoring rate drifts. Everyone else is
    // placed on that same curve and flagged, rather than hidden or given a fake number —
    // which is also what lets a D2 opponent's forward be compared *to* Division I without
    // being ranked *within* it.
    const ranked = totals
        .filter(t => t.qualified && t.division_one)
        .map(t => t.impact_per90)
        .sort((a, b) => a - b);
    const percentile = (value: number): number => {
        if (ranked.length === 0) return 50;
        let low = 0;
        let high = ranked.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (ranked[mid] < value) low = mid + 1;
            else high = mid;
        }
        return (low / ranked.length) * 100;
    };
    for (const total of totals) total.rating = Math.round(percentile(total.impact_per90) * 10) / 10;

    return totals.sort((a, b) => b.impact - a.impact);
}

/**
 * How much of last season's production each team got back.
 *
 * This is the one thing about a college team that Elo cannot see. A rating carries
 * forward from a squad that has since graduated half its output, and a team that returns
 * everyone and a team that returns nobody arrive at the new season on the same number.
 * Keyed `season:team`, where the season is the *new* one.
 *
 * It is computed from who actually appears in the new season's box scores, so it is not
 * available before a team has played. In a backtest that is fine; live, it means week one
 * is forecast on carryover alone and the roster term arrives with the first box score.
 */
export function returningProduction(bySeason: Map<string, SeasonImpact[]>): Map<string, number> {
    const seasons = [...bySeason.keys()].sort();
    const returning = new Map<string, number>();

    for (let i = 1; i < seasons.length; i++) {
        const season = seasons[i];
        const previous = seasons[i - 1];
        // Consecutive seasons only: production cannot be traced across a year the dataset
        // does not hold, or a gap would read as a squad that graduated together.
        if (Number(season) !== Number(previous) + 1) continue;

        const onRosterNow = new Set(bySeason.get(season)!.map(p => p.identity));
        const before = new Map<string, { total: number; kept: number }>();
        for (const player of bySeason.get(previous)!) {
            // Only positive contributions count toward what a squad "has": a player whose
            // impact was negative is not production the team is trying to replace.
            const value = Math.max(0, player.impact);
            const entry = before.get(player.team) || { total: 0, kept: 0 };
            entry.total += value;
            if (onRosterNow.has(player.identity)) entry.kept += value;
            before.set(player.team, entry);
        }

        for (const [team, entry] of before) {
            if (entry.total <= 0) continue;
            returning.set(`${season}:${team}`, entry.kept / entry.total);
        }
    }
    return returning;
}
