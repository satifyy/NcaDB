/**
 * Small pieces the database-backed views share: load states, a pager, result badges,
 * and number formatting that shows a missing value as missing rather than as zero.
 */

import { useEffect, useRef, useState } from 'react';
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

/**
 * The scrolling box every data table sits in.
 *
 * A wide table scrolls inside this box, never the page. It tracks whether there is more
 * to either side, so the stylesheet can fade the edge with hidden columns and shadow the
 * pinned name column once rows have scrolled beneath it. When it does scroll it is a
 * focusable, named region, so a keyboard can scroll it too.
 */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
    const box = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ start: true, end: true });

    useEffect(() => {
        const el = box.current;
        if (!el) return;
        const update = () => {
            const start = el.scrollLeft <= 1;
            const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
            setEdges(prev => (prev.start === start && prev.end === end ? prev : { start, end }));
        };
        update();
        el.addEventListener('scroll', update, { passive: true });
        const resize = new ResizeObserver(update);
        resize.observe(el);
        if (el.firstElementChild) resize.observe(el.firstElementChild);
        return () => {
            el.removeEventListener('scroll', update);
            resize.disconnect();
        };
    }, []);

    const scrolls = !(edges.start && edges.end);
    return (
        <div className="table-frame" data-at-start={edges.start} data-at-end={edges.end}>
            <div
                ref={box}
                className="table-scroll"
                role={scrolls ? 'region' : undefined}
                aria-label={scrolls ? `${label} (scrolls sideways)` : undefined}
                tabIndex={scrolls ? 0 : undefined}
            >
                {children}
            </div>
        </div>
    );
}

/**
 * A column header that sorts its table: a real button inside the `<th>`, so it can be
 * reached and pressed from the keyboard, with `aria-sort` on the header itself.
 */
export function SortHeader({
    label,
    title,
    active,
    direction = 'descending',
    onSort,
    numeric,
    className
}: {
    label: ReactNode;
    /** The column's full name, when the label is an abbreviation. */
    title?: string;
    active: boolean;
    direction?: 'ascending' | 'descending';
    onSort: () => void;
    numeric?: boolean;
    className?: string;
}) {
    const classes = [numeric ? 'numeric' : '', className ?? ''].join(' ').trim();
    return (
        <th scope="col" className={classes || undefined} aria-sort={active ? direction : undefined}>
            <button type="button" className="sort-button" onClick={onSort} title={title}>
                {label}
                <span className="sort-indicator" aria-hidden="true">
                    {active ? (direction === 'ascending' ? '▴' : '▾') : ''}
                </span>
            </button>
        </th>
    );
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
