/**
 * The signed-in user's own data: profile, preferences, favorite teams and players.
 *
 * Every route acts on `request.principal`, which comes from the verified token. No route
 * takes a user id from the client, so one user cannot name, read or change another's data.
 * Queries run as ncadb_accounts, which can reach only the accounts schema and read
 * teams/players; the public sports pool is not used here.
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { audit, Authenticator, Principal, requireUser } from '../auth';
import { ApiError, notFound, teamIdParam } from '../http';

/** Enough for any real fan; a bound so a script cannot grow one profile without limit. */
export const MAX_FAVORITES = 100;

const me = (request: FastifyRequest): Principal => request.principal!;

const profileBody = {
    type: 'object',
    additionalProperties: false,
    properties: {
        display_name: { type: ['string', 'null'], minLength: 1, maxLength: 80, pattern: '^[^<>\\u0000-\\u001f]*$' }
    }
} as const;

const preferencesBody = {
    type: 'object',
    additionalProperties: false,
    properties: {
        default_season: { type: ['integer', 'null'], minimum: 2000, maximum: 2100 },
        default_view: { type: ['string', 'null'], pattern: '^[a-z-]{1,40}$' },
        favorites_first: { type: 'boolean' }
    }
} as const;

export async function meRoutes(app: FastifyInstance, opts: { accounts: Pool; auth: Authenticator }) {
    const { accounts, auth } = opts;

    app.addHook('onRoute', routeOptions => {
        // Writes get a tighter budget than the global per-address limit.
        if (routeOptions.method !== 'GET' && routeOptions.method !== 'HEAD') {
            routeOptions.config = { ...(routeOptions.config as object), rateLimit: { max: 60, timeWindow: '1 minute' } };
        }
        routeOptions.schema = { ...routeOptions.schema, tags: ['me'], security: [{ session: [] }] };
    });
    app.addHook('preHandler', requireUser(auth));

    async function profile(userId: number) {
        const { rows } = await accounts.query(
            `SELECT p.auth_subject AS user_id, p.display_name, p.role, p.created_at,
                    pref.default_season, pref.default_view,
                    coalesce(pref.favorites_first, true) AS favorites_first
             FROM accounts.user_profiles p
             LEFT JOIN accounts.user_preferences pref ON pref.user_id = p.id
             WHERE p.id = $1`,
            [userId]
        );
        const row = rows[0];
        if (!row) throw notFound('Profile');
        return {
            user_id: row.user_id,
            display_name: row.display_name,
            role: row.role,
            created_at: row.created_at,
            preferences: { default_season: row.default_season, default_view: row.default_view, favorites_first: row.favorites_first }
        };
    }

    app.get('/api/v1/me', { schema: { summary: 'The signed-in user’s profile and preferences' } }, async request => ({
        data: await profile(me(request).userId)
    }));

    app.patch<{ Body: { display_name?: string | null } }>(
        '/api/v1/me',
        { schema: { summary: 'Update the signed-in user’s profile', body: profileBody } },
        async request => {
            const p = me(request);
            if (request.body.display_name !== undefined) {
                const name = request.body.display_name === null ? null : request.body.display_name.trim() || null;
                await accounts.query('UPDATE accounts.user_profiles SET display_name = $2, updated_at = now() WHERE id = $1', [
                    p.userId,
                    name
                ]);
                await audit(accounts, request, p, 'profile.updated', { fields: ['display_name'] });
            }
            return { data: await profile(p.userId) };
        }
    );

    app.delete('/api/v1/me', { schema: { summary: 'Delete the signed-in user’s NCADB profile data' } }, async (request, reply) => {
        const p = me(request);
        // Audit first: the row's user_id is nulled by the delete, the subject is kept.
        await audit(accounts, request, p, 'account.deleted');
        await accounts.query('DELETE FROM accounts.user_profiles WHERE id = $1', [p.userId]);
        return reply.code(204).send();
    });

    app.put<{ Body: { default_season?: number | null; default_view?: string | null; favorites_first?: boolean } }>(
        '/api/v1/me/preferences',
        { schema: { summary: 'Replace the signed-in user’s preferences', body: preferencesBody } },
        async request => {
            const p = me(request);
            const b = request.body;
            await accounts.query(
                `INSERT INTO accounts.user_preferences (user_id, default_season, default_view, favorites_first, updated_at)
                 VALUES ($1, $2, $3, $4, now())
                 ON CONFLICT (user_id) DO UPDATE SET default_season = EXCLUDED.default_season,
                     default_view = EXCLUDED.default_view, favorites_first = EXCLUDED.favorites_first, updated_at = now()`,
                [p.userId, b.default_season ?? null, b.default_view ?? null, b.favorites_first ?? true]
            );
            await audit(accounts, request, p, 'preferences.updated');
            return { data: (await profile(p.userId)).preferences };
        }
    );

    // ----- favorite teams -------------------------------------------------------------

    app.get('/api/v1/me/favorites/teams', { schema: { summary: 'The signed-in user’s favorite teams' } }, async request => {
        const { rows } = await accounts.query(
            `SELECT t.id::int, t.slug, t.name, f.created_at AS saved_at
             FROM accounts.user_favorite_teams f JOIN public.teams t ON t.id = f.team_id
             WHERE f.user_id = $1 ORDER BY f.created_at`,
            [me(request).userId]
        );
        return { data: rows };
    });

    async function resolveTeam(id: string): Promise<{ id: number; slug: string; name: string }> {
        const { rows } = await accounts.query(
            /^[0-9]+$/.test(id)
                ? 'SELECT id::int, slug, name FROM public.teams WHERE id = $1'
                : 'SELECT id::int, slug, name FROM public.teams WHERE slug = $1 ORDER BY id LIMIT 1',
            [id]
        );
        if (!rows[0]) throw notFound('Team');
        return rows[0];
    }

    async function assertRoom(table: 'user_favorite_teams' | 'user_favorite_players', userId: number) {
        const { rows } = await accounts.query(`SELECT count(*)::int AS n FROM accounts.${table} WHERE user_id = $1`, [userId]);
        if (rows[0].n >= MAX_FAVORITES) throw new ApiError(409, 'too_many_favorites', `At most ${MAX_FAVORITES} favorites`);
    }

    app.put<{ Params: { id: string } }>(
        '/api/v1/me/favorites/teams/:id',
        { schema: { summary: 'Save a favorite team (idempotent)', params: teamIdParam } },
        async (request, reply) => {
            const p = me(request);
            const team = await resolveTeam(request.params.id);
            await assertRoom('user_favorite_teams', p.userId);
            const { rowCount } = await accounts.query(
                'INSERT INTO accounts.user_favorite_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [p.userId, team.id]
            );
            if (rowCount) await audit(accounts, request, p, 'favorite_team.added', { team_id: team.id });
            return reply.code(rowCount ? 201 : 200).send({ data: team });
        }
    );

    app.delete<{ Params: { id: string } }>(
        '/api/v1/me/favorites/teams/:id',
        { schema: { summary: 'Remove a favorite team', params: teamIdParam } },
        async (request, reply) => {
            const p = me(request);
            const team = await resolveTeam(request.params.id);
            const { rowCount } = await accounts.query('DELETE FROM accounts.user_favorite_teams WHERE user_id = $1 AND team_id = $2', [
                p.userId,
                team.id
            ]);
            if (rowCount) await audit(accounts, request, p, 'favorite_team.removed', { team_id: team.id });
            return reply.code(204).send();
        }
    );

    // ----- favorite players -----------------------------------------------------------

    const playerParam = {
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1, maximum: 9_007_199_254_740_991 } },
        required: ['id']
    } as const;

    app.get('/api/v1/me/favorites/players', { schema: { summary: 'The signed-in user’s favorite players' } }, async request => {
        const { rows } = await accounts.query(
            // display_name, as every public route shows it ("Ana Scorer", not "Scorer, Ana").
            `SELECT pl.id::int, pl.display_name AS name, f.created_at AS saved_at
             FROM accounts.user_favorite_players f JOIN public.players pl ON pl.id = f.player_id
             WHERE f.user_id = $1 ORDER BY f.created_at`,
            [me(request).userId]
        );
        return { data: rows };
    });

    app.put<{ Params: { id: number } }>(
        '/api/v1/me/favorites/players/:id',
        { schema: { summary: 'Save a favorite player (idempotent)', params: playerParam } },
        async (request, reply) => {
            const p = me(request);
            const { rows } = await accounts.query('SELECT id::int, display_name AS name FROM public.players WHERE id = $1', [request.params.id]);
            if (!rows[0]) throw notFound('Player');
            await assertRoom('user_favorite_players', p.userId);
            const { rowCount } = await accounts.query(
                'INSERT INTO accounts.user_favorite_players (user_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [p.userId, rows[0].id]
            );
            if (rowCount) await audit(accounts, request, p, 'favorite_player.added', { player_id: rows[0].id });
            return reply.code(rowCount ? 201 : 200).send({ data: rows[0] });
        }
    );

    app.delete<{ Params: { id: number } }>(
        '/api/v1/me/favorites/players/:id',
        { schema: { summary: 'Remove a favorite player', params: playerParam } },
        async (request, reply) => {
            const p = me(request);
            const { rowCount } = await accounts.query(
                'DELETE FROM accounts.user_favorite_players WHERE user_id = $1 AND player_id = $2',
                [p.userId, request.params.id]
            );
            if (rowCount) await audit(accounts, request, p, 'favorite_player.removed', { player_id: request.params.id });
            return reply.code(204).send();
        }
    );
}
