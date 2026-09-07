import * as fs from 'fs';
import * as path from 'path';
import { TeamNameResolver } from '@ncaa/parsers';
import { ACC_INVENTORY, TEAM_ALIASES, TEAMS_DIR as STORAGE_TEAMS_DIR } from '@ncaa/storage';

export interface TeamConfig {
    team_id: string;
    name_canonical: string;
    /** Conference the school is filed under, in current alignment. */
    conference?: string;
    schedule_url: string;
    platform_guess?: string;
    parser_key?: string;
    aliases?: string[];
    /** IANA zone the school quotes kickoff times in; defaults to US Eastern. */
    timezone?: string;
}

export const DEFAULT_TEAMS_PATH = ACC_INVENTORY;
export const DEFAULT_ALIASES_PATH = TEAM_ALIASES;

export function loadTeams(teamsPath: string = DEFAULT_TEAMS_PATH): TeamConfig[] {
    if (!fs.existsSync(teamsPath)) {
        throw new Error(`Teams JSON not found at ${teamsPath}`);
    }
    return JSON.parse(fs.readFileSync(teamsPath, 'utf8'));
}

export const TEAMS_DIR = STORAGE_TEAMS_DIR;

/**
 * Every school across every conference inventory, de-duplicated by `team_id`.
 *
 * Stages that work off `games.csv` rather than one conference's roster need all of
 * them: a box score fetched from a Big Ten game still has to resolve that school's name
 * and know which platform serves it. Loading only `acc_teams.json` leaves every other
 * conference without aliases and routes its WMT sites down the HTML path.
 */
export function loadAllTeams(teamsDir: string = TEAMS_DIR): TeamConfig[] {
    const byId = new Map<string, TeamConfig>();
    for (const file of fs.readdirSync(teamsDir).sort()) {
        if (!file.endsWith('_teams.json') || file === 'test_teams.json') continue;
        try {
            for (const team of loadTeams(path.join(teamsDir, file))) {
                if (team.team_id && !byId.has(team.team_id)) byId.set(team.team_id, team);
            }
        } catch {
            /* not a usable inventory */
        }
    }
    return [...byId.values()];
}

/**
 * Builds a resolver that maps every known spelling of a team — including the
 * mascot-only names some sites store — onto the canonical name used in the dataset.
 *
 * `team_aliases.json` is keyed by `team_id`, so it is joined back to
 * `acc_teams.json` to get the display name each alias should collapse to.
 */
export function buildTeamNameResolver(
    teams: TeamConfig[],
    aliasesPath: string = DEFAULT_ALIASES_PATH
): TeamNameResolver {
    const canonicalById = new Map(teams.map(team => [team.team_id, team.name_canonical]));
    const map: Record<string, string[]> = {};

    for (const team of teams) {
        map[team.name_canonical] = [...(team.aliases || [])];
    }

    if (fs.existsSync(aliasesPath)) {
        const byTeamId: Record<string, string[]> = JSON.parse(fs.readFileSync(aliasesPath, 'utf8'));
        for (const [teamId, aliases] of Object.entries(byTeamId)) {
            const canonical = canonicalById.get(teamId);
            if (!canonical) continue;
            map[canonical] = [...(map[canonical] || []), ...aliases];
        }
    }

    return new TeamNameResolver(map);
}
