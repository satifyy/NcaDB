/**
 * Where sign-in lives and whether it is switched on.
 *
 * The statistics are hash-routed (`/ncadb/#/teams/duke`) so the site stays a static
 * bundle. Account pages are real paths under the same base (`/ncadb/login`,
 * `/ncadb/profile`), because those are the addresses OAuth providers and emails link
 * back to; Vercel rewrites them to index.html (see vercel.json).
 *
 * Without VITE_CLERK_PUBLISHABLE_KEY the site builds and runs exactly as before: no
 * login button, no Clerk script, and the account pages say sign-in is unavailable.
 */

export const CLERK_PUBLISHABLE_KEY: string = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '';
export const authEnabled = /^pk_(test|live)_/.test(CLERK_PUBLISHABLE_KEY);

/** `/ncadb/` in production, `/` for a local build without BASE_PATH. Always ends in `/`. */
export const BASE = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;

export const AUTH_PAGES = ['login', 'signup', 'profile', 'dashboard', 'admin'] as const;
export type AuthPage = (typeof AUTH_PAGES)[number];

/** `login` for `/ncadb/login` or `/ncadb/login/`, null for the statistics app. */
export function authPageFromPath(pathname: string): AuthPage | null {
    if (!pathname.startsWith(BASE)) return null;
    const rest = pathname.slice(BASE.length).replace(/\/+$/, '');
    return (AUTH_PAGES as readonly string[]).includes(rest) ? (rest as AuthPage) : null;
}

export const pagePath = (page: AuthPage) => `${BASE}${page}`;

/** Absolute URL of an account page, for redirects that leave the site and come back. */
export const absoluteUrl = (path: string) => new URL(path, window.location.origin).toString();
