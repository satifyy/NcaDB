import { Search, Activity } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { VIEWS } from '../../views';
import type { ViewId } from '../../views';

interface MastheadProps {
    view: ViewId;
    onView: (view: ViewId) => void;
    searchTerm: string;
    onSearch: (term: string) => void;
    /** What the search box narrows on this view, so the placeholder is never a lie. */
    searchPlaceholder: string;
    generatedAt: string;
}

/**
 * Brand, view navigation and one search box.
 *
 * The search is in the masthead rather than inside each view because it means the same
 * thing everywhere — narrow what is on screen to a name — and moving it per view would
 * make a reader hunt for it after every tab change.
 */
export function Masthead({ view, onView, searchTerm, onSearch, searchPlaceholder, generatedAt }: MastheadProps) {
    const built = new Date(generatedAt);
    const builtLabel = Number.isNaN(built.getTime())
        ? null
        : built.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

    const handleChange = (event: ChangeEvent<HTMLInputElement>) => onSearch(event.target.value);

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
                            NCAA Division I men’s soccer{builtLabel ? ` · built ${builtLabel}` : ''}
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
                    <div className="search-box">
                        <Search size={16} />
                        <input
                            type="search"
                            value={searchTerm}
                            onChange={handleChange}
                            placeholder={searchPlaceholder}
                            aria-label={searchPlaceholder}
                        />
                    </div>
                </div>
            </div>
        </header>
    );
}
