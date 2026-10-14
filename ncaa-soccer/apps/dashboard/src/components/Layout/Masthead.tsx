import { Search, Activity } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { useApi } from '../../api';
import { AccountMenu } from '../../auth/controls';
import { href } from '../../route';
import { VIEWS } from '../../views';
import type { ViewId } from '../../views';

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
 * Brand, view navigation and one search box.
 *
 * The search is in the masthead rather than inside each view because it means the same
 * thing everywhere — narrow what is on screen to a name — and moving it per view would
 * make a reader hunt for it after every tab change.
 */
export function Masthead({ view, onView, searchTerm, onSearch, searchPlaceholder, searchDisabled }: MastheadProps) {
    // When the database last synced, from the API, so the page says how current it is.
    const status = useApi<Freshness>('/api/v1/data-status');
    const synced = status.data?.freshness.last_successful_sync;
    const hours = status.data?.freshness.hours_since_sync ?? null;
    const syncedLabel = synced
        ? new Date(synced).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;
    const stale = hours !== null && hours > 36;

    const handleChange = (event: ChangeEvent<HTMLInputElement>) => onSearch?.(event.target.value);

    return (
        <header className="masthead">
            <div className="container masthead-inner">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true">
                        <Activity size={20} />
                    </span>
                    <span>
                        <span className="brand-name">College Soccer Lab</span>
                        <br />
                        <span className="brand-sub">
                            NCAA Division I men’s soccer
                            {syncedLabel && (
                                <>
                                    {' · '}
                                    <a href={href('status')} className={stale ? 'sync-label is-stale' : 'sync-label'}>
                                        {stale ? 'stale — ' : ''}synced {syncedLabel}
                                    </a>
                                </>
                            )}
                        </span>
                    </span>
                </div>

                <nav className="nav" aria-label="Views">
                    {VIEWS.map(item => (
                        <button
                            key={item.id}
                            type="button"
                            aria-current={item.id === view ? 'page' : undefined}
                            onClick={() => onView(item.id)}
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>

                <div className="masthead-actions">
                    {onSearch && (
                        <div className="search-box">
                            <Search size={16} />
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
        </header>
    );
}
