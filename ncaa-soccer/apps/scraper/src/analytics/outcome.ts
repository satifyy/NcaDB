/**
 * Turning a rating gap into a forecast.
 *
 * Elo produces a number; a prediction needs three probabilities and a scoreline, and the
 * step between them is where college soccer stops resembling the sports Elo is usually
 * written about.
 *
 * **The draw is not half a win.** A rating gap of zero does not mean "50/50" here, it
 * means roughly 39/22/39, and the size of that middle band is not a constant of the
 * sport — it is a rule. The NCAA stopped playing overtime in the regular season in 2022
 * and the draw rate went from 12% of games to 22% overnight. A single draw band fitted
 * across the whole dataset would be wrong for every season in it, so the band is fitted
 * per era while the slope on the rating gap is shared.
 *
 * **Scorelines come from a separate model.** Outcome probabilities are fitted directly
 * against outcomes, which is what makes them calibrated; goals are fitted as two Poisson
 * means against goals scored. Independent Poissons famously under-predict draws, so
 * rather than trusting them for the outcome the scoreline grid is re-weighted until its
 * home/draw/away masses agree with the fitted outcome model. Both models keep the job
 * they are good at.
 */

import { Match, Outcome, HOME_WIN, DRAW, AWAY_WIN, outcomeOf } from './matches';
import { minimise } from './optimize';

/** Seasons from here on have no regular-season overtime, and so far more draws. */
export const NO_OVERTIME_FROM = 2022;

export type Era = 'overtime' | 'no-overtime';

export function eraOf(season: string | number): Era {
    return Number(season) >= NO_OVERTIME_FROM ? 'no-overtime' : 'overtime';
}

export interface OutcomeParams {
    /** Log-odds of a win per rating point of edge. */
    beta: number;
    /** Half-width of the draw band, per era, in log-odds. */
    drawBand: Record<Era, number>;
}

