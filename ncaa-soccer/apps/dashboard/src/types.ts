export interface PlayerStat {
    player_key: string;
    player_name: string;
    team_id: string;
    /** Conference the team plays in, or "Other / Non-D1" when unmatched. */
    conference: string;
    /** Calendar year of the season these totals cover. */
    season: string;
    jersey_number: string;
    games_played: number;
    minutes: number;
    goals: number;
    assists: number;
    shots: number;
    shots_on_goal: number;
    saves: number;
    /**
     * Goal contributions now and in the comparison window, or null when the player has
     * too little history to compare. Which window depends on the season's `movers_mode`.
     */
    movement_current?: number | null;
    movement_previous?: number | null;
    /**
     * Every team and conference the row covers. Present only on all-time rows, where a
     * career can span the schools a player transferred between; the filters match any of
     * them, so three years at Indiana still belong to Indiana after a transfer out.
     */
    teams?: string[];
    conferences?: string[];
}

/**
 * What "moved" means for a season.
 *
 * `season` compares each player against their own previous season, and needs both to be
 * complete. `pace` is what a season still being played gets: the same stretch of each
 * year, since a partial season's totals would make every player look like a faller.
 * `form` is the fallback with no season behind it — the last three games against the
 * three before them.
 */
export type MoversMode = 'season' | 'form' | 'pace';

/** One season's file, as written by `generate_dashboard_data.ts`. */
export interface SeasonFile {
    season: string;
    movers_mode: MoversMode;
    /** The season compared against, when `movers_mode` is `season`. */
    compared_to: string | null;
    players: PlayerStat[];
}

/** What a season holds, known before that season's players are loaded. */
export interface SeasonSummary {
    season: string;
    /** Shown on the season control when the key is not a year, e.g. `all-time`. */
    label?: string;
    players: number;
    teams: string[];
    conferences: string[];
    goals: number;
}

/**
 * The index of available seasons, written by `generate_dashboard_data.ts`.
 *
 * Loaded eagerly because the filter controls are built from it; the seasons themselves
 * are fetched only when selected.
 */
export interface Manifest {
    generated_at: string;
    default_season: string;
    seasons: SeasonSummary[];
    /**
     * Seasons left out for thin roster coverage, named so the page can say which years
     * are missing and why rather than silently skipping them.
     */
    excluded_seasons?: { season: string; note: string | null; roster_share: number }[];
}
