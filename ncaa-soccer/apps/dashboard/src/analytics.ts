/**
 * The rating, forecast and impact data, and the types the views read it through.
 *
 * Everything here is written by `generate_dashboard_analytics.ts`, which the ingestion
 * worker runs nightly against the database and stores for the API to serve. The index
 * is fetched once at startup because the navigation, the season control and the
 * coverage notice are all built from it; the per-season files are an order of
 * magnitude larger and are fetched only when a season is actually selected.
 */

import { artifact, ApiRequestError } from './api';
import type { Manifest } from './types';

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

/**
 * The analytics index and the season-stats manifest, set once by {@link bootstrapData}
 * before any view renders. Live bindings: every importer sees the loaded values.
 */
export let ANALYTICS: AnalyticsIndex = undefined as unknown as AnalyticsIndex;
export let MANIFEST: Manifest = undefined as unknown as Manifest;
/** Seasons with predictions, newest first — how every season control is ordered. */
export let SEASONS_NEWEST_FIRST: string[] = [];

/**
 * Loads the two small index files the analytics views are built from.
 *
 * Resolves false rather than throwing when they are not there yet — a fresh deployment
 * before its first analytics run — so the database-backed views still work.
 */
export async function bootstrapData(): Promise<boolean> {
    try {
        const [index, manifest] = await Promise.all([
            artifact<AnalyticsIndex>('analytics/index.json'),
            artifact<Manifest>('manifest.json')
        ]);
        ANALYTICS = index;
        MANIFEST = manifest;
        SEASONS_NEWEST_FIRST = [...index.seasons].sort((a, b) => b.localeCompare(a));
        return true;
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return false;
        throw err;
    }
}

/**
 * The large files, fetched only when a view asks for them. Each is around a megabyte per
 * season; a reader who only ever opens the rankings never downloads a season of
 * predictions.
 */
const ratingsFile = () => artifact<{ teams: TeamRating[] }>('analytics/ratings.json');
const timelineFile = () => artifact<EloTimeline>('analytics/elo_timeline.json');
const standoutsFile = () => artifact<{ weeks: Standout[] }>('analytics/standouts.json');

/** Resolves once per file and caches, so switching back to a view is instant. */
function cached<T>(load: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | null = null;
    return () => (pending ??= load());
}

export const loadRatings = cached(async (): Promise<TeamRating[]> => (await ratingsFile()).teams);

export const loadTimeline = cached(timelineFile);

export const loadStandouts = cached(async (): Promise<Standout[]> => (await standoutsFile()).weeks);

/** A per-season file, or null when that season has none (it was excluded, or not built). */
const perSeason = <T>(folder: string) => {
    const memo = new Map<string, Promise<T | null>>();
    return (season: string): Promise<T | null> => {
        const existing = memo.get(season);
        if (existing) return existing;
        const pending = artifact<T>(`${folder}/${season}.json`).catch(err => {
            memo.delete(season); // a network failure may be retried; a 404 is just "no file"
            if (err instanceof ApiRequestError && err.status === 404) return null;
            throw err;
        });
        memo.set(season, pending);
        return pending;
    };
};

export const loadPredictions = perSeason<SeasonPredictions>('analytics/predictions');
const loadImpactFile = perSeason<{ season: string; players: ImpactPlayer[] }>('analytics/impact');

/** One season of the season-stats table (`seasons/<year>.json`, or `all-time`). */
export const loadSeasonFile = perSeason<import('./types').SeasonFile>('seasons');

export async function loadImpact(season: string): Promise<ImpactPlayer[]> {
    const file = await loadImpactFile(season);
    return file?.players ?? [];
}

