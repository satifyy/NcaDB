/**
 * Removing the team and player identities that no data refers to any more.
 *
 * Re-resolving team names (`renormalize`, or the nightly's own load) moves every game
 * and box-score row off a misspelt identity — "19 Cornell", "Elon University" — onto the
 * real one, but leaves the emptied rows behind: the loader only adds and updates teams
 * and players, because deleting one would also delete the users' favorites that point at
 * it (`accounts.user_favorite_*` cascade). This step does that deliberately:
 *
 *  - an orphan is a non-Division I team, or a player, that no game, box-score row,
 *    roster or Team of the Week row refers to;
 *  - each orphan's successor is the identity its name resolves to now (the team the
 *    current rules give its name; the same player letters on that team), when one
 *    exists and is itself in use;
 *  - favorites of an orphan move to its successor, or are removed when it has none
 *    (a bracket placeholder), each one written to the user's activity audit;
 *  - then the orphans are deleted.
 *
 * One transaction, under the ingestion lock so no load runs alongside it. Orphans are
 * found again inside the transaction, so the plan applied is never stale, and a second
 * run finds nothing: it is idempotent by construction. Without `apply` it only reports.
 * Needs the owner (the worker role cannot see `accounts`).
 */

import { Pool, PoolClient } from 'pg';
import { INGESTION_LOCK_KEY, withTransaction } from '@ncaa/database';
import { TeamResolver } from './normalize';

export interface OrphanTeam {
    id: number;
    slug: string;
    name: string;
    successor: { id: number; slug: string } | null;
    favorites: number;
}

export interface OrphanPlayer {
    id: number;
    identity_key: string;
    name: string;
    successor: { id: number; identity_key: string } | null;
    favorites: number;
}

/**
 * The identities an apply may touch, each with the successor it was reviewed with
 * (`null`: deleted without one). Anything not listed is reported and left alone.
 */
export interface ReconcileTargets {
    teams: { id: number; successor: number | null }[];
    players: { id: number; successor: number | null }[];
}

export interface IdentityReport {
    applied: boolean;
    /** The season the targets' cascading rows may belong to; null without targets. */
    season: number | null;
    /** In scope: the targets (or, without targets, every orphan). */
    teams: OrphanTeam[];
    players: OrphanPlayer[];
    /** Orphans that are not targets: never touched. */
    out_of_scope: { teams: OrphanTeam[]; players: OrphanPlayer[] };
    /** Targets that no longer exist (a previous apply removed them): nothing to do. */
    already_removed: { teams: number[]; players: number[] };
    /** Rows the deletes would cascade to, by table and season. */
    cascades: { table: string; season: number; rows: number }[];
    /** Why an apply would be refused. Empty means it can run. */
    problems: string[];
    favorites: { teams_moved: number; teams_removed: number; players_moved: number; players_removed: number };
    /** On apply: every row removed or rewritten, enough to put them back. */
    removed?: Record<string, unknown[]>;
}

const ORPHAN_TEAMS = `
    WITH live AS (
        SELECT p.id, p.team_id FROM players p
        WHERE EXISTS (SELECT 1 FROM player_game_stats s WHERE s.player_id = p.id)
           OR EXISTS (SELECT 1 FROM totw_player_weeks w WHERE w.player_id = p.id)
           OR EXISTS (SELECT 1 FROM totw_selections w WHERE w.player_id = p.id))
    SELECT t.id, t.slug, t.name FROM teams t
    WHERE NOT t.is_division_one
      AND NOT EXISTS (SELECT 1 FROM games g WHERE g.home_team_id = t.id OR g.away_team_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM live l WHERE l.team_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM player_team_seasons s JOIN live l ON l.id = s.player_id WHERE s.team_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM player_game_stats s WHERE s.team_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM team_game_stats s WHERE s.team_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM totw_player_weeks w WHERE w.team_id = t.id)
    ORDER BY t.id`;

const ORPHAN_PLAYERS = `
    SELECT p.id, p.identity_key, p.display_name AS name, t.name AS team_name FROM players p JOIN teams t ON t.id = p.team_id
    WHERE NOT EXISTS (SELECT 1 FROM player_game_stats s WHERE s.player_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM totw_player_weeks w WHERE w.player_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM totw_selections w WHERE w.player_id = p.id)
    ORDER BY p.id`;

