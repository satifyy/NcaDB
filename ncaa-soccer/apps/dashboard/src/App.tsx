import { useState } from 'react';
import { Masthead } from './components/Layout/Masthead';
import { VIEWS } from './views';
import type { ViewId } from './views';
import { OverviewView } from './components/views/OverviewView';
import { RankingsView } from './components/views/RankingsView';
import { PredictionsView } from './components/views/PredictionsView';
import { ImpactView } from './components/views/ImpactView';
import { PlayersView } from './components/views/PlayersView';
import { TeamsView } from './components/views/TeamsView';
import { GamesView } from './components/views/GamesView';
import { DirectoryView } from './components/views/DirectoryView';
import { StatusView } from './components/views/StatusView';
import { Notice } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import { navigate, useRoute } from './route';

/** What the one search box narrows, per view, so its placeholder is never a lie. */
const PLACEHOLDER: Record<ViewId, string> = {
    overview: 'Search players and teams…',
    rankings: 'Search teams or conferences…',
    predictions: 'Search this week’s fixtures…',
    impact: 'Search players, teams, conferences…',
    players: 'Search players, teams, conferences…',
    teams: 'Search teams…',
    games: 'Search is not used here',
    directory: 'Search players by name…',
    status: 'Search is not used here'
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

    return (
        <div className="app-shell">
            <Masthead
                view={route.view}
                onView={next => navigate(next)}
                searchTerm={searchTerm}
                onSearch={term => setSearch({ view: route.view, term })}
                searchPlaceholder={PLACEHOLDER[route.view]}
                searchDisabled={route.view === 'games' || route.view === 'status' || route.id !== null}
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
                    </ErrorBoundary>
                )}
            </main>
        </div>
    );
}

export default App;