export interface GoalsParams {
    /** Log of the baseline goals a side scores in an even neutral game. */
    base: number;
    /** How a rating edge converts into goals, in log space. */
    slope: number;
    /** Home scoring bonus, in log space. Not applied at a neutral site. */
    home: number;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Home win, draw, away win — in that order, summing to one. */
export type Probabilities = [number, number, number];

export function probabilities(eloDiff: number, era: Era, params: OutcomeParams): Probabilities {
    const latent = params.beta * eloDiff;
    const band = params.drawBand[era];
    const home = sigmoid(latent - band);
    const away = sigmoid(-latent - band);
    // The band is fitted positive, so the two tails cannot cover the whole mass; the
    // clamp is a guard against a caller supplying a degenerate band, not an expected path.
    const draw = Math.max(1e-6, 1 - home - away);
    const total = home + draw + away;
    return [home / total, draw / total, away / total];
}

export function expectedGoals(
    ratingDiff: number,
    neutral: boolean,
    params: GoalsParams
): { home: number; away: number } {
    const edge = params.slope * (ratingDiff / 400);
    const homeBonus = neutral ? 0 : params.home;
    return {
        home: Math.exp(params.base + homeBonus + edge),
        away: Math.exp(params.base - edge)
    };
}

/** One game as the fitters see it: what was known before, and what happened. */
export interface Observation {
    /** Rating gap including home advantage — the outcome model's input. */
    elo_diff: number;
    /** Rating gap without home advantage — the goals model's input. */
    rating_diff: number;
    neutral: boolean;
    era: Era;
    outcome: Outcome;
    home_goals: number;
    away_goals: number;
}

export function observationOf(match: Match, eloDiff: number, ratingDiff: number): Observation | null {
    const outcome = outcomeOf(match);
    if (outcome === null) return null;
    return {
        elo_diff: eloDiff,
        rating_diff: ratingDiff,
        neutral: match.neutral,
        era: eraOf(match.season),
        outcome,
        home_goals: match.home_score!,
        away_goals: match.away_score!
    };
}

/** Mean negative log likelihood of the observed outcomes. Lower is better. */
export function logLoss(observations: Observation[], params: OutcomeParams): number {
    if (observations.length === 0) return Infinity;
    let total = 0;
    for (const o of observations) {
        const p = probabilities(o.elo_diff, o.era, params);
        total -= Math.log(Math.max(p[o.outcome], 1e-12));
    }
    return total / observations.length;
}

/** Multiclass Brier score: mean squared error across the three probabilities. */
export function brier(observations: Observation[], params: OutcomeParams): number {
    if (observations.length === 0) return Infinity;
    let total = 0;
    for (const o of observations) {
        const p = probabilities(o.elo_diff, o.era, params);
        for (let i = 0; i < 3; i++) total += (p[i] - (i === o.outcome ? 1 : 0)) ** 2;
    }
    return total / observations.length;
}

const ERAS: Era[] = ['overtime', 'no-overtime'];

/**
 * Fits the slope and both draw bands by minimising log loss.
 *
 * The bands are exponentiated inside the loss so the search cannot wander into a negative
 * one, which would mean a negative draw probability rather than a bad fit.
 */
export function fitOutcome(observations: Observation[]): OutcomeParams {
    const unpack = (v: number[]): OutcomeParams => ({
        beta: v[0],
        drawBand: { overtime: Math.exp(v[1]), 'no-overtime': Math.exp(v[2]) }
    });
    const fit = minimise(
        v => logLoss(observations, unpack(v)),
        [0.004, Math.log(0.25), Math.log(0.45)],
        [0.002, 0.3, 0.3]
    );
    return unpack(fit.params);
}

/** Fits both Poisson means against goals scored. */
export function fitGoals(observations: Observation[]): GoalsParams {
    const unpack = (v: number[]): GoalsParams => ({ base: v[0], slope: v[1], home: v[2] });
    const loss = (v: number[]): number => {
        const params = unpack(v);
        let total = 0;
        for (const o of observations) {
            const mu = expectedGoals(o.rating_diff, o.neutral, params);
            // Poisson deviance without the constant term, which the fit does not need.
            total += mu.home - o.home_goals * Math.log(Math.max(mu.home, 1e-9));
            total += mu.away - o.away_goals * Math.log(Math.max(mu.away, 1e-9));
        }
        return total / Math.max(observations.length, 1);
    };
    const fit = minimise(loss, [Math.log(1.3), 0.5, 0.15], [0.2, 0.2, 0.1]);
    return unpack(fit.params);
}

const poisson = (k: number, mu: number) => {
    let logP = -mu + k * Math.log(Math.max(mu, 1e-9));
    for (let i = 2; i <= k; i++) logP -= Math.log(i);
    return Math.exp(logP);
};

export interface Scoreline {
    home: number;
    away: number;
    probability: number;
}

/** Goals per side to enumerate. Six covers essentially every college soccer scoreline. */
const MAX_GOALS = 6;

/**
 * The most likely scorelines, consistent with the outcome probabilities.
 *
 * Two independent Poissons give a plausible shape but the wrong draw mass, so each of the
 * three regions of the grid is scaled to the probability the outcome model gives it. The
 * shape within a region is the Poissons' and the mass across regions is the outcome
 * model's, which is the half each is actually fitted for.
 */
export function scorelines(
    mu: { home: number; away: number },
    outcome: Probabilities,
    top = 5
): Scoreline[] {
    const grid: Scoreline[] = [];
    const regionMass = [0, 0, 0];
    for (let h = 0; h <= MAX_GOALS; h++) {
        for (let a = 0; a <= MAX_GOALS; a++) {
            const probability = poisson(h, mu.home) * poisson(a, mu.away);
            const region = h > a ? HOME_WIN : h < a ? AWAY_WIN : DRAW;
            regionMass[region] += probability;
            grid.push({ home: h, away: a, probability });
        }
    }
    for (const cell of grid) {
        const region = cell.home > cell.away ? HOME_WIN : cell.home < cell.away ? AWAY_WIN : DRAW;
        cell.probability *= regionMass[region] > 0 ? outcome[region] / regionMass[region] : 0;
    }
    return grid.sort((a, b) => b.probability - a.probability).slice(0, top);
}

export interface Calibration {
    /** Midpoint of the predicted-probability bucket. */
    bucket: number;
    predictions: number;
    predicted: number;
    observed: number;
}

/**
 * How often each predicted probability actually happened.
 *
 * Log loss says a model is good; this says where it is wrong. A model that calls 70%
 * favourites and sees them win 55% of the time is overconfident in a way no single
 * number makes visible, and that is precisely what a reader of a prediction page wants
 * to be able to check.
 */
export function calibration(observations: Observation[], params: OutcomeParams, bins = 10): Calibration[] {
    const buckets = Array.from({ length: bins }, () => ({ n: 0, predicted: 0, observed: 0 }));
    for (const o of observations) {
        const p = probabilities(o.elo_diff, o.era, params);
        for (let i = 0; i < 3; i++) {
            const bucket = Math.min(bins - 1, Math.floor(p[i] * bins));
            buckets[bucket].n++;
            buckets[bucket].predicted += p[i];
            buckets[bucket].observed += i === o.outcome ? 1 : 0;
        }
    }
    return buckets
        .map((b, i) => ({
            bucket: (i + 0.5) / bins,
            predictions: b.n,
            predicted: b.n > 0 ? b.predicted / b.n : 0,
            observed: b.n > 0 ? b.observed / b.n : 0
        }))
        .filter(b => b.predictions > 0);
}

/** How the model scores against games it did not see when it was fitted. */
export interface Scorecard {
    games: number;
    log_loss: number;
    brier: number;
    accuracy: number;
    /** Log loss of always predicting the base rate — the bar a model has to clear. */
    baseline_log_loss: number;
}

export function scorecard(observations: Observation[], params: OutcomeParams): Scorecard {
    const counts = [0, 0, 0];
    for (const o of observations) counts[o.outcome]++;
    const n = Math.max(observations.length, 1);
    const base: Probabilities = [counts[0] / n, counts[1] / n, counts[2] / n];

    let hits = 0;
    let baseLoss = 0;
    for (const o of observations) {
        const p = probabilities(o.elo_diff, o.era, params);
        const best = p.indexOf(Math.max(...p));
        if (best === o.outcome) hits++;
        baseLoss -= Math.log(Math.max(base[o.outcome], 1e-12));
    }

    return {
        games: observations.length,
        log_loss: logLoss(observations, params),
        brier: brier(observations, params),
        accuracy: hits / n,
        baseline_log_loss: baseLoss / n
    };
}

export { HOME_WIN, DRAW, AWAY_WIN };
