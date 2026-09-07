/**
 * The views the site is divided into.
 *
 * In its own module rather than beside the masthead that renders it: a file that exports
 * both a component and a constant cannot be hot-reloaded as a component, and the
 * navigation is the one thing you want to keep clicking while you edit everything else.
 */

export type ViewId = 'overview' | 'rankings' | 'predictions' | 'impact' | 'players';

export const VIEWS: { id: ViewId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'rankings', label: 'Rankings' },
    { id: 'predictions', label: 'Predictions' },
    { id: 'impact', label: 'Player impact' },
    { id: 'players', label: 'Season stats' }
];
