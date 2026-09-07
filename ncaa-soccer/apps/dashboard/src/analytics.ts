/**
 * The rating, forecast and impact data, and the types the views read it through.
 *
 * Everything here is written by `generate_dashboard_analytics.ts`. The index is imported
 * eagerly because the navigation, the season control and the coverage notice are all
 * built from it; the per-season files are an order of magnitude larger and are fetched
 * only when a season is actually selected.
 */

import index from './data/analytics/index.json';

export interface CoverageSeason {
    season: string;
    rated_teams: number;
    teams_with_roster: number;
    teams_with_games: number;
    roster_share: number;
    missing_share: number;
    games: number;
    played_games: number;
    players: number;
    usable: boolean;
    /** Why the season was excluded, written for a reader rather than a log. */
    note: string | null;
}

export interface Scorecard {
    games: number;
    log_loss: number;
    brier: number;
    accuracy: number;
    baseline_log_loss: number;
}

export interface CalibrationPoint {
    bucket: number;
    predictions: number;
    predicted: number;
    observed: number;
}

export interface ModelSummary {
    elo: {
        k: number;
        homeAdvantage: number;
        carryover: number;
        marginDamping: number;
        initial: number;
        initialUnrated: number;
        returningWeight: number;
    };
    outcome: { beta: number; drawBand: { overtime: number; 'no-overtime': number } };
    goals: { base: number; slope: number; home: number };
    returning_production_weight: number;
    fitted_on: string[];
    held_out: string[];
    performance: { train: Scorecard; test: Scorecard; calibration: CalibrationPoint[] };
}

export interface WeekAccuracy {
    games: number;
    correct: number;
    accuracy: number;
    log_loss: number;
    /** What a forecast knowing only that season's outcome mix would have paid. */
    baseline_log_loss: number;
}

export interface AnalyticsIndex {
    generated_at: string;
    current_season: string;
    current_week: string | null;
    seasons: string[];
    coverage: CoverageSeason[];
    model: ModelSummary;
    prediction_record: {
        overall: WeekAccuracy;
        by_season: Record<string, WeekAccuracy | null>;
    };
}

export interface TeamRating {
    team: string;
    conference: string;
    elo: number;
    /** Rank among Division I only; 0 for opponents outside the inventory. */
    rank: number;
    conference_rank: number;
    played: number;
    wins: number;
    draws: number;
    losses: number;
    goals_for: number;
    goals_against: number;
    peak_elo: number;
    peak_season: string;
    by_season: Record<string, number>;
    /** Rating points gained or lost over the last four weeks. */
    trend: number;
    rated: boolean;
}

export interface PredictedGame {
    id: string;
    date: string;
    home: string;
    away: string;
    home_conference: string;
    away_conference: string;
    neutral: boolean;
    home_elo: number;
    away_elo: number;
    /** Home win, draw, away win. */
    p: [number, number, number];
    /** Expected goals, home then away. */
    xg: [number, number];
    scorelines: { score: string; p: number }[];
    confidence: number;
    pick: 'home' | 'draw' | 'away';
    home_score: number | null;
    away_score: number | null;
    outcome: 'home' | 'draw' | 'away' | null;
    correct: boolean | null;
    upset: boolean;
}

export interface PredictedWeek {
    week: string;
    status: 'played' | 'partial' | 'upcoming';
    accuracy: WeekAccuracy | null;
    games: PredictedGame[];
}

export interface SeasonPredictions {
    season: string;
    accuracy: WeekAccuracy | null;
    weeks: PredictedWeek[];
}

export interface ImpactPlayer {
    id: string;
    name: string;
    team: string;
    conference: string;
    jersey: string;
    games: number;
    minutes: number;
    goals: number;
    assists: number;
    shots: number;
    sog: number;
    saves: number;
    ga: number;
    keeper: boolean;
    /**
     * Games whose box score recorded saves — the only ones a keeper's rating could be
     * measured over. Around half of them, league-wide.
     */
    keeper_games: number;
    /** Opponent-adjusted goal equivalents over the season. */
    impact: number;
    /** The same, per 90 minutes, shrunk toward the league mean. */
    per90: number;
    /** Average Elo of the opponents faced. */
    opponents: number;
    /** 0–100 among the season's qualified players. */
    rating: number;
    qualified: boolean;
    /** Whether the player's school is in the Division I inventory. */
    d1: boolean;
}

export interface Standout {
    season: string;
    week: string;
    identity: string;
    player_name: string;
    team: string;
    conference: string;
    opponent: string | null;
    date: string;
    minutes: number;
    goals: number;
    assists: number;
    shots_on_goal: number;
    saves: number;
    goals_against: number;
    is_keeper: boolean;
    impact: number;
    result: 'W' | 'D' | 'L' | null;
    score: string | null;
}

export interface EloTimeline {
    teams: { team: string; points: [string, number][] }[];
}

export const ANALYTICS = index as AnalyticsIndex;

/**
 * The large files, resolved but not fetched.
 *
 * Each of these is around a megabyte per season, so they are behind `import.meta.glob`'s
 * lazy loaders and Vite splits them into their own chunks. A reader who only ever opens
 * the rankings never downloads a season of predictions.
 */
const predictionFiles = import.meta.glob<{ default: SeasonPredictions }>('./data/analytics/predictions/*.json');
const impactFiles = import.meta.glob<{ default: { season: string; players: ImpactPlayer[] } }>(
    './data/analytics/impact/*.json'
);
const ratingsFile = () => import('./data/analytics/ratings.json');
const timelineFile = () => import('./data/analytics/elo_timeline.json');
const standoutsFile = () => import('./data/analytics/standouts.json');

/** Resolves once per file and caches, so switching back to a view is instant. */
function cached<T>(load: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | null = null;
    return () => (pending ??= load());
}

export const loadRatings = cached(async (): Promise<TeamRating[]> => {
    const module = await ratingsFile();
    return (module.default as { teams: TeamRating[] }).teams;
});

export const loadTimeline = cached(async (): Promise<EloTimeline> => {
    const module = await timelineFile();
    // The JSON's tuples widen to `(string | number)[]` on import, which no assertion
    // narrows directly; the shape is guaranteed by the generator that wrote it.
    return module.default as unknown as EloTimeline;
});

export const loadStandouts = cached(async (): Promise<Standout[]> => {
    const module = await standoutsFile();
    return (module.default as { weeks: Standout[] }).weeks;
});

const perSeason = <T>(files: Record<string, () => Promise<{ default: T }>>, folder: string) => {
    const memo = new Map<string, Promise<T | null>>();
    return (season: string): Promise<T | null> => {
        const existing = memo.get(season);
        if (existing) return existing;
        const loader = files[`./data/analytics/${folder}/${season}.json`];
        const pending = loader ? loader().then(module => module.default) : Promise.resolve(null);
        memo.set(season, pending);
        return pending;
    };
};

export const loadPredictions = perSeason<SeasonPredictions>(predictionFiles, 'predictions');
const loadImpactFile = perSeason<{ season: string; players: ImpactPlayer[] }>(impactFiles, 'impact');

export async function loadImpact(season: string): Promise<ImpactPlayer[]> {
    const file = await loadImpactFile(season);
    return file?.players ?? [];
}

/** Seasons with predictions, newest first — how every season control is ordered. */
export const SEASONS_NEWEST_FIRST = [...ANALYTICS.seasons].sort((a, b) => b.localeCompare(a));
