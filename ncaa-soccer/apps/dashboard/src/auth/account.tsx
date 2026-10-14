/**
 * Loads the signed-in user's profile and favorites once per session and keeps them in
 * step with saves and removals, so every "save" button on the site reads one shared copy.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AccountContext, accountRequest } from './account-api';
import type { Account, FavoritePlayer, FavoriteTeam, Profile } from './account-api';
import { useSession } from './session-context';

interface Loaded {
    /** Which load this is the answer to; a stale answer is ignored. */
    key: string;
    profile: Profile | null;
    teams: FavoriteTeam[];
    players: FavoritePlayer[];
    error: string | null;
}

// Stable empties, so "nothing saved" does not look like a change on every render.
const NO_TEAMS: FavoriteTeam[] = [];
const NO_PLAYERS: FavoritePlayer[] = [];

export function AccountProvider({ children }: { children: ReactNode }) {
    const { signedIn, getToken } = useSession();
    const [generation, setGeneration] = useState(0);
    const [state, setState] = useState<Loaded | null>(null);
    // Signed out: nothing to load. Signed in: one load per generation (reload() bumps it).
    const key = signedIn ? `load-${generation}` : null;

    useEffect(() => {
        if (key === null) return;
        let cancelled = false;
        Promise.all([
            accountRequest<{ data: Profile }>(getToken, 'GET', '/api/v1/me'),
            accountRequest<{ data: FavoriteTeam[] }>(getToken, 'GET', '/api/v1/me/favorites/teams'),
            accountRequest<{ data: FavoritePlayer[] }>(getToken, 'GET', '/api/v1/me/favorites/players')
        ])
            .then(([profile, teams, players]) => {
                if (!cancelled) setState({ key, profile: profile.data, teams: teams.data, players: players.data, error: null });
            })
            .catch((err: Error) => {
                if (!cancelled) setState({ key, profile: null, teams: [], players: [], error: err.message });
            });
        return () => {
            cancelled = true;
        };
    }, [key, getToken]);

    const current = key !== null && state?.key === key ? state : null;
    const teams = current?.teams ?? NO_TEAMS;
    const players = current?.players ?? NO_PLAYERS;
    const update = (change: (s: Loaded) => Loaded) => setState(s => (s ? change(s) : s));

    const toggleTeam = useCallback(
        async (slug: string) => {
            if (teams.some(t => t.slug === slug)) {
                await accountRequest(getToken, 'DELETE', `/api/v1/me/favorites/teams/${encodeURIComponent(slug)}`);
                update(s => ({ ...s, teams: s.teams.filter(t => t.slug !== slug) }));
            } else {
                const res = await accountRequest<{ data: Omit<FavoriteTeam, 'saved_at'> }>(
                    getToken,
                    'PUT',
                    `/api/v1/me/favorites/teams/${encodeURIComponent(slug)}`
                );
                update(s => ({ ...s, teams: [...s.teams, { ...res.data, saved_at: new Date().toISOString() }] }));
            }
        },
        [getToken, teams]
    );

    const togglePlayer = useCallback(
        async (id: number) => {
            if (players.some(p => p.id === id)) {
                await accountRequest(getToken, 'DELETE', `/api/v1/me/favorites/players/${id}`);
                update(s => ({ ...s, players: s.players.filter(p => p.id !== id) }));
            } else {
                const res = await accountRequest<{ data: Omit<FavoritePlayer, 'saved_at'> }>(
                    getToken,
                    'PUT',
                    `/api/v1/me/favorites/players/${id}`
                );
                update(s => ({ ...s, players: [...s.players, { ...res.data, saved_at: new Date().toISOString() }] }));
            }
        },
        [getToken, players]
    );

    const value = useMemo<Account>(
        () => ({
            profile: current?.profile ?? null,
            teams,
            players,
            loading: key !== null && current === null,
            error: current?.error ?? null,
            reload: () => setGeneration(g => g + 1),
            setProfile: profile => update(s => ({ ...s, profile })),
            isFavoriteTeam: slug => teams.some(t => t.slug === slug),
            isFavoritePlayer: id => players.some(p => p.id === id),
            toggleTeam,
            togglePlayer
        }),
        [current, teams, players, key, toggleTeam, togglePlayer]
    );
    return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
