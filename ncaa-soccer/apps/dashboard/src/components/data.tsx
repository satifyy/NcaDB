/**
 * Small pieces the database-backed views share: load states, a pager, result badges,
 * and number formatting that shows a missing value as missing rather than as zero.
 */

import type { ReactNode } from 'react';
import type { ApiState } from '../api';
import { href } from '../route';
import type { ViewId } from '../views';
import { num } from '../format';
import { Notice } from './ui';

/** Renders loading, error and empty states, or `children(data)` once there is data. */
export function Loaded<T>({
    state,
    children,
    empty,
    isEmpty
}: {
    state: ApiState<T>;
    children: (data: T) => ReactNode;
    empty?: ReactNode;
    isEmpty?: (data: T) => boolean;
}) {
    if (state.error) return <Notice>{state.error}</Notice>;
    if (state.loading || state.data === null) {
        return (
            <div className="loading" role="status" aria-live="polite">
                Loading…
            </div>
        );
    }
    if (isEmpty?.(state.data)) return <div className="empty-state">{empty ?? 'Nothing to show.'}</div>;
    return <>{children(state.data)}</>;
}

export function Pager({
    page,
    pages,
    total,
    onPage
}: {
    page: number;
    pages: number;
    total: number;
    onPage: (page: number) => void;
}) {
    if (pages <= 1) return <div className="pager text-muted text-sm">{num(total)} total</div>;
    return (
        <nav className="pager" aria-label="Pages">
            <button type="button" className="pager-button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
                Previous
            </button>
            <span className="text-sm text-muted">
                Page {page} of {num(pages)} · {num(total)} total
            </span>
            <button type="button" className="pager-button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
                Next
            </button>
        </nav>
    );
}

export function ResultBadge({ result }: { result: 'W' | 'D' | 'L' | null }) {
    if (!result) return <span className="text-muted">—</span>;
    const cls = result === 'W' ? 'is-win' : result === 'L' ? 'is-loss' : 'is-draw';
    return (
        <span className={`badge ${cls}`} aria-label={{ W: 'Win', D: 'Draw', L: 'Loss' }[result]}>
            {result}
        </span>
    );
}

export function Link({ view, id, children }: { view: ViewId; id?: string | number | null; children: ReactNode }) {
    return (
        <a className="data-link" href={href(view, id)}>
            {children}
        </a>
    );
}

/** A select over seasons, newest first. */
export function SeasonSelect({
    seasons,
    value,
    onChange,
    allowAll
}: {
    seasons: number[];
    value: string;
    onChange: (value: string) => void;
    allowAll?: string;
}) {
    return (
        <div className="control">
            <label className="control-label" htmlFor="season-select">
                Season
            </label>
            <select id="season-select" value={value} onChange={e => onChange(e.target.value)}>
                {allowAll && <option value="all">{allowAll}</option>}
                {seasons.map(s => (
                    <option key={s} value={String(s)}>
                        {s}
                    </option>
                ))}
            </select>
        </div>
    );
}
