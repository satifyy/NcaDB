/**
 * Elo for college soccer.
 *
 * Elo is the right shape for this dataset because it needs nothing but results in order,
 * which is exactly what `games.csv` is — no possession, no xG, no lineups. Four things
 * about college soccer make plain chess Elo wrong for it, and each is a parameter fitted
 * against the record rather than a number picked because it looked sensible:
 *
 * - **Draws are a third outcome, not half a win.** They are scored 0.5 here, which is
 *   what keeps the ratings themselves unbiased, but turning a rating gap into a
 *   *probability* needs a draw band, and that lives in `outcome.ts`. It has to, because
 *   the draw rate nearly doubled in 2022 when the NCAA stopped playing overtime in the
 *   regular season: 12% of 2021's games were draws against 22% of every season since.
 *
 * - **Rosters turn over completely every few years.** A graduating class takes its rating
 *   with it, so ratings are pulled back toward the mean between seasons. How far is
 *   `carryover`, and it is much stronger than a professional league would want.
 *
 * - **Half the schedule is not Division I.** Schools open against nearby D2, D3 and NAIA
 *   programs, whose box scores are scraped like anyone's. Starting those at 1500 would
 *   hand out free rating points for beating a team that never had them, so unrated
 *   opponents start at `initialUnrated`, fitted from how those games actually go.
 *
 * - **Margins carry information but not linearly.** A 5-0 says more than a 1-0 and much
 *   less than five times as much, and running up a score against a weak team says least
 *   of all, so the margin multiplier is logarithmic and damped by the rating gap.
 *
 * The engine is deliberately free of I/O and of the outcome model: it consumes matches
 * and produces ratings, and everything that turns a rating into a forecast sits behind
 * `outcome.ts`. That separation is what lets the parameters be fitted by running the
 * whole history under a candidate set and scoring the result.
 */

import { Match } from './matches';

export interface EloParams {
    /** How far a game can move a rating, before the margin multiplier. */
    k: number;
    /** Home advantage, in rating points. Neutral-site games get none. */
    homeAdvantage: number;
    /** Share of a team's rating above the mean that survives into the next season. */
    carryover: number;
    /** Damping on the margin multiplier; larger means margins matter less. */
    marginDamping: number;
    /** Where a Division I team with no history starts. */
    initial: number;
    /** Where an opponent outside the rated inventory starts. */
    initialUnrated: number;
    /**
     * How hard a team's rating is pulled toward the mean when it loses last season's
     * production. 0 disables the adjustment entirely, which is the honest default until
     * the backtest says it earns its place.
     */
    returningWeight: number;
}

export const DEFAULT_ELO: EloParams = {
    k: 26,
    homeAdvantage: 55,
    carryover: 0.72,
    marginDamping: 2.2,
    initial: 1500,
    initialUnrated: 1330,
    returningWeight: 0
};

/** The rating everything regresses toward, and the scale ratings are quoted on. */
export const BASELINE = 1500;

export interface RatedGame extends Match {
    /** Ratings as they were before this game — what a forecast could have used. */
    home_elo_before: number;
    away_elo_before: number;
    home_elo_after: number;
    away_elo_after: number;
    /** Home rating minus away, with home advantage folded in. The model's only input. */
    elo_diff: number;
    /** Rating points this game moved the home team. Away moves by the negative. */
    elo_change: number;
}

/**
 * How much of a team's production came back this season.
 *
 * `1` is an intact squad, `0` a completely new one. Supplied per `season:team`, and only
 * for teams where the season before is in the dataset — a team with nothing behind it
 * gets no adjustment rather than an assumed one.
 */
export type ReturningProduction = Map<string, number>;

function key(season: string, team: string): string {
    return `${season}:${team}`;
}

export class EloEngine {
    private ratings = new Map<string, number>();
    private season: string | null = null;

    constructor(
        private params: EloParams,
        /** Teams that get {@link EloParams.initial}; everything else is an outside opponent. */
        private readonly rated: Set<string>,
        private readonly returning: ReturningProduction = new Map()
    ) {}

    rating(team: string): number {
        const existing = this.ratings.get(team);
        if (existing !== undefined) return existing;
        const start = this.rated.has(team) ? this.params.initial : this.params.initialUnrated;
        this.ratings.set(team, start);
        return start;
    }

    /** Every rating, highest first. */
    table(): { team: string; elo: number }[] {
        return [...this.ratings.entries()]
            .map(([team, elo]) => ({ team, elo }))
            .sort((a, b) => b.elo - a.elo);
    }

