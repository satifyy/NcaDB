/**
 * Hash routing: `#/teams/duke`, `#/games/20851`, `#/rankings`.
 *
 * A hash rather than a path so the site is a plain static bundle on any host — no
 * rewrite rules — and every team, game and player page is a link that can be shared.
 */

import { useEffect, useState } from 'react';
import { VIEWS } from './views';
import type { ViewId } from './views';

export interface Route {
    view: ViewId;
    /** The record a detail page shows: a team slug, a game id, a player id. */
    id: string | null;
}

const KNOWN = new Set<string>(VIEWS.map(v => v.id));

export function parseHash(hash: string, fallback: ViewId): Route {
    const [view, id] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    return KNOWN.has(view) ? { view: view as ViewId, id: id || null } : { view: fallback, id: null };
}

/** On the statistics page a bare hash; on an account page (`/ncadb/profile`) the base path too. */
function prefix(): string {
    const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
    return typeof window !== 'undefined' && window.location.pathname !== base ? base : '';
}

export function href(view: ViewId, id?: string | number | null): string {
    const hash = id === undefined || id === null ? `#/${view}` : `#/${view}/${encodeURIComponent(String(id))}`;
    return `${prefix()}${hash}`;
}

export function useRoute(fallback: ViewId): Route {
    const [route, setRoute] = useState(() => parseHash(window.location.hash, fallback));
    useEffect(() => {
        const onChange = () => {
            setRoute(parseHash(window.location.hash, fallback));
            window.scrollTo({ top: 0 });
        };
        window.addEventListener('hashchange', onChange);
        return () => window.removeEventListener('hashchange', onChange);
    }, [fallback]);
    return route;
}

export function navigate(view: ViewId, id?: string | number | null): void {
    const target = href(view, id);
    if (target.startsWith('#')) window.location.hash = target;
    else window.location.assign(target);
}
