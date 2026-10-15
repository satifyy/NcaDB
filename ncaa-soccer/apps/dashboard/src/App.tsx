import { lazy, Suspense, useState } from 'react';
import { Masthead } from './components/Layout/Masthead';
import { VIEWS } from './views';
import type { ViewId } from './views';
import { Notice } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import { navigate, useRoute } from './route';
import { VIEW_LOADERS } from './viewLoaders';

// Each view is its own chunk (see viewLoaders.ts): the analytics views carry Chart.js,
// and a reader who came for a box score never downloads it.
const OverviewView = lazy(VIEW_LOADERS.overview);
const RankingsView = lazy(VIEW_LOADERS.rankings);
const PredictionsView = lazy(VIEW_LOADERS.predictions);
const ImpactView = lazy(VIEW_LOADERS.impact);
const PlayersView = lazy(VIEW_LOADERS.players);
const TeamsView = lazy(VIEW_LOADERS.teams);
const GamesView = lazy(VIEW_LOADERS.games);
const DirectoryView = lazy(VIEW_LOADERS.directory);
const StatusView = lazy(VIEW_LOADERS.status);

const VIEW_LOADING = (
    <div className="loading" role="status" aria-live="polite">
        Loading…
    </div>
);

/**
 * What the one search box narrows, per view, so its placeholder is never a lie. Views
 * without one (Games, Data status) have no search box at all rather than a disabled one.
 */
const PLACEHOLDER: Record<ViewId, string | null> = {
    overview: 'Search players and teams…',
    rankings: 'Search teams or conferences…',
    predictions: 'Search this week’s fixtures…',
    impact: 'Search players, teams, conferences…',
    players: 'Search players, teams, conferences…',
    teams: 'Search teams…',
    games: null,
    directory: 'Search players by name…',
    status: null
};

/**
 * The shell: one masthead, one search term, and whichever view the URL names.
 *
 * Each view owns its own season and filters, because they mean different things — a
 * season of predictions and a season of career totals are not the same selection, and
 * forcing them to share one would make switching views silently change what a reader was
 * looking at. The search term is shared, because "Clemson" means Clemson everywhere.
 *
 * `analyticsReady` is false on a deployment whose nightly analytics have not run yet;
 * the database-backed views still work, and the others say why they are empty.
 */
function App({ analyticsReady }: { analyticsReady: boolean }) {
    const route = useRoute(analyticsReady ? 'overview' : 'teams');
    const [search, setSearch] = useState({ view: route.view, term: '' });
    // The term belongs to the view it was typed in; a new view starts with an empty box.
    const searchTerm = search.view === route.view ? search.term : '';
    const spec = VIEWS.find(v => v.id === route.view)!;
    const placeholder = PLACEHOLDER[route.view];
    // Typing on a team or player page searches the list it came from, rather than the box
    // sitting there disabled.
    const onSearch = (term: string) => {
        setSearch({ view: route.view, term });
        if (route.id !== null) navigate(route.view);
    };

    return (
        <div className="app-shell">
            <Masthead
                view={route.view}
                searchTerm={searchTerm}
                onSearch={placeholder === null ? undefined : onSearch}
                searchPlaceholder={placeholder ?? undefined}
            />

            <main className="container" id="main">
                {spec.analytics && !analyticsReady ? (
                    <div style={{ marginTop: 'var(--space-8)' }}>
                        <Notice kind="info">
                            Ratings, forecasts and season tables are built by the nightly analytics run, which has not completed
                            on this deployment yet. Teams, Games and Players are available now.
                        </Notice>
                    </div>
                ) : (
                    <ErrorBoundary scope="view" resetKey={`${route.view}/${route.id ?? ''}`}>
                        <Suspense fallback={VIEW_LOADING}>
                            {route.view === 'overview' && <OverviewView onView={next => navigate(next)} />}
                            {route.view === 'rankings' && <RankingsView searchTerm={searchTerm} />}
                            {route.view === 'predictions' && <PredictionsView searchTerm={searchTerm} />}
                            {route.view === 'impact' && <ImpactView searchTerm={searchTerm} />}
                            {route.view === 'players' && (
                                <PlayersView searchTerm={searchTerm} onSearch={term => setSearch({ view: 'players', term })} />
                            )}
                            {route.view === 'teams' && <TeamsView searchTerm={searchTerm} teamId={route.id} />}
                            {route.view === 'games' && <GamesView gameId={route.id} />}
                            {route.view === 'directory' && <DirectoryView searchTerm={searchTerm} playerId={route.id} />}
                            {route.view === 'status' && <StatusView />}
                        </Suspense>
                    </ErrorBoundary>
                )}
            </main>
        </div>
    );
}

export default App;
