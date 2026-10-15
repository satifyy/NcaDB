/**
 * Where each view's code is, for `React.lazy` in App and for starting the download early.
 *
 * The browser caches a dynamic import, so the chunk `preloadView` starts at startup is the
 * same one `lazy` later waits on: the first view arrives while the analytics index is
 * still loading, rather than after it.
 */

import type { ViewId } from './views';

export const VIEW_LOADERS = {
    overview: () => import('./components/views/OverviewView').then(m => ({ default: m.OverviewView })),
    rankings: () => import('./components/views/RankingsView').then(m => ({ default: m.RankingsView })),
    predictions: () => import('./components/views/PredictionsView').then(m => ({ default: m.PredictionsView })),
    impact: () => import('./components/views/ImpactView').then(m => ({ default: m.ImpactView })),
    players: () => import('./components/views/PlayersView').then(m => ({ default: m.PlayersView })),
    teams: () => import('./components/views/TeamsView').then(m => ({ default: m.TeamsView })),
    games: () => import('./components/views/GamesView').then(m => ({ default: m.GamesView })),
    directory: () => import('./components/views/DirectoryView').then(m => ({ default: m.DirectoryView })),
    status: () => import('./components/views/StatusView').then(m => ({ default: m.StatusView }))
};

export function preloadView(view: ViewId): void {
    VIEW_LOADERS[view]().catch(() => {
        // The lazy component retries and reports a failure through the error boundary.
    });
}
