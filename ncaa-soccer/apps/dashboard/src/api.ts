/**
 * Everything the site knows, it gets from the NCADB API.
 *
 * `VITE_API_BASE_URL` is the API's origin (`https://ncadb-api.up.railway.app`). Left
 * empty, requests are relative — which is what the dev server's proxy expects.
 */

import { useEffect, useState } from 'react';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export class ApiRequestError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

type Params = Record<string, string | number | boolean | null | undefined>;

export function apiUrl(path: string, params: Params = {}): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
    const query = search.toString();
    return `${API_BASE}${path}${query ? `?${query}` : ''}`;
}

export async function apiGet<T>(path: string, params: Params = {}, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
        response = await fetch(apiUrl(path, params), { ...init, headers: { Accept: 'application/json', ...init.headers } });
    } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        throw new ApiRequestError(0, 'The data service could not be reached.');
    }
    if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
            const body = await response.json();
            message = body?.error?.message ?? message;
        } catch {
            /* not JSON */
        }
        throw new ApiRequestError(response.status, message);
    }
    return response.json() as Promise<T>;
}

/** One of the analytics files the worker derives nightly (`analytics/index.json`, ...). */
export function artifact<T>(key: string): Promise<T> {
    return apiGet<T>(`/api/v1/artifacts/${key}`);
}

export interface Paged<T> {
    data: T[];
    pagination: { page: number; page_size: number; total: number; pages: number };
}

export interface ApiState<T> {
    data: T | null;
    error: string | null;
    loading: boolean;
}

/**
 * Fetches `path` with `params`, refetching when either changes.
 *
 * A response for a request that has since been superseded is dropped, so quick filter
 * changes can never leave the page showing an older answer than the controls describe.
 * Pass `null` as the path to fetch nothing.
 */
export function useApi<T>(path: string | null, params: Params = {}): ApiState<T> {
    const key = path === null ? null : apiUrl(path, params);
    const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({
        key: null,
        data: null,
        error: null
    });

    useEffect(() => {
        if (key === null) return;
        const controller = new AbortController();
        fetch(key, { signal: controller.signal, headers: { Accept: 'application/json' } })
            .then(async response => {
                const body = await response.json().catch(() => null);
                if (!response.ok) throw new ApiRequestError(response.status, body?.error?.message ?? `Request failed (${response.status})`);
                setState({ key, data: body as T, error: null });
            })
            .catch(err => {
                if ((err as Error).name === 'AbortError') return;
                const message =
                    err instanceof ApiRequestError ? err.message : 'The data service could not be reached.';
                setState({ key, data: null, error: message });
            });
        return () => controller.abort();
    }, [key]);

    const current = state.key === key;
    return {
        data: current ? state.data : null,
        error: current ? state.error : null,
        loading: key !== null && !current
    };
}
