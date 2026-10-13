import { useState } from 'react';
import { Masthead } from './components/Layout/Masthead';
import type { ViewId } from './views';
import { OverviewView } from './components/views/OverviewView';
import { RankingsView } from './components/views/RankingsView';
import { PredictionsView } from './components/views/PredictionsView';
import { ImpactView } from './components/views/ImpactView';
import { PlayersView } from './components/views/PlayersView';
import { ANALYTICS } from './analytics';

/** What the one search box narrows, per view, so its placeholder is never a lie. */
const PLACEHOLDER: Record<ViewId, string> = {
    overview: 'Search players and teams…',
    rankings: 'Search teams or conferences…',
    predictions: 'Search this week’s fixtures…',
    impact: 'Search players, teams, conferences…',
    players: 'Search players, teams, conferences…'
};

/**
 * The shell: one masthead, one search term, and whichever view is selected.
 *
 * Each view owns its own season and filters, because they mean different things — a
 * season of predictions and a season of career totals are not the same selection, and
 * forcing them to share one would make switching views silently change what a reader was
 * looking at. The search term is shared, because "Clemson" means Clemson everywhere.
 */
function App() {
    const [view, setView] = useState<ViewId>('overview');
    const [searchTerm, setSearchTerm] = useState('');

    return (
        <div className="app-shell">
            <Masthead
                view={view}
                onView={next => {
                    setView(next);
                    setSearchTerm('');
                }}
                searchTerm={searchTerm}
                onSearch={setSearchTerm}
                searchPlaceholder={PLACEHOLDER[view]}
                generatedAt={ANALYTICS.generated_at}
            />

            <main className="container">
                {view === 'overview' && <OverviewView onView={setView} />}
                {view === 'rankings' && <RankingsView searchTerm={searchTerm} />}
                {view === 'predictions' && <PredictionsView searchTerm={searchTerm} />}
                {view === 'impact' && <ImpactView searchTerm={searchTerm} />}
                {view === 'players' && <PlayersView searchTerm={searchTerm} onSearch={setSearchTerm} />}
            </main>
        </div>
    );
}

export default App;
