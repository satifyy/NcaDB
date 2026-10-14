/**
 * Writes one season's validated records, idempotently, in a single transaction.
 *
 * Idempotency comes from the unique constraints, not from the caller being careful:
 * every write is an `INSERT ... ON CONFLICT` keyed on a natural identity, and an update
 * only happens when the row's content hash changed. Loading the same batch twice leaves
 * the database byte-for-byte where the first load did, and reports everything unchanged.
 *
 * One transaction per season means a failure part-way leaves the season exactly as it
 * was before the load started — never a game without its sources, or a box score half
 * replaced.
 */

import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { withTransaction } from './pool';
import {
    EntityCounts,
    GameSourceRecord,
    GameType,
    LoadResult,
    PlayerStatRecord,
    QualityIssue,
    SeasonBatch,
    TeamRecord
} from './types';

const SPORT_CODE = 'msoc';
const COMPETITION_CODE = 'ncaa-d1-msoc';
/** Rows per statement. Keeps each JSON parameter to a few megabytes. */
const CHUNK = 5000;

export function hashOf(value: unknown): string {
    return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/**
 * A whole-season load may delete at most this many stored source rows, or this share of
 * the season, whichever is larger. Beyond it the load is refused and rolled back.
 */
export const MASS_DELETE_MIN_ROWS = 25;
export const MASS_DELETE_MAX_SHARE = 0.05;

export class MassDeletionError extends Error {}

const zero = (): EntityCounts => ({ inserted: 0, updated: 0, unchanged: 0, deleted: 0 });

export async function sportId(client: PoolClient | Pool): Promise<number> {
    const { rows } = await client.query<{ id: number }>('SELECT id FROM sports WHERE code = $1', [SPORT_CODE]);
    if (!rows[0]) throw new Error(`Sport ${SPORT_CODE} is not seeded; run migrations first.`);
    return rows[0].id;
}

export async function ensureSeason(client: PoolClient | Pool, year: number): Promise<number> {
    const { rows } = await client.query<{ id: number }>(
        `INSERT INTO seasons (competition_id, year, label)
         SELECT c.id, $1::int, ($1::int)::text FROM competitions c WHERE c.code = $2
         ON CONFLICT (competition_id, year) DO UPDATE SET label = EXCLUDED.label
         RETURNING id`,
        [year, COMPETITION_CODE]
    );
    return rows[0].id;
}

// ---------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------

/**
 * Upserts teams and returns every team's id by slug.
 *
 * Inventory teams carry metadata and overwrite it; teams seen only as opponents are
 * inserted if new and otherwise left alone, so an opponent reference can never blank out
 * a Division I program's schedule URL.
 */
export async function upsertTeams(
    client: PoolClient,
    sport: number,
    teams: TeamRecord[]
): Promise<{ ids: Map<string, number>; inserted: number }> {
    const conferences = [...new Set(teams.map(t => t.conference).filter((c): c is string => !!c))];
    if (conferences.length > 0) {
        await client.query(
            `INSERT INTO conferences (sport_id, name) SELECT $1, unnest($2::text[])
             ON CONFLICT (sport_id, name) DO NOTHING`,
            [sport, conferences]
        );
    }

    let inserted = 0;
    const inventory = teams.filter(t => t.inventoryId);
    const others = teams.filter(t => !t.inventoryId);

    for (const part of chunks(inventory)) {
        const json = JSON.stringify(
            part.map(t => ({
                slug: t.slug,
                name: t.name,
                inventory_id: t.inventoryId,
                is_division_one: t.isDivisionOne,
                conference: t.conference ?? null,
                schedule_url: t.scheduleUrl ?? null,
                platform: t.platform ?? null,
                timezone: t.timezone ?? null,
                aliases: t.aliases ?? []
            }))
        );
        // An inventory id that moved to a new slug (the canonical name changed) has to be
        // released from the old row first, or the unique constraint refuses the move.
        await client.query(
            `UPDATE teams t SET inventory_id = NULL, is_division_one = false, updated_at = now()
             FROM jsonb_to_recordset($1::jsonb) AS x(slug text, inventory_id text)
             WHERE t.inventory_id = x.inventory_id AND t.slug <> x.slug AND t.sport_id = $2`,
            [json, sport]
        );
        const { rows } = await client.query<{ inserted: boolean }>(
            `INSERT INTO teams (sport_id, slug, name, inventory_id, is_division_one, conference_id,
                                schedule_url, platform, timezone, aliases)
             SELECT $2, x.slug, x.name, x.inventory_id, x.is_division_one, c.id,
                    x.schedule_url, x.platform, x.timezone,
                    ARRAY(SELECT jsonb_array_elements_text(x.aliases))
             FROM jsonb_to_recordset($1::jsonb) AS x(
                 slug text, name text, inventory_id text, is_division_one boolean, conference text,
                 schedule_url text, platform text, timezone text, aliases jsonb)
             LEFT JOIN conferences c ON c.sport_id = $2 AND c.name = x.conference
             ON CONFLICT (sport_id, slug) DO UPDATE SET
                 name = EXCLUDED.name,
                 inventory_id = EXCLUDED.inventory_id,
                 is_division_one = EXCLUDED.is_division_one,
                 conference_id = EXCLUDED.conference_id,
                 schedule_url = EXCLUDED.schedule_url,
                 platform = EXCLUDED.platform,
                 timezone = EXCLUDED.timezone,
                 aliases = EXCLUDED.aliases,
                 updated_at = now()
             WHERE (teams.name, teams.inventory_id, teams.is_division_one, teams.conference_id,
                    teams.schedule_url, teams.platform, teams.timezone, teams.aliases)
                IS DISTINCT FROM
                   (EXCLUDED.name, EXCLUDED.inventory_id, EXCLUDED.is_division_one, EXCLUDED.conference_id,
                    EXCLUDED.schedule_url, EXCLUDED.platform, EXCLUDED.timezone, EXCLUDED.aliases)
             RETURNING (xmax = 0) AS inserted`,
            [json, sport]
        );
        inserted += rows.filter(r => r.inserted).length;
    }

    for (const part of chunks(others)) {
        const { rowCount } = await client.query(
            `INSERT INTO teams (sport_id, slug, name)
             SELECT $2, x.slug, x.name FROM jsonb_to_recordset($1::jsonb) AS x(slug text, name text)
             ON CONFLICT (sport_id, slug) DO NOTHING`,
            [JSON.stringify(part.map(t => ({ slug: t.slug, name: t.name }))), sport]
        );
        inserted += rowCount ?? 0;
    }

    const { rows } = await client.query<{ id: number; slug: string }>(
        'SELECT id, slug FROM teams WHERE sport_id = $1',
        [sport]
    );
    return { ids: new Map(rows.map(r => [r.slug, r.id])), inserted };
}

async function recordSpellings(
    client: PoolClient,
    spellings: Map<string, string>,
    ids: Map<string, number>
): Promise<void> {
    const entries = [...spellings.entries()]
        .filter(([, slug]) => ids.has(slug))
        .map(([raw, slug]) => ({ raw, team_id: ids.get(slug) }));
    for (const part of chunks(entries)) {
        await client.query(
            `INSERT INTO source_identifiers (entity_type, entity_id, source, source_key)
             SELECT 'team', x.team_id, 'schedule_name', x.raw
             FROM jsonb_to_recordset($1::jsonb) AS x(raw text, team_id bigint)
             ON CONFLICT (entity_type, source, source_key) DO UPDATE SET entity_id = EXCLUDED.entity_id
             WHERE source_identifiers.entity_id <> EXCLUDED.entity_id`,
            [JSON.stringify(part)]
        );
    }
}

// ---------------------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------------------

interface MergedGame {
    key: string;
    date: string;
    homeId: number;
    awayId: number;
    homeRanked: boolean | null;
    awayRanked: boolean | null;
    homeScore: number | null;
    awayScore: number | null;
    status: GameSourceRecord['status'];
    locationType: GameSourceRecord['locationType'];
    gameType: GameType | null;
    scheduleUrl: string | null;
    boxscoreUrl: string | null;
    boxscoreUrlAlt: string | null;
    qualityFlags: string[];
    sources: GameSourceRecord[];
}

export function fixtureKey(date: string, a: number, b: number): string {
    return `${date}|${Math.min(a, b)}|${Math.max(a, b)}`;
}

const GAME_TYPE_PRIORITY: GameType[] = ['exhibition', 'ncaa_tournament', 'conference_tournament', 'regular'];

/**
 * Folds the schedule rows that describe one fixture into a single game.
 *
 * Each school publishes its own row, often with its own spelling of the opponent; once
 * both names resolve to the same pair of teams on the same date they are one game. The
 * row with a final score wins, then the row with a box-score link, then the first seen.
 * Scores the sources disagree on are flagged rather than silently resolved.
 */
export function mergeFixtures(
    sources: GameSourceRecord[],
    teamIds: Map<string, number>
): { games: MergedGame[]; unresolved: GameSourceRecord[] } {
    const groups = new Map<string, GameSourceRecord[]>();
    const unresolved: GameSourceRecord[] = [];
    for (const source of sources) {
        const home = teamIds.get(source.homeSlug);
        const away = teamIds.get(source.awaySlug);
        if (home === undefined || away === undefined || home === away) {
            unresolved.push(source);
            continue;
        }
        const key = fixtureKey(source.date, home, away);
        groups.set(key, [...(groups.get(key) ?? []), source]);
    }

    const rank = (s: GameSourceRecord) =>
        (s.status === 'final' && s.homeScore !== null && s.awayScore !== null ? 0 : 2) + (s.boxscoreUrl ? 0 : 1);

    const games: MergedGame[] = [];
    for (const [key, group] of groups) {
        const ordered = [...group].sort((a, b) => rank(a) - rank(b));
        const primary = ordered[0];
        const homeId = teamIds.get(primary.homeSlug)!;
        const awayId = teamIds.get(primary.awaySlug)!;

        // Every source's view of each team's rank and score, oriented to the primary.
        const oriented = ordered.map(s => {
            const flipped = teamIds.get(s.homeSlug) !== homeId;
            return {
                source: s,
                homeRanked: flipped ? s.awayRanked : s.homeRanked,
                awayRanked: flipped ? s.homeRanked : s.awayRanked,
                homeScore: flipped ? s.awayScore : s.homeScore,
                awayScore: flipped ? s.homeScore : s.awayScore
            };
        });

        const anyTrue = (values: (boolean | null)[]) =>
            values.some(v => v === true) ? true : values.some(v => v === false) ? false : null;

        const flags: string[] = [];
        const finals = oriented.filter(o => o.source.status === 'final' && o.homeScore !== null && o.awayScore !== null);
        const scorelines = new Set(finals.map(o => `${o.homeScore}-${o.awayScore}`));
        if (scorelines.size > 1) flags.push('score_conflict');

        const types = new Set(group.map(s => s.gameType).filter((t): t is GameType => t !== null));
        const gameType = GAME_TYPE_PRIORITY.find(t => types.has(t)) ?? null;

        const urls = ordered.map(s => s.boxscoreUrl).filter((u): u is string => !!u);
        const alts = ordered.map(s => s.boxscoreUrlAlt).filter((u): u is string => !!u);
        const boxscoreUrl = urls[0] ?? null;
        const boxscoreUrlAlt = [...alts, ...urls].find(u => u !== boxscoreUrl) ?? null;

        games.push({
            key,
            date: primary.date,
            homeId,
            awayId,
            homeRanked: anyTrue(oriented.map(o => o.homeRanked)),
            awayRanked: anyTrue(oriented.map(o => o.awayRanked)),
            homeScore: primary.homeScore,
            awayScore: primary.awayScore,
            status: primary.status,
            locationType: primary.locationType,
            gameType,
            scheduleUrl: ordered.map(s => s.scheduleUrl).find(u => !!u) ?? null,
            boxscoreUrl,
            boxscoreUrlAlt,
            qualityFlags: flags,
            sources: ordered
        });
    }
    return { games, unresolved };
}

async function upsertGames(
    client: PoolClient,
    seasonId: number,
    games: MergedGame[]
): Promise<{ ids: Map<string, number>; counts: EntityCounts }> {
    const counts = zero();
    for (const part of chunks(games)) {
        const json = JSON.stringify(
            part.map(g => {
                const content = {
                    home_team_id: g.homeId,
                    away_team_id: g.awayId,
                    home_team_ranked: g.homeRanked,
                    away_team_ranked: g.awayRanked,
                    home_score: g.homeScore,
                    away_score: g.awayScore,
                    status: g.status,
                    location_type: g.locationType,
                    game_type: g.gameType,
                    schedule_url: g.scheduleUrl,
                    boxscore_url: g.boxscoreUrl,
                    boxscore_url_alt: g.boxscoreUrlAlt,
                    quality_flags: g.qualityFlags
                };
                return { game_date: g.date, ...content, content_hash: hashOf(content) };
            })
        );
        const { rows } = await client.query<{ inserted: boolean }>(
            `INSERT INTO games (season_id, game_date, home_team_id, away_team_id, home_team_ranked,
                                away_team_ranked, home_score, away_score, status, location_type, game_type,
                                schedule_url, boxscore_url, boxscore_url_alt, quality_flags, content_hash)
             SELECT $2, x.game_date, x.home_team_id, x.away_team_id, x.home_team_ranked, x.away_team_ranked,
                    x.home_score, x.away_score, x.status, x.location_type, x.game_type,
                    x.schedule_url, x.boxscore_url, x.boxscore_url_alt,
                    ARRAY(SELECT jsonb_array_elements_text(x.quality_flags)), x.content_hash
             FROM jsonb_to_recordset($1::jsonb) AS x(
                 game_date date, home_team_id int, away_team_id int, home_team_ranked boolean,
                 away_team_ranked boolean, home_score smallint, away_score smallint, status text,
                 location_type text, game_type text, schedule_url text, boxscore_url text,
                 boxscore_url_alt text, quality_flags jsonb, content_hash text)
             ON CONFLICT (season_id, game_date, team_low_id, team_high_id) DO UPDATE SET
                 home_team_id = EXCLUDED.home_team_id,
                 away_team_id = EXCLUDED.away_team_id,
                 home_team_ranked = EXCLUDED.home_team_ranked,
                 away_team_ranked = EXCLUDED.away_team_ranked,
                 home_score = EXCLUDED.home_score,
                 away_score = EXCLUDED.away_score,
                 status = EXCLUDED.status,
                 location_type = EXCLUDED.location_type,
                 game_type = EXCLUDED.game_type,
                 schedule_url = EXCLUDED.schedule_url,
                 boxscore_url = EXCLUDED.boxscore_url,
                 boxscore_url_alt = EXCLUDED.boxscore_url_alt,
                 quality_flags = EXCLUDED.quality_flags,
                 content_hash = EXCLUDED.content_hash,
                 updated_at = now(),
                 last_verified_at = now()
             WHERE games.content_hash IS DISTINCT FROM EXCLUDED.content_hash
             RETURNING (xmax = 0) AS inserted`,
            [json, seasonId]
        );
        for (const row of rows) row.inserted ? counts.inserted++ : counts.updated++;
    }
    counts.unchanged = games.length - counts.inserted - counts.updated;

    const { rows } = await client.query<{ id: string; game_date: string; team_low_id: number; team_high_id: number }>(
        `SELECT id, to_char(game_date, 'YYYY-MM-DD') AS game_date, team_low_id, team_high_id
         FROM games WHERE season_id = $1`,
        [seasonId]
    );
    const ids = new Map(rows.map(r => [fixtureKey(r.game_date, r.team_low_id, r.team_high_id), Number(r.id)]));

    const seen = games.map(g => ids.get(g.key)).filter((id): id is number => id !== undefined);
    await client.query('UPDATE games SET last_verified_at = now() WHERE id = ANY($1::bigint[])', [seen]);
    return { ids, counts };
}

async function upsertGameSources(
    client: PoolClient,
    seasonId: number,
    games: MergedGame[],
    gameIds: Map<string, number>,
    complete: boolean,
    allowMassDelete: boolean
): Promise<EntityCounts> {
    const counts = zero();
    const rows = games.flatMap(g =>
        g.sources.map(s => ({
            game_id: gameIds.get(g.key)!,
            dedupe_key: s.dedupeKey,
            source_game_id: s.sourceGameId,
            payload: s.payload,
            content_hash: hashOf(s.payload)
        }))
    );
    for (const part of chunks(rows)) {
        const result = await client.query<{ inserted: boolean }>(
            `INSERT INTO game_sources (game_id, season_id, dedupe_key, source_game_id, payload, content_hash)
             SELECT x.game_id, $2, x.dedupe_key, x.source_game_id, x.payload, x.content_hash
             FROM jsonb_to_recordset($1::jsonb) AS x(
                 game_id bigint, dedupe_key text, source_game_id text, payload jsonb, content_hash text)
             ON CONFLICT (season_id, dedupe_key) DO UPDATE SET
                 game_id = EXCLUDED.game_id,
                 source_game_id = EXCLUDED.source_game_id,
                 payload = EXCLUDED.payload,
                 content_hash = EXCLUDED.content_hash,
                 last_seen_at = now()
             WHERE game_sources.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                OR game_sources.game_id IS DISTINCT FROM EXCLUDED.game_id
             RETURNING (xmax = 0) AS inserted`,
            [JSON.stringify(part), seasonId]
        );
        for (const row of result.rows) row.inserted ? counts.inserted++ : counts.updated++;
    }
    counts.unchanged = rows.length - counts.inserted - counts.updated;

    if (complete) {
        // A whole-season batch is the authority on which source rows still exist. A
        // fixture left with no source and no box score was a spelling the scraper has
        // since merged away; one that still has stats is kept whatever happens.
        const keys = rows.map(r => r.dedupe_key);
        // ...unless the batch would remove a large part of the season, which is what a
        // truncated file or a broken scrape looks like, not what the sources did.
        const { rows: doomed } = await client.query<{ n: number; total: number }>(
            `SELECT count(*) FILTER (WHERE NOT (dedupe_key = ANY($2::text[])))::int AS n, count(*)::int AS total
             FROM game_sources WHERE season_id = $1`,
            [seasonId, keys]
        );
        const limit = Math.max(MASS_DELETE_MIN_ROWS, Math.ceil(doomed[0].total * MASS_DELETE_MAX_SHARE));
        if (doomed[0].n > limit && !allowMassDelete) {
            throw new MassDeletionError(
                `Refusing to delete ${doomed[0].n} of ${doomed[0].total} stored schedule rows for this season ` +
                    `(limit ${limit}). If the season really shrank, re-run with --allow-mass-delete.`
            );
        }
        const removed = await client.query(
            `DELETE FROM game_sources WHERE season_id = $1 AND NOT (dedupe_key = ANY($2::text[]))`,
            [seasonId, keys]
        );
        counts.deleted = removed.rowCount ?? 0;
        if (counts.deleted > 0) {
            await client.query(
                `DELETE FROM games g WHERE g.season_id = $1
                   AND NOT EXISTS (SELECT 1 FROM game_sources s WHERE s.game_id = g.id)
                   AND NOT EXISTS (SELECT 1 FROM player_game_stats p WHERE p.game_id = g.id)`,
                [seasonId]
            );
        }
    }
    return counts;
}

// ---------------------------------------------------------------------------------------
// Players and box scores
// ---------------------------------------------------------------------------------------

async function upsertPlayers(
    client: PoolClient,
    sport: number,
    stats: PlayerStatRecord[],
    teamIds: Map<string, number>
): Promise<{ ids: Map<string, number>; inserted: number }> {
    const unique = new Map<string, { identity_key: string; name: string; display_name: string; team_id: number }>();
    for (const s of stats) {
        const teamId = teamIds.get(s.teamSlug);
        if (teamId === undefined) continue;
        unique.set(s.identityKey, {
            identity_key: s.identityKey,
            name: s.playerName,
            display_name: s.displayName,
            team_id: teamId
        });
    }
    let inserted = 0;
    const all = [...unique.values()];
    for (const part of chunks(all)) {
        const { rowCount } = await client.query(
            `INSERT INTO players (sport_id, identity_key, name, display_name, team_id)
             SELECT $2, x.identity_key, x.name, x.display_name, x.team_id
             FROM jsonb_to_recordset($1::jsonb) AS x(identity_key text, name text, display_name text, team_id int)
             ON CONFLICT (sport_id, identity_key) DO NOTHING`,
            [JSON.stringify(part), sport]
        );
        inserted += rowCount ?? 0;
    }
    const ids = new Map<string, number>();
    for (const part of chunks(all.map(p => p.identity_key))) {
        const { rows } = await client.query<{ id: string; identity_key: string }>(
            'SELECT id, identity_key FROM players WHERE sport_id = $1 AND identity_key = ANY($2::text[])',
            [sport, part]
        );
        rows.forEach(r => ids.set(r.identity_key, Number(r.id)));
    }
    return { ids, inserted };
}

interface StatRow {
    game_id: number;
    player_id: number;
    team_id: number;
    jersey_number: string | null;
    jersey_key: string;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    shots: number | null;
    shots_on_goal: number | null;
    saves: number | null;
    source_game_id: string;
    source_team_name: string;
    source_player_name: string;
    source_player_key: string;
    content_hash: string;
}

async function upsertStats(
    client: PoolClient,
    seasonId: number,
    rows: StatRow[]
): Promise<EntityCounts> {
    const counts = zero();
    await client.query(`
        CREATE TEMP TABLE _batch_stats (
            game_id bigint, player_id bigint, team_id int, jersey_number text, jersey_key text,
            minutes smallint, goals smallint, assists smallint, shots smallint, shots_on_goal smallint,
            saves smallint, source_game_id text, source_team_name text, source_player_name text,
            source_player_key text, content_hash text
        ) ON COMMIT DROP`);
    for (const part of chunks(rows)) {
        await client.query(
            `INSERT INTO _batch_stats
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
                 game_id bigint, player_id bigint, team_id int, jersey_number text, jersey_key text,
                 minutes smallint, goals smallint, assists smallint, shots smallint, shots_on_goal smallint,
                 saves smallint, source_game_id text, source_team_name text, source_player_name text,
                 source_player_key text, content_hash text)`,
            [JSON.stringify(part)]
        );
    }
    await client.query('CREATE INDEX ON _batch_stats (game_id, player_id, jersey_key)');
    await client.query('ANALYZE _batch_stats');

    const upserted = await client.query<{ inserted: string; updated: string }>(
        `WITH up AS (
             INSERT INTO player_game_stats (game_id, player_id, team_id, season_id, jersey_number, jersey_key,
                 minutes, goals, assists, shots, shots_on_goal, saves, source_game_id, source_team_name,
                 source_player_name, source_player_key, content_hash)
             SELECT game_id, player_id, team_id, $1, jersey_number, jersey_key, minutes, goals, assists,
                    shots, shots_on_goal, saves, source_game_id, source_team_name, source_player_name,
                    source_player_key, content_hash
             FROM _batch_stats
             ON CONFLICT (game_id, player_id, jersey_key) DO UPDATE SET
                 team_id = EXCLUDED.team_id,
                 jersey_number = EXCLUDED.jersey_number,
                 minutes = EXCLUDED.minutes,
                 goals = EXCLUDED.goals,
                 assists = EXCLUDED.assists,
                 shots = EXCLUDED.shots,
                 shots_on_goal = EXCLUDED.shots_on_goal,
                 saves = EXCLUDED.saves,
                 source_game_id = EXCLUDED.source_game_id,
                 source_team_name = EXCLUDED.source_team_name,
                 source_player_name = EXCLUDED.source_player_name,
                 source_player_key = EXCLUDED.source_player_key,
                 content_hash = EXCLUDED.content_hash,
                 updated_at = now()
             WHERE player_game_stats.content_hash IS DISTINCT FROM EXCLUDED.content_hash
             RETURNING (xmax = 0) AS inserted
         )
         SELECT count(*) FILTER (WHERE inserted) AS inserted, count(*) FILTER (WHERE NOT inserted) AS updated FROM up`,
        [seasonId]
    );
    counts.inserted = Number(upserted.rows[0].inserted);
    counts.updated = Number(upserted.rows[0].updated);
    counts.unchanged = rows.length - counts.inserted - counts.updated;

    // A box score that was re-read replaces what was stored for that side of that game:
    // a player the school has since removed goes. Only (game, team) pairs present in the
    // batch are touched, so a side whose fetch failed keeps its earlier rows.
    const removed = await client.query(
        `DELETE FROM player_game_stats p
         USING (SELECT DISTINCT game_id, team_id FROM _batch_stats) b
         WHERE p.game_id = b.game_id AND p.team_id = b.team_id
           AND NOT EXISTS (
               SELECT 1 FROM _batch_stats s
               WHERE s.game_id = p.game_id AND s.player_id = p.player_id AND s.jersey_key = p.jersey_key)`
    );
    counts.deleted = removed.rowCount ?? 0;
    return counts;
}

/** Rebuilds per-team totals and box-score coverage for a season. */
async function recomputeTeamGameStats(client: PoolClient, seasonId: number): Promise<void> {
    // Statistics for the rows this transaction just wrote. Without them a first load
    // plans these joins as if the tables were empty, and nested-loops its way into the
    // statement timeout.
    // Through a SECURITY DEFINER function: ANALYZE needs ownership, the worker has none.
    await client.query('SELECT ncadb_analyze_ingestion_tables()');
    await client.query(
        `INSERT INTO team_game_stats (game_id, team_id, players, minutes, goals, assists, shots,
                                      shots_on_goal, saves, reported_score, goals_reconciliation, updated_at)
         SELECT t.game_id, t.team_id, t.players, t.minutes, t.goals, t.assists, t.shots, t.shots_on_goal,
                t.saves, t.reported_score,
                CASE
                    WHEN t.reported_score IS NULL OR t.goals IS NULL THEN 'unknown'
                    WHEN t.goals = t.reported_score THEN 'ok'
                    WHEN t.goals < t.reported_score THEN 'unattributed'
                    ELSE 'excess'
                END,
                now()
         FROM (
             SELECT s.game_id, s.team_id,
                    count(*)::smallint AS players,
                    sum(s.minutes)::int AS minutes,
                    sum(s.goals)::smallint AS goals,
                    sum(s.assists)::smallint AS assists,
                    sum(s.shots)::smallint AS shots,
                    sum(s.shots_on_goal)::smallint AS shots_on_goal,
                    sum(s.saves)::smallint AS saves,
                    CASE WHEN s.team_id = g.home_team_id THEN g.home_score
                         WHEN s.team_id = g.away_team_id THEN g.away_score END AS reported_score
             FROM player_game_stats s
             JOIN games g ON g.id = s.game_id
             WHERE s.season_id = $1
             GROUP BY s.game_id, s.team_id, g.home_team_id, g.away_team_id, g.home_score, g.away_score
         ) t
         ON CONFLICT (game_id, team_id) DO UPDATE SET
             players = EXCLUDED.players, minutes = EXCLUDED.minutes, goals = EXCLUDED.goals,
             assists = EXCLUDED.assists, shots = EXCLUDED.shots, shots_on_goal = EXCLUDED.shots_on_goal,
             saves = EXCLUDED.saves, reported_score = EXCLUDED.reported_score,
             goals_reconciliation = EXCLUDED.goals_reconciliation, updated_at = now()
         WHERE (team_game_stats.players, team_game_stats.minutes, team_game_stats.goals, team_game_stats.assists,
                team_game_stats.shots, team_game_stats.shots_on_goal, team_game_stats.saves,
                team_game_stats.reported_score, team_game_stats.goals_reconciliation)
            IS DISTINCT FROM
               (EXCLUDED.players, EXCLUDED.minutes, EXCLUDED.goals, EXCLUDED.assists, EXCLUDED.shots,
                EXCLUDED.shots_on_goal, EXCLUDED.saves, EXCLUDED.reported_score, EXCLUDED.goals_reconciliation)`,
        [seasonId]
    );
    await client.query(
        `DELETE FROM team_game_stats t USING games g
         WHERE g.id = t.game_id AND g.season_id = $1
           AND NOT EXISTS (SELECT 1 FROM player_game_stats s WHERE s.game_id = t.game_id AND s.team_id = t.team_id)`,
        [seasonId]
    );
    await client.query(
        `UPDATE games g SET boxscore_status = x.status
         FROM (
             SELECT g2.id,
                    CASE count(DISTINCT t.team_id) FILTER (WHERE t.team_id IN (g2.home_team_id, g2.away_team_id))
                        WHEN 0 THEN 'none' WHEN 1 THEN 'partial' ELSE 'complete' END AS status
             FROM games g2 LEFT JOIN team_game_stats t ON t.game_id = g2.id
             WHERE g2.season_id = $1
             GROUP BY g2.id
         ) x
         WHERE g.id = x.id AND g.boxscore_status <> x.status`,
        [seasonId]
    );
}

async function upsertTeamSeasons(client: PoolClient, seasonId: number): Promise<void> {
    await client.query(
        `INSERT INTO team_seasons (team_id, season_id, conference_id)
         SELECT DISTINCT t.id, $1::int, t.conference_id
         FROM games g JOIN teams t ON t.id IN (g.home_team_id, g.away_team_id)
         WHERE g.season_id = $1::int
         ON CONFLICT (team_id, season_id) DO UPDATE SET conference_id = EXCLUDED.conference_id
         WHERE team_seasons.conference_source = 'inventory_current'
           AND team_seasons.conference_id IS DISTINCT FROM EXCLUDED.conference_id`,
        [seasonId]
    );
}

async function upsertPlayerTeamSeasons(client: PoolClient, seasonId: number): Promise<void> {
    await client.query(
        `INSERT INTO player_team_seasons (player_id, team_id, season_id, jersey_number)
         SELECT DISTINCT ON (player_id, team_id) player_id, team_id, $1, jersey_number
         FROM _batch_stats
         ORDER BY player_id, team_id, (jersey_number IS NULL), jersey_number
         ON CONFLICT (player_id, team_id, season_id) DO UPDATE SET
             jersey_number = COALESCE(EXCLUDED.jersey_number, player_team_seasons.jersey_number)
         WHERE player_team_seasons.jersey_number IS DISTINCT FROM COALESCE(EXCLUDED.jersey_number, player_team_seasons.jersey_number)`,
        [seasonId]
    );
}

function issue(
    code: string,
    message: string,
    samples: unknown[],
    count: number,
    severity: QualityIssue['severity'] = 'warning',
    category: QualityIssue['category'] = 'validation'
): QualityIssue {
    return { category, severity, code, message, count, samples: samples.slice(0, 10) };
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

export async function loadSeason(pool: Pool, batch: SeasonBatch): Promise<LoadResult> {
    return withTransaction(pool, async client => {
        const sport = await sportId(client);
        const seasonId = await ensureSeason(client, batch.season);
        const issues: QualityIssue[] = [];

        const { ids: teamIds, inserted: teamsInserted } = await upsertTeams(client, sport, batch.teams);
        await recordSpellings(client, batch.teamSpellings, teamIds);

        const { games: merged, unresolved } = mergeFixtures(batch.games, teamIds);
        if (unresolved.length > 0) {
            issues.push(
                issue(
                    'unresolved_fixture_team',
                    'Schedule rows whose teams did not resolve to two distinct teams',
                    unresolved.map(u => u.payload),
                    unresolved.length,
                    'error'
                )
            );
        }
        const conflicts = merged.filter(g => g.qualityFlags.includes('score_conflict'));
        if (conflicts.length > 0) {
            issues.push(
                issue(
                    'score_conflict',
                    'Fixtures whose two schools report different final scores (primary source kept)',
                    conflicts.map(g => ({ date: g.date, sources: g.sources.map(s => s.payload) })),
                    conflicts.length,
                    'warning',
                    'reconciliation'
                )
            );
        }

        const { ids: gameIds, counts: gameCounts } = await upsertGames(client, seasonId, merged);
        const sourceCounts = await upsertGameSources(client, seasonId, merged, gameIds, batch.complete, !!batch.allowMassDelete);

        // Which game each box-score row points at. Built from the database rather than
        // the batch, so a partial batch can still attach stats to games loaded earlier.
        const { rows: sourceRows } = await client.query<{ source_game_id: string; game_ids: string[] }>(
            `SELECT source_game_id, array_agg(DISTINCT game_id) AS game_ids
             FROM game_sources WHERE season_id = $1 GROUP BY source_game_id`,
            [seasonId]
        );
        const bySourceId = new Map(sourceRows.map(r => [r.source_game_id, r.game_ids.map(Number)]));

        const { rows: gameTeams } = await client.query<{ id: string; home_team_id: number; away_team_id: number }>(
            'SELECT id, home_team_id, away_team_id FROM games WHERE season_id = $1',
            [seasonId]
        );
        const sides = new Map(gameTeams.map(g => [Number(g.id), [g.home_team_id, g.away_team_id]]));

        // Rows are matched to their game first, so a rejected row never creates a player.
        const unknownGame: PlayerStatRecord[] = [];
        const ambiguousGame: PlayerStatRecord[] = [];
        const accepted: { record: PlayerStatRecord; gameId: number }[] = [];
        for (const s of batch.stats) {
            const candidates = bySourceId.get(s.sourceGameId);
            if (!candidates) unknownGame.push(s);
            else if (candidates.length > 1) ambiguousGame.push(s);
            else accepted.push({ record: s, gameId: candidates[0] });
        }

        const { ids: playerIds, inserted: playersInserted } = await upsertPlayers(
            client,
            sport,
            accepted.map(a => a.record),
            teamIds
        );

        const statRows = new Map<string, StatRow>();
        const wrongSide: PlayerStatRecord[] = [];
        let duplicates = 0;
        for (const { record: s, gameId } of accepted) {
            const teamId = teamIds.get(s.teamSlug)!;
            const playerId = playerIds.get(s.identityKey)!;
            if (!sides.get(gameId)?.includes(teamId)) wrongSide.push(s);

            const jerseyKey = s.jerseyNumber ?? '';
            const content = [teamId, s.jerseyNumber, s.minutes, s.goals, s.assists, s.shots, s.shotsOnGoal, s.saves,
                s.sourceGameId, s.sourceTeamName, s.sourcePlayerName, s.sourcePlayerKey];
            const key = `${gameId}|${playerId}|${jerseyKey}`;
            if (statRows.has(key)) duplicates++;
            statRows.set(key, {
                game_id: gameId,
                player_id: playerId,
                team_id: teamId,
                jersey_number: s.jerseyNumber,
                jersey_key: jerseyKey,
                minutes: s.minutes,
                goals: s.goals,
                assists: s.assists,
                shots: s.shots,
                shots_on_goal: s.shotsOnGoal,
                saves: s.saves,
                source_game_id: s.sourceGameId,
                source_team_name: s.sourceTeamName,
                source_player_name: s.sourcePlayerName,
                source_player_key: s.sourcePlayerKey,
                content_hash: hashOf(content)
            });
        }
        if (unknownGame.length > 0) {
            issues.push(issue('stat_unknown_game', 'Box-score rows pointing at a game id no schedule row carries',
                unknownGame.map(s => ({ game: s.sourceGameId, player: s.sourcePlayerKey })), unknownGame.length, 'error'));
        }
        if (ambiguousGame.length > 0) {
            issues.push(issue('stat_ambiguous_game', 'Box-score rows whose game id is shared by two fixtures',
                ambiguousGame.map(s => ({ game: s.sourceGameId, player: s.sourcePlayerKey })), ambiguousGame.length, 'error'));
        }
        if (wrongSide.length > 0) {
            issues.push(issue('stat_team_not_in_fixture', 'Box-score rows whose team resolved to neither side of the fixture (kept)',
                wrongSide.map(s => ({ game: s.sourceGameId, team: s.sourceTeamName })), wrongSide.length));
        }
        if (duplicates > 0) {
            issues.push(issue('duplicate_stat_row', 'Repeated player rows within one box score (collapsed to one)', [], duplicates));
        }

        const statCounts = await upsertStats(client, seasonId, [...statRows.values()]);
        await upsertPlayerTeamSeasons(client, seasonId);
        await recomputeTeamGameStats(client, seasonId);
        await upsertTeamSeasons(client, seasonId);

        const { rows: excess } = await client.query(
            `SELECT g.game_date::text AS date, t.name AS team, tg.goals, tg.reported_score
             FROM team_game_stats tg JOIN games g ON g.id = tg.game_id JOIN teams t ON t.id = tg.team_id
             WHERE g.season_id = $1 AND tg.goals_reconciliation = 'excess'
             ORDER BY g.game_date LIMIT 10`,
            [seasonId]
        );
        if (excess.length > 0) {
            const { rows: total } = await client.query<{ n: string }>(
                `SELECT count(*) AS n FROM team_game_stats tg JOIN games g ON g.id = tg.game_id
                 WHERE g.season_id = $1 AND tg.goals_reconciliation = 'excess'`,
                [seasonId]
            );
            issues.push(issue('goals_exceed_score', 'Teams whose players scored more goals than the reported score',
                excess, Number(total[0].n), 'warning', 'reconciliation'));
        }

        return {
            season: batch.season,
            games: gameCounts,
            gameSources: sourceCounts,
            playerStats: statCounts,
            players: { inserted: playersInserted },
            teams: { inserted: teamsInserted },
            issues
        };
    });
}

/** Rebuilds the read models the API's leaderboards and records come from. */
export async function refreshReadModels(pool: Pool): Promise<void> {
    // Through a SECURITY DEFINER function: refreshing a view needs ownership.
    await pool.query('SELECT ncadb_refresh_read_models()');
}
