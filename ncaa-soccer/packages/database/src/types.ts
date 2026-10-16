/**
 * What the loader accepts: records already parsed, validated and resolved to teams.
 *
 * Nothing in this package reads a CSV or knows a school's spelling rules; the worker
 * turns scraper output into these and this package only persists them. That split is
 * what lets each half be tested without the other.
 */

export interface TeamRecord {
    slug: string;
    name: string;
    /** Inventory id, for Division I programs the scrapers know. */
    inventoryId?: string | null;
    isDivisionOne: boolean;
    conference?: string | null;
    scheduleUrl?: string | null;
    platform?: string | null;
    timezone?: string | null;
    aliases?: string[];
}

export type GameStatus = 'scheduled' | 'live' | 'final' | 'postponed' | 'canceled' | 'unknown';
export type LocationType = 'home' | 'away' | 'neutral' | 'unknown';
export type GameType = 'exhibition' | 'ncaa_tournament' | 'conference_tournament' | 'regular';

/** One school's schedule row for a fixture. */
export interface GameSourceRecord {
    dedupeKey: string;
    sourceGameId: string;
    date: string;
    homeSlug: string;
    awaySlug: string;
    /** The names as the row spelled them, after the scraper's cleaning. */
    homeName: string;
    awayName: string;
    homeRanked: boolean | null;
    awayRanked: boolean | null;
    homeScore: number | null;
    awayScore: number | null;
    status: GameStatus;
    locationType: LocationType;
    gameType: GameType | null;
    scheduleUrl: string | null;
    boxscoreUrl: string | null;
    boxscoreUrlAlt: string | null;
    /** The CSV row verbatim. Written back out unchanged when the worker hydrates. */
    payload: Record<string, string>;
}

export interface PlayerStatRecord {
    sourceGameId: string;
    teamSlug: string;
    /** `<team slug>:<letters of the name>`. */
    identityKey: string;
    playerName: string;
    displayName: string;
    jerseyNumber: string | null;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    shots: number | null;
    shotsOnGoal: number | null;
    saves: number | null;
    /** As the box score printed it; null when it printed none. */
    position: string | null;
    positionGroup: 'GK' | 'DEF' | 'MID' | 'FWD' | null;
    started: boolean | null;
    goalsAllowed: number | null;
    /** See migration 005. Rows from files without the column are version 1. */
    captureVersion: number;
    sourceTeamName: string;
    sourcePlayerName: string;
    sourcePlayerKey: string;
}

/** A batch of rejected input, summarised rather than stored row by row. */
export interface QualityIssue {
    category: 'validation' | 'reconciliation' | 'parse' | 'source';
    severity: 'warning' | 'error';
    code: string;
    message: string;
    count: number;
    samples: unknown[];
}

export interface SeasonBatch {
    season: number;
    teams: TeamRecord[];
    /** Raw spellings seen this batch, mapped to the slug each resolved to. */
    teamSpellings: Map<string, string>;
    games: GameSourceRecord[];
    stats: PlayerStatRecord[];
    /**
     * Whether `games` is the whole season. A partial batch (one team, one game) never
     * removes anything it does not mention.
     */
    complete: boolean;
    /** Lets a complete batch delete more than the mass-deletion guard allows. */
    allowMassDelete?: boolean;
    /** Do everything inside the transaction, report it, and roll it back. */
    dryRun?: boolean;
}

export interface EntityCounts {
    inserted: number;
    updated: number;
    unchanged: number;
    deleted: number;
}

export interface LoadResult {
    season: number;
    games: EntityCounts;
    gameSources: EntityCounts;
    playerStats: EntityCounts;
    players: { inserted: number };
    teams: { inserted: number };
    issues: QualityIssue[];
    /** Stored games moved to a new fixture key, or merged into the game already there. */
    rekeyed?: { moved: number; merged: number };
    /** Set on a dry run: nothing was kept, and `after` is the season as it would have been. */
    dryRun?: boolean;
    after?: { games: number; finals: number; stat_rows: number; goals: number; wrong_side: number; duplicate_stat_keys: number };
}