async function favoriteCounts(client: PoolClient, table: 'teams' | 'players', ids: number[]): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map();
    const column = table === 'teams' ? 'team_id' : 'player_id';
    const { rows } = await client.query<{ id: string; n: number }>(
        `SELECT ${column} AS id, count(*)::int AS n FROM accounts.user_favorite_${table} WHERE ${column} = ANY($1) GROUP BY 1`,
        [ids]
    );
    return new Map(rows.map(r => [Number(r.id), r.n]));
}

/** Finds the orphans and their successors with `client`, which must be able to read `accounts`. */
export async function planIdentities(client: PoolClient, resolver: TeamResolver): Promise<{ teams: OrphanTeam[]; players: OrphanPlayer[] }> {
    const { rows: allTeams } = await client.query<{ id: number; slug: string; name: string }>('SELECT id, slug, name FROM teams');
    const bySlug = new Map(allTeams.map(t => [t.slug, t]));
    const { rows: teamRows } = await client.query<{ id: number; slug: string; name: string }>(ORPHAN_TEAMS);
    const orphanIds = new Set(teamRows.map(t => t.id));
    const successorTeam = (name: string, self?: number) => {
        const slug = resolver.resolve(name)?.slug;
        const target = slug ? bySlug.get(slug) : undefined;
        return target && target.id !== self && !orphanIds.has(target.id) ? { id: target.id, slug: target.slug } : null;
    };
    const teamFavorites = await favoriteCounts(client, 'teams', teamRows.map(t => t.id));
    const teams = teamRows.map(t => ({ ...t, successor: successorTeam(t.name, t.id), favorites: teamFavorites.get(t.id) ?? 0 }));

    const { rows: playerRows } = await client.query<{ id: string; identity_key: string; name: string; team_name: string }>(ORPHAN_PLAYERS);
    const orphanPlayers = new Set(playerRows.map(p => Number(p.id)));
    const wanted = playerRows.map(p => {
        const team = successorTeam(p.team_name) ?? null;
        const letters = p.identity_key.slice(p.identity_key.indexOf(':') + 1);
        return { p, key: team ? `${team.slug}:${letters}` : null };
    });
    const keys = wanted.map(w => w.key).filter((k): k is string => !!k);
    const { rows: found } = keys.length
        ? await client.query<{ id: string; identity_key: string }>('SELECT id, identity_key FROM players WHERE identity_key = ANY($1)', [keys])
        : { rows: [] as { id: string; identity_key: string }[] };
    const byKey = new Map(found.filter(f => !orphanPlayers.has(Number(f.id))).map(f => [f.identity_key, Number(f.id)]));
    const playerFavorites = await favoriteCounts(client, 'players', playerRows.map(p => Number(p.id)));
    const players = wanted.map(({ p, key }) => {
        const id = key ? byKey.get(key) : undefined;
        return {
            id: Number(p.id),
            identity_key: p.identity_key,
            name: p.name,
            successor: id !== undefined && key ? { id, identity_key: key } : null,
            favorites: playerFavorites.get(Number(p.id)) ?? 0
        };
    });
    return { teams, players };
}

async function moveFavorites(
    client: PoolClient,
    table: 'teams' | 'players',
    orphans: { id: number; successor: { id: number } | null; favorites: number }[]
): Promise<{ moved: number; removed: number }> {
    const column = table === 'teams' ? 'team_id' : 'player_id';
    let moved = 0;
    let removed = 0;
    for (const o of orphans.filter(x => x.favorites > 0)) {
        const { rows } = await client.query<{ user_id: string }>(
            `SELECT user_id FROM accounts.user_favorite_${table} WHERE ${column} = $1`,
            [o.id]
        );
        for (const { user_id } of rows) {
            if (o.successor) {
                await client.query(
                    `INSERT INTO accounts.user_favorite_${table} (user_id, ${column}, created_at)
                     SELECT user_id, $2, created_at FROM accounts.user_favorite_${table} WHERE user_id = $3 AND ${column} = $1
                     ON CONFLICT DO NOTHING`,
                    [o.id, o.successor.id, user_id]
                );
            }
            await client.query(
                `INSERT INTO accounts.user_activity_audit (user_id, action, detail, actor)
                 VALUES ($1, $2, $3, 'reconcile-identities')`,
                [user_id, o.successor ? 'favorite.moved' : 'favorite.removed', JSON.stringify({ kind: table, from: o.id, to: o.successor?.id ?? null })]
            );
            o.successor ? moved++ : removed++;
        }
        await client.query(`DELETE FROM accounts.user_favorite_${table} WHERE ${column} = $1`, [o.id]);
    }
    return { moved, removed };
}

