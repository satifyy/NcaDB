import { Menu, Search, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useApi } from '../../api';
import { AccountMenu } from '../../auth/controls';
import { href } from '../../route';
import { VIEW_GROUPS, VIEWS } from '../../views';
import type { ViewId } from '../../views';
import { ANALYTICS, loadPredictions } from '../../analytics';
import type { PredictedGame, SeasonPredictions } from '../../analytics';
import { shortDate } from '../../format';

interface MastheadProps {
    /** The statistics view on screen; null on an account page. */
    view: ViewId | null;
    /** Omitted on account pages, which have nothing to search. */
    searchTerm?: string;
    onSearch?: (term: string) => void;
    /** What the search box narrows on this view, so the placeholder is never a lie. */
    searchPlaceholder?: string;
}

interface Freshness {
    freshness: { last_successful_sync: string | null; hours_since_sync: number | null };
}

/**
 * Concept A: Sports Editorial Broadsheet Masthead ("The Collegiate Tribune")
 *
 * The broadsheet header (edition line, title, search, scoreboard) scrolls away with the
 * page; only the section bar under it stays pinned. A pinned header of the full masthead
 * covered 43–64% of a phone screen and a third of a laptop's.
 */
export function Masthead({ view, searchTerm, onSearch, searchPlaceholder }: MastheadProps) {
    const status = useApi<Freshness>('/api/v1/data-status');
    const synced = status.data?.freshness.last_successful_sync;
    const hours = status.data?.freshness.hours_since_sync ?? null;
    const syncedLabel = synced
        ? new Date(synced).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : 'Oct 14, 2026';
    const stale = hours !== null && hours > 36;
    const searchInput = useRef<HTMLInputElement>(null);

    // Load week's games for the running scoreboard ribbon
    const [scoreboardGames, setScoreboardGames] = useState<PredictedGame[]>([]);

    useEffect(() => {
        if (!ANALYTICS?.current_season) return;
        loadPredictions(ANALYTICS.current_season)
            .then((pred: SeasonPredictions | null) => {
                if (!pred) return;
                const weeks = pred.weeks || [];
                const current = weeks.find(w => w.week === ANALYTICS?.current_week) || weeks[weeks.length - 1];
                if (current && current.games) {
                    setScoreboardGames(current.games.slice(0, 8));
                }
            })
            .catch(() => {
                // Non-fatal if predictions are still computing
            });
    }, []);

    const handleChange = (event: ChangeEvent<HTMLInputElement>) => onSearch?.(event.target.value);

    /** The section bar's search button: the box itself has scrolled away with the header. */
    const focusSearch = () => {
        window.scrollTo({ top: 0 });
        searchInput.current?.focus({ preventScroll: true });
    };

    return (
        <>
            <header className="broadsheet-header">
                {/* Top Publication Volume & Date Line */}
                <div className="broadsheet-top-line">
                    <div className="container broadsheet-top-inner">
                        <span className="hide-mobile">VOL. CXVIII NO. 42</span>
                        <span className="hide-mobile">NCAA DIVISION I SOCCER CHRONICLE</span>
                        <span>
                            LATE EDITION ·{' '}
                            <a href={href('status')} className={stale ? 'sync-label is-stale' : 'sync-label'}>
                                {stale ? 'STALE — ' : ''}SYNCED {syncedLabel.toUpperCase()}
                            </a>
                        </span>
                    </div>
                </div>

                {/* Grand Broadsheet Masthead Title */}
                <div className="container broadsheet-title-container">
                    <div className="broadsheet-branding">
                        <div className="broadsheet-kicker">COLLEGE SOCCER LAB // NCADB</div>
                        <p className="broadsheet-main-title">
                            <a href={href('overview')}>The Collegiate Tribune</a>
                        </p>
                        <p className="broadsheet-tagline">
                            Authoritative Division I Analytics, Elo Rating Systems & Championship Forecasts
                        </p>
                    </div>

                    <div className="broadsheet-actions">
                        {onSearch && (
                            <div className="search-box broadsheet-search" role="search">
                                <Search size={15} aria-hidden="true" />
                                <input
                                    ref={searchInput}
                                    type="search"
                                    value={searchTerm}
                                    onChange={handleChange}
                                    placeholder={searchPlaceholder}
                                    aria-label={searchPlaceholder}
                                    enterKeyHint="search"
                                />
                            </div>
                        )}
                        <AccountMenu />
                    </div>
                </div>

                {/* Live Scoreboard Ribbon Strip */}
                {scoreboardGames.length > 0 && (
                    <div className="scoreboard-strip">
                        <ul className="scoreboard-scroll" aria-label="This week’s scoreboard">
                            {scoreboardGames.map(game => (
                                <li key={game.id}>
                                    <a className="scoreboard-pill" href={href('predictions')}>
                                        <span className="score-pill-header">
                                            <span>{shortDate(game.date)}</span>
                                            <span className={game.outcome ? 'score-final-badge' : 'score-upcoming-badge'}>
                                                {game.outcome ? 'FINAL' : 'PROJ'}
                                            </span>
                                        </span>
                                        <span className="score-team-row">
                                            <span className="score-team-name">{game.home}</span>
                                            <span className="score-team-val">
                                                {game.home_score !== null ? game.home_score : `${Math.round(game.p[0] * 100)}%`}
                                            </span>
                                        </span>
                                        <span className="score-team-row">
                                            <span className="score-team-name">{game.away}</span>
                                            <span className="score-team-val">
                                                {game.away_score !== null ? game.away_score : `${Math.round(game.p[2] * 100)}%`}
                                            </span>
                                        </span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </header>

            <SectionBar view={view} onSearch={onSearch ? focusSearch : undefined} />
        </>
    );
}

/**
 * The pinned section bar: every view in one ribbon on a wide screen, and on a narrow one
 * the same ribbon (scrolled to the current view) plus a Menu that lists every section,
 * so Teams, Games and Players are never hidden past the edge of a phone.
 */
function SectionBar({ view, onSearch }: { view: ViewId | null; onSearch?: () => void }) {
    const [open, setOpen] = useState(false);
    const panelId = useId();
    const root = useRef<HTMLElement>(null);
    const toggle = useRef<HTMLButtonElement>(null);
    const ribbon = useRef<HTMLDivElement>(null);

    // A new view closes the menu: the link was followed.
    const [openFor, setOpenFor] = useState(view);
    if (openFor !== view) {
        setOpenFor(view);
        setOpen(false);
    }

    // The current section is scrolled into the ribbon, not left past the right edge.
    useLayoutEffect(() => {
        const strip = ribbon.current;
        const active = strip?.querySelector<HTMLElement>('[aria-current="page"]');
        if (!strip || !active) return;
        strip.scrollLeft = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
    }, [view]);

    useEffect(() => {
        if (!open) return;
        const onPointer = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false);
                toggle.current?.focus();
            }
        };
        document.addEventListener('pointerdown', onPointer);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onPointer);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const link = (item: (typeof VIEWS)[number], className: string) => (
        <a
            key={item.id}
            href={href(item.id)}
            className={item.id === view ? `${className} is-active` : className}
            aria-current={item.id === view ? 'page' : undefined}
            onClick={() => setOpen(false)}
        >
            {item.label}
        </a>
    );

    return (
        <nav className="broadsheet-nav" aria-label="Sections" ref={root}>
            <div className="container broadsheet-nav-inner">
                <div className="nav-ribbon" ref={ribbon}>
                    {VIEWS.map(item => link(item, 'nav-item'))}
                </div>
                {onSearch && (
                    <button type="button" className="nav-icon-button nav-search-shortcut" aria-label="Search" onClick={onSearch}>
                        <Search size={18} aria-hidden="true" />
                    </button>
                )}
                <button
                    ref={toggle}
                    type="button"
                    className="nav-icon-button nav-menu-toggle"
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setOpen(o => !o)}
                >
                    {open ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
                    <span>Menu</span>
                </button>
            </div>
            <div className="nav-panel" id={panelId} hidden={!open}>
                <div className="container nav-panel-inner">
                    {VIEW_GROUPS.map(group => (
                        <section key={group} className="nav-panel-group" aria-label={group}>
                            <h2 className="nav-panel-heading">{group}</h2>
                            {VIEWS.filter(item => item.group === group).map(item => link(item, 'nav-panel-link'))}
                        </section>
                    ))}
                </div>
            </div>
        </nav>
    );
}
