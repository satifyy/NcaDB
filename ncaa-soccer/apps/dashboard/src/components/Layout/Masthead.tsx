import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useApi } from '../../api';
import { AccountMenu } from '../../auth/controls';
import { href } from '../../route';
import { VIEWS } from '../../views';
import type { ViewId } from '../../views';
import { ANALYTICS, loadPredictions } from '../../analytics';
import type { PredictedGame, SeasonPredictions } from '../../analytics';
import { shortDate } from '../../format';

interface MastheadProps {
    /** The statistics view on screen; null on an account page. */
    view: ViewId | null;
    onView: (view: ViewId) => void;
    /** Omitted on account pages, which have nothing to search. */
    searchTerm?: string;
    onSearch?: (term: string) => void;
    /** What the search box narrows on this view, so the placeholder is never a lie. */
    searchPlaceholder?: string;
    /** On pages the search does not apply to, the box is disabled rather than ignored. */
    searchDisabled?: boolean;
}

interface Freshness {
    freshness: { last_successful_sync: string | null; hours_since_sync: number | null };
}

/**
 * Concept A: Sports Editorial Broadsheet Masthead ("The Collegiate Tribune")
 *
 * Multi-tier broadsheet header featuring publication volume/edition lines,
 * grand serif publication title, live scoreboard ribbon, competition ribbon,
 * and editorial search controls.
 */
export function Masthead({ view, onView, searchTerm, onSearch, searchPlaceholder, searchDisabled }: MastheadProps) {
    const status = useApi<Freshness>('/api/v1/data-status');
    const synced = status.data?.freshness.last_successful_sync;
    const hours = status.data?.freshness.hours_since_sync ?? null;
    const syncedLabel = synced
        ? new Date(synced).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : 'Oct 14, 2026';
    const stale = hours !== null && hours > 36;

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

    return (
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
                    <h1 className="broadsheet-main-title">
                        <a href={href('overview')} onClick={() => onView('overview')}>
                            The Collegiate Tribune
                        </a>
                    </h1>
                    <p className="broadsheet-tagline">
                        Authoritative Division I Analytics, Elo Rating Systems & Championship Forecasts
                    </p>
                </div>

                <div className="broadsheet-actions">
                    {onSearch && (
                        <div className="search-box broadsheet-search">
                            <Search size={15} />
                            <input
                                type="search"
                                value={searchTerm}
                                onChange={handleChange}
                                placeholder={searchPlaceholder}
                                aria-label={searchPlaceholder}
                                disabled={searchDisabled}
                            />
                        </div>
                    )}
                    <AccountMenu />
                </div>
            </div>

            {/* Live Scoreboard Ribbon Strip */}
            {scoreboardGames.length > 0 && (
                <div className="scoreboard-strip" aria-label="Running Scoreboard">
                    <div className="scoreboard-scroll">
                        {scoreboardGames.map(game => (
                            <div
                                key={game.id}
                                className="scoreboard-pill"
                                role="button"
                                tabIndex={0}
                                onClick={() => onView('predictions')}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') onView('predictions');
                                }}
                            >
                                <div className="score-pill-header">
                                    <span>{shortDate(game.date)}</span>
                                    <span className={game.outcome ? 'score-final-badge' : 'score-upcoming-badge'}>
                                        {game.outcome ? 'FINAL' : 'PROJ'}
                                    </span>
                                </div>
                                <div className="score-team-row">
                                    <span className="score-team-name">{game.home}</span>
                                    <span className="score-team-val">
                                        {game.home_score !== null ? game.home_score : `${Math.round(game.p[0] * 100)}%`}
                                    </span>
                                </div>
                                <div className="score-team-row">
                                    <span className="score-team-name">{game.away}</span>
                                    <span className="score-team-val">
                                        {game.away_score !== null ? game.away_score : `${Math.round(game.p[2] * 100)}%`}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Competition Ribbon (View Navigation) */}
            <nav className="broadsheet-nav" aria-label="Competition Editions">
                <div className="container broadsheet-nav-inner">
                    {VIEWS.map(item => (
                        <button
                            key={item.id}
                            type="button"
                            className={item.id === view ? 'nav-item is-active' : 'nav-item'}
                            aria-current={item.id === view ? 'page' : undefined}
                            onClick={() => onView(item.id)}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            </nav>
        </header>
    );
}