/** Reads a targets file: `{ "teams": [{ "id", "successor" }], "players": [...] }`. */
export function parseTargets(json: string): ReconcileTargets {
    const raw = JSON.parse(json) as Partial<ReconcileTargets>;
    const list = (xs: unknown, what: string) => {
        if (!Array.isArray(xs)) throw new Error(`targets: "${what}" must be a list`);
        return xs.map(x => {
            const { id, successor } = x as { id: unknown; successor: unknown };
            if (!Number.isInteger(id) || !(successor === null || Number.isInteger(successor))) {
                throw new Error(`targets: every ${what} entry needs an integer "id" and an integer or null "successor"`);
            }
            return { id: id as number, successor: successor as number | null };
        });
    };
    return { teams: list(raw.teams, 'teams'), players: list(raw.players, 'players') };
}

/**
 * Plans, and with `apply` performs, the removal of orphaned identities.
 *
 * An apply needs `targets` and `season`, and is refused when anything differs from what
 * was reviewed: a target that is no longer an orphan, a successor other than the one
 * listed, a player outside the targets still on a target team, or a row the deletes
 * would cascade to (team_seasons, player_team_seasons) in a season other than `season`.
 */
export async function reconcileIdentities(
    pool: Pool,
    resolver: TeamResolver,
    options: { apply: boolean; targets?: ReconcileTargets; season?: number }
): Promise<IdentityReport> {
    const { apply, targets, season } = options;
    if (apply && (!targets || season === undefined)) {
        throw new Error('--apply needs --targets FILE and --season YYYY: only reviewed identities are ever removed.');
    }
    return withTransaction(pool, async client => {
        const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [INGESTION_LOCK_KEY]);
        if (!rows[0].ok) throw new Error('An ingestion run holds the lock; run reconcile-identities when it has finished.');
        const plan = await planIdentities(client, resolver);
        const problems: string[] = [];

        let teams = plan.teams;
        let players = plan.players;
        let outTeams: OrphanTeam[] = [];
        let outPlayers: OrphanPlayer[] = [];
        const alreadyRemoved = { teams: [] as number[], players: [] as number[] };
        if (targets) {
            const existing = async (table: 'teams' | 'players', ids: number[]) =>
                new Set((await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1)`, [ids])).rows.map(r => Number(r.id)));
            const liveTeams = await existing('teams', targets.teams.map(t => t.id));
            const livePlayers = await existing('players', targets.players.map(p => p.id));
            const check = <T extends { id: number; successor: { id: number } | null }>(
                kind: 'team' | 'player', orphans: T[], wanted: ReconcileTargets['teams'], live: Set<number>
            ) => {
                const byId = new Map(orphans.map(o => [o.id, o]));
                const wantedIds = new Set(wanted.map(w => w.id));
                for (const w of wanted) {
                    const o = byId.get(w.id);
                    if (!live.has(w.id)) (kind === 'team' ? alreadyRemoved.teams : alreadyRemoved.players).push(w.id);
                    else if (!o) problems.push(`${kind} ${w.id} is a target but is in use, not an orphan`);
                    else if ((o.successor?.id ?? null) !== w.successor) {
                        problems.push(`${kind} ${w.id} would now map to ${o.successor?.id ?? 'nothing'}, not the reviewed ${w.successor ?? 'nothing'}`);
                    }
                }
                return { inScope: orphans.filter(o => wantedIds.has(o.id)), out: orphans.filter(o => !wantedIds.has(o.id)) };
            };
            const t = check('team', plan.teams, targets.teams, liveTeams);
            const p = check('player', plan.players, targets.players, livePlayers);
            teams = t.inScope; outTeams = t.out;
            players = p.inScope; outPlayers = p.out;
        }
        const teamIds = teams.map(t => t.id);
        const playerIds = players.map(p => p.id);

        // A player row references its team: one left behind would block the delete.
        const { rows: strays } = await client.query<{ id: string; identity_key: string }>(
            'SELECT id, identity_key FROM players WHERE team_id = ANY($1) AND NOT (id = ANY($2)) ORDER BY id',
            [teamIds, playerIds]
        );
        for (const s of strays) problems.push(`player ${s.id} (${s.identity_key}) is on a target team but is not a target`);
        const { rows: rosterStrays } = await client.query<{ player_id: string; team_id: number }>(
            'SELECT DISTINCT player_id, team_id FROM player_team_seasons WHERE team_id = ANY($1) AND NOT (player_id = ANY($2)) ORDER BY 1',
            [teamIds, playerIds]
        );
        for (const r of rosterStrays) problems.push(`player ${r.player_id} has a roster row on target team ${r.team_id} but is not a target`);

        // What the deletes cascade to, season by season.
        const { rows: cascades } = await client.query<{ table: string; season: number; rows: number }>(
            `SELECT 'team_seasons' AS table, s.year AS season, count(*)::int AS rows
               FROM team_seasons ts JOIN seasons s ON s.id = ts.season_id WHERE ts.team_id = ANY($1) GROUP BY s.year
             UNION ALL
             SELECT 'player_team_seasons', s.year, count(*)::int
               FROM player_team_seasons pts JOIN seasons s ON s.id = pts.season_id WHERE pts.player_id = ANY($2) GROUP BY s.year
             ORDER BY 1, 2`,
            [teamIds, playerIds]
        );
        if (season !== undefined) {
            for (const c of cascades) {
                if (c.season !== season) problems.push(`deleting would remove ${c.rows} ${c.table} row(s) from ${c.season}, outside ${season}`);
            }
        }

        const favorites = { teams_moved: 0, teams_removed: 0, players_moved: 0, players_removed: 0 };
        const report: IdentityReport = {
            applied: false, season: season ?? null, teams, players,
            out_of_scope: { teams: outTeams, players: outPlayers }, already_removed: alreadyRemoved, cascades, problems, favorites
        };
        if (!apply) return report;
        if (problems.length > 0) throw new Error(`Refusing to apply:\n  ${problems.join('\n  ')}`);

        // Everything about to be removed or rewritten, so it can be put back by hand.
        const snapshot = async (sql: string, args: unknown[]) => (await client.query(sql, args)).rows;
        report.removed = {
            teams: await snapshot('SELECT * FROM teams WHERE id = ANY($1)', [teamIds]),
            players: await snapshot('SELECT * FROM players WHERE id = ANY($1)', [playerIds]),
            team_seasons: await snapshot('SELECT * FROM team_seasons WHERE team_id = ANY($1)', [teamIds]),
            player_team_seasons: await snapshot('SELECT * FROM player_team_seasons WHERE player_id = ANY($1)', [playerIds]),
            source_identifiers: await snapshot(`SELECT * FROM source_identifiers WHERE entity_type = 'team' AND entity_id = ANY($1)`, [teamIds]),
            user_favorite_teams: await snapshot('SELECT * FROM accounts.user_favorite_teams WHERE team_id = ANY($1)', [teamIds]),
            user_favorite_players: await snapshot('SELECT * FROM accounts.user_favorite_players WHERE player_id = ANY($1)', [playerIds])
        };

        const p = await moveFavorites(client, 'players', players);
        const t = await moveFavorites(client, 'teams', teams);
        Object.assign(favorites, { players_moved: p.moved, players_removed: p.removed, teams_moved: t.moved, teams_removed: t.removed });
        // Recorded spellings follow the team to its successor; a placeholder's go with it.
        for (const team of teams) {
            if (team.successor) {
                await client.query(
                    `UPDATE source_identifiers SET entity_id = $2 WHERE entity_type = 'team' AND entity_id = $1`,
                    [team.id, team.successor.id]
                );
            }
        }
        await client.query(`DELETE FROM source_identifiers WHERE entity_type = 'team' AND entity_id = ANY($1)`, [teamIds]);
        // Cascading rows are deleted explicitly, limited to the season the check allowed.
        await client.query('DELETE FROM player_team_seasons WHERE player_id = ANY($1)', [playerIds]);
        await client.query('DELETE FROM team_seasons WHERE team_id = ANY($1)', [teamIds]);
        // Players first: a player row references its team.
        await client.query('DELETE FROM players WHERE id = ANY($1)', [playerIds]);
        await client.query('DELETE FROM teams WHERE id = ANY($1)', [teamIds]);
        report.applied = true;
        return report;
    });
}
