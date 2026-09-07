/**
 * Reading the CSVs into the shapes the models want, once, so no model has to know where
 * the data lives or how its team names are spelled.
 *
 * The box-score files are the large ones — roughly 9 MB and 130,000 rows per season — so
 * they are read a season at a time and never all held at once. Everything here returns
 * canonical team names.
 */

import { cleanTeamName } from '@ncaa/parsers';
import { int, PlayerStatCsvRow, playerStatsCsv, streamRowsIfExists } from '@ncaa/storage';
import { normalisePlayer } from '../utils/canonical_teams';
import { PlayerGameRow } from './impact';

/**
 * One row per player per game, with the several spellings of a school folded onto one.
 *
 * Rows for the same player in the same game arrive more than once when both schools
 * published a box score under different names for the team, so they are summed on
 * `identity` rather than appended — otherwise a goal scored once is counted twice, which
 * is the same double-counting the aggregate stage exists to prevent.
 *
 * Streamed rather than read whole: a season is 9-10 MB and up to 130,000 rows, and
 * `build_ratings` walks eleven of them. Only the merged map is held, which is what the
 * function returns anyway.
 */
export async function loadPlayerGames(
    season: string,
    resolveTeam: (raw: string) => string
): Promise<PlayerGameRow[]> {
    const merged = new Map<string, PlayerGameRow>();
    for await (const row of streamRowsIfExists<PlayerStatCsvRow>(playerStatsCsv(season))) {
        if (!row.player_name || !row.game_id) continue;
        const team = resolveTeam(cleanTeamName(row.team_id).name || row.team_id);
        const identity = `${team}::${normalisePlayer(row.player_name)}`;
        const key = `${row.game_id}::${identity}`;

        const existing = merged.get(key);
        if (existing) {
            // The same appearance twice, not two appearances: keep the fuller of the two
            // rather than adding them together.
            existing.minutes = Math.max(existing.minutes, int(row.minutes));
            existing.goals = Math.max(existing.goals, int(row.goals));
            existing.assists = Math.max(existing.assists, int(row.assists));
            existing.shots = Math.max(existing.shots, int(row.shots));
            existing.shots_on_goal = Math.max(existing.shots_on_goal, int(row.shots_on_goal));
            existing.saves = Math.max(existing.saves, int(row.saves));
            continue;
        }

        merged.set(key, {
            game_id: row.game_id,
            team,
            player_name: row.player_name,
            identity,
            jersey_number: row.jersey_number,
            minutes: int(row.minutes),
            goals: int(row.goals),
            assists: int(row.assists),
            shots: int(row.shots),
            shots_on_goal: int(row.shots_on_goal),
            saves: int(row.saves)
        });
    }
    return [...merged.values()];
}

/** Distinct players each school fielded in a season — the roster-coverage denominator. */
export function rosterSizes(rows: PlayerGameRow[]): Map<string, number> {
    const byTeam = new Map<string, Set<string>>();
    for (const row of rows) {
        const roster = byTeam.get(row.team) || new Set<string>();
        roster.add(row.identity);
        byTeam.set(row.team, roster);
    }
    return new Map([...byTeam].map(([team, roster]) => [team, roster.size]));
}
