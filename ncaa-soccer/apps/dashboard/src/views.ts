/**
 * The views the site is divided into.
 *
 * In its own module rather than beside the masthead that renders it: a file that exports
 * both a component and a constant cannot be hot-reloaded as a component, and the
 * navigation is the one thing you want to keep clicking while you edit everything else.
 */

export type ViewId =
    | 'overview'
    | 'rankings'
    | 'predictions'
    | 'impact'
    | 'players'
    | 'teams'
    | 'games'
    | 'directory'
    | 'status';

export interface ViewSpec {
    id: ViewId;
    label: string;
    /** Built from the nightly analytics files rather than queried from the database. */
    analytics: boolean;
}

export const VIEWS: ViewSpec[] = [
    { id: 'overview', label: 'Overview', analytics: true },
    { id: 'rankings', label: 'Rankings', analytics: true },
    { id: 'predictions', label: 'Predictions', analytics: true },
    { id: 'impact', label: 'Player impact', analytics: true },
    { id: 'players', label: 'Season stats', analytics: true },
    { id: 'teams', label: 'Teams', analytics: false },
    { id: 'games', label: 'Games', analytics: false },
    { id: 'directory', label: 'Players', analytics: false },
    { id: 'status', label: 'Data status', analytics: false }
];
