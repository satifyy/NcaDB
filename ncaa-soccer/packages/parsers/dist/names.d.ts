/**
 * Team-name handling shared by every platform.
 *
 * Schools write the same opponent a dozen ways — "Pitt", "Pittsburgh",
 * "University of Pittsburgh", "#3 NC State", "#24/RV University of Virginia" — and a
 * fixture only dedupes across two schools' sites if both spellings collapse to one
 * canonical name. {@link cleanTeamName} strips the decoration; {@link TeamNameResolver}
 * maps what is left onto the canonical name.
 *
 * WMT sites add a wrinkle: they store two names per opponent
 * (`opponent_name` / `opponent_school_name`) and which one holds the school is a
 * per-site data-entry choice. Clemson and Virginia put the school in both, while Notre
 * Dame puts the mascot in `opponent_name` ("Wolverines") and the school in
 * `opponent_school_name` ("Michigan") — except for a handful of rows where it is the
 * other way round. {@link TeamNameResolver.pickSchoolName} decides row by row.
 */
export interface CleanedName {
    /** School name with rank markers and fixture qualifiers removed. */
    name: string;
    /** True when the raw value carried a rank marker ("No. 7", "(9)"). */
    ranked: boolean;
    /** True when a trailing fixture qualifier was stripped ("(NCAA First Round)"). */
    hadQualifier: boolean;
    /** True when the stripped qualifier said this was an exhibition. */
    exhibition: boolean;
}
export declare function cleanTeamName(raw: string | null | undefined): CleanedName;
/**
 * Maps site-supplied names onto the canonical names used across the dataset,
 * so a WMT row for "Pitt" dedupes against a Sidearm row for "Pittsburgh".
 */
export declare class TeamNameResolver {
    private aliases;
    /** @param canonicalToAliases canonical display name -> alternative spellings */
    constructor(canonicalToAliases?: Record<string, string[]>);
    private static key;
    /**
     * Longer-form spellings the same school shows up under across sites:
     * "University of Kentucky", "Kentucky University", "Saint Mary's" / "St. Mary's".
     * Registered only where they do not collide with a name given explicitly.
     */
    private static variants;
    /**
     * Canonical name for a known team, or null when the name is unrecognised.
     *
     * Box scores and schedules abbreviate the same school differently — "Michigan St.",
     * "St. John's (NY)", "Saint Mary's (CA)" — so the input is retried through the same
     * normalisations used to register names before giving up.
     */
    lookup(name: string): string | null;
    /** Canonical name when known, otherwise the name as given. */
    canonical(name: string): string;
    /**
     * Chooses between the two names WMT stores for an opponent.
     *
     * `preferSecondary` is the site-level verdict from {@link detectSchoolNameField};
     * it only decides rows the per-row signals cannot.
     */
    pickSchoolName(primaryRaw: string | null | undefined, secondaryRaw: string | null | undefined, preferSecondary?: boolean): CleanedName;
    /**
     * Decides which of the two fields a site uses for school names by scoring both
     * across a whole season: the field with more recognisable schools wins.
     */
    detectSchoolNameField(rows: Array<{
        primary?: string | null;
        secondary?: string | null;
    }>): {
        preferSecondary: boolean;
    };
}
/** The subset of a game row this module can normalise. */
export interface NormalisableGame {
    home_team_name: string;
    away_team_name: string;
    home_team_ranked?: boolean;
    away_team_ranked?: boolean;
    date: string;
    dedupe_key: string;
}
/**
 * Dedupe key shared by every parser: date plus both teams, alphabetically, so the two
 * schools in a fixture derive the same key from their own points of view.
 */
export declare function makeDedupeKey(date: string, homeTeam: string, awayTeam: string): string;
/**
 * Rewrites a game's team names to their canonical form and rebuilds its dedupe key.
 *
 * Applied to every row before storage, this is what stops one fixture being filed
 * twice — once as "#3 Clemson vs Pittsburgh" from Pitt's site and once as
 * "Clemson vs Pittsburgh" from Clemson's. A rank found in the name is moved onto the
 * `*_ranked` flag, which is where the schema keeps it.
 */
export declare function normalizeGameNames<T extends NormalisableGame>(game: T, resolver: TeamNameResolver): T;
//# sourceMappingURL=names.d.ts.map