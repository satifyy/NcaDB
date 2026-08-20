import { TeamNameResolver } from '@ncaa/parsers';
export interface TeamConfig {
    team_id: string;
    name_canonical: string;
    schedule_url: string;
    platform_guess?: string;
    parser_key?: string;
    aliases?: string[];
    /** IANA zone the school quotes kickoff times in; defaults to US Eastern. */
    timezone?: string;
}
export declare const DEFAULT_TEAMS_PATH: string;
export declare const DEFAULT_ALIASES_PATH: string;
export declare function loadTeams(teamsPath?: string): TeamConfig[];
export declare const TEAMS_DIR: string;
/**
 * Every school across every conference inventory, de-duplicated by `team_id`.
 *
 * Stages that work off `games.csv` rather than one conference's roster need all of
 * them: a box score fetched from a Big Ten game still has to resolve that school's name
 * and know which platform serves it. Loading only `acc_teams.json` leaves every other
 * conference without aliases and routes its WMT sites down the HTML path.
 */
export declare function loadAllTeams(teamsDir?: string): TeamConfig[];
/**
 * Builds a resolver that maps every known spelling of a team — including the
 * mascot-only names some sites store — onto the canonical name used in the dataset.
 *
 * `team_aliases.json` is keyed by `team_id`, so it is joined back to
 * `acc_teams.json` to get the display name each alias should collapse to.
 */
export declare function buildTeamNameResolver(teams: TeamConfig[], aliasesPath?: string): TeamNameResolver;
//# sourceMappingURL=teams.d.ts.map