    snapshot(): Map<string, number> {
        return new Map(this.ratings);
    }

    /**
     * Regresses every rating toward the mean for a new season, and further for teams that
     * lost more of their production than most.
     *
     * The roster term is centred on the average returning share rather than on 1, so it
     * redistributes between teams instead of dragging the whole league down: a team that
     * returns everyone gains on a team that returns half, which is the claim being made.
     */
    private beginSeason(season: string): void {
        if (this.season === null) {
            this.season = season;
            return;
        }
        if (this.season === season) return;

        // Games are ordered by date, but a season file can hold dates that belong to the
        // next calendar year — most of the country played its 2020 season in spring 2021 —
        // so a row from an earlier season can arrive after a later one. Regressing on that
        // would charge a team two off-seasons for one summer.
        if (Number(season) < Number(this.season)) return;

        // Carryover is per year, not per file. A season excluded for thin coverage leaves
        // a gap — 2019 to 2021 with no 2020 between them — and regressing once across two
        // years of graduations would leave every rating two years stale.
        const gap = Math.max(1, Number(season) - Number(this.season));
        const carryover = this.params.carryover ** gap;

        const shares = [...this.ratings.keys()]
            .map(team => this.returning.get(key(season, team)))
            .filter((share): share is number => share !== undefined);
        const meanShare = shares.length > 0 ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;

        for (const [team, elo] of this.ratings) {
            let carried = BASELINE + carryover * (elo - BASELINE);
            const share = this.returning.get(key(season, team));
            if (share !== undefined && this.params.returningWeight !== 0 && shares.length > 0) {
                carried += this.params.returningWeight * (share - meanShare);
            }
            this.ratings.set(team, carried);
        }
        this.season = season;
    }

    /** Home rating minus away rating, with home advantage where the game has one. */
    diff(home: string, away: string, neutral: boolean): number {
        return this.rating(home) - this.rating(away) + (neutral ? 0 : this.params.homeAdvantage);
    }

    /**
     * Applies one played game and returns it with the ratings it was played at.
     *
     * The pre-game ratings are the point of the return value: they are what a forecast
     * made before kickoff would have had, so scoring the model against them is a
     * walk-forward test rather than a fit to games it has already seen.
     */
    apply(match: Match): RatedGame {
        this.beginSeason(match.season);

        const homeBefore = this.rating(match.home);
        const awayBefore = this.rating(match.away);
        const diff = homeBefore - awayBefore + (match.neutral ? 0 : this.params.homeAdvantage);
        const expected = 1 / (1 + 10 ** (-diff / 400));

        const homeGoals = match.home_score ?? 0;
        const awayGoals = match.away_score ?? 0;
        const actual = homeGoals > awayGoals ? 1 : homeGoals < awayGoals ? 0 : 0.5;

        // The margin multiplier is damped by the gap *from the winner's point of view*:
        // a favourite winning 4-0 is close to expected and should move less than an
        // underdog doing the same.
        const margin = Math.abs(homeGoals - awayGoals);
        const winnerEdge = actual === 1 ? diff : actual === 0 ? -diff : 0;
        const multiplier =
            margin === 0
                ? 1
                : Math.log(margin + 1) *
                  (this.params.marginDamping / (0.001 * winnerEdge + this.params.marginDamping));

        const change = this.params.k * multiplier * (actual - expected);
        this.ratings.set(match.home, homeBefore + change);
        this.ratings.set(match.away, awayBefore - change);

        return {
            ...match,
            home_elo_before: homeBefore,
            away_elo_before: awayBefore,
            home_elo_after: homeBefore + change,
            away_elo_after: awayBefore - change,
            elo_diff: diff,
            elo_change: change
        };
    }
}

/**
 * Runs the whole history through the engine, oldest game first.
 *
 * Only played games move a rating. Scheduled ones are skipped rather than dropped by the
 * caller, so the same list can be walked again to forecast them.
 */
export function rateHistory(
    matches: Match[],
    params: EloParams,
    rated: Set<string>,
    returning?: ReturningProduction
): { rated_games: RatedGame[]; engine: EloEngine } {
    const engine = new EloEngine(params, rated, returning);
    const out: RatedGame[] = [];
    for (const match of matches) {
        if (!match.played) continue;
        out.push(engine.apply(match));
    }
    return { rated_games: out, engine };
}
