/**
 * Signed-in API calls, the account data shapes, and the context/hook for them. The
 * provider that loads the data is in account.tsx (a component module, so React Fast
 * Refresh keeps working).
 *
 * Every call asks Clerk for the current session token just before it is sent; Clerk
 * returns a cached one until it is close to expiry, so this costs nothing and a token is
 * never kept around in our own state.
 */

import { createContext, useContext } from 'react';
import { ApiRequestError, apiUrl } from '../api';

export interface Profile {
    user_id: string;
    display_name: string | null;
    role: 'user' | 'admin';
    created_at: string;
    preferences: Preferences;
}

export interface Preferences {
    default_season: number | null;
    default_view: string | null;
    favorites_first: boolean;
}

export interface FavoriteTeam {
    id: number;
    slug: string;
    name: string;
    saved_at: string;
}

export interface FavoritePlayer {
    id: number;
    name: string;
    saved_at: string;
}

type Token = () => Promise<string | null>;

/** A signed-in API call. Throws ApiRequestError; 401 means the session is gone. */
export async function accountRequest<T>(getToken: Token, method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiRequestError(401, 'Sign in to continue.');
    let response: Response;
    try {
        response = await fetch(apiUrl(path), {
            method,
            // No cookies are sent or accepted: the token is the only credential.
            credentials: 'omit',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch {
        throw new ApiRequestError(0, 'The data service could not be reached.');
    }
    if (response.status === 204) return undefined as T;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new ApiRequestError(response.status, payload?.error?.message ?? `Request failed (${response.status})`);
    }
    return payload as T;
}

export interface Account {
    profile: Profile | null;
    teams: FavoriteTeam[];
    players: FavoritePlayer[];
    loading: boolean;
    error: string | null;
    reload(): void;
    setProfile(profile: Profile): void;
    isFavoriteTeam(slug: string): boolean;
    isFavoritePlayer(id: number): boolean;
    toggleTeam(slug: string): Promise<void>;
    togglePlayer(id: number): Promise<void>;
}

export const empty: Account = {
    profile: null,
    teams: [],
    players: [],
    loading: false,
    error: null,
    reload: () => undefined,
    setProfile: () => undefined,
    isFavoriteTeam: () => false,
    isFavoritePlayer: () => false,
    toggleTeam: async () => undefined,
    togglePlayer: async () => undefined
};

export const AccountContext = createContext<Account>(empty);
export const useAccount = () => useContext(AccountContext);

