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
    /** Which heading the view sits under in the section menu. */
    group: ViewGroup;
}

export type ViewGroup = 'Browse' | 'Analysis' | 'About the data';

/** The section menu's headings, in order: the record pages a reader looks things up in first. */
export const VIEW_GROUPS: ViewGroup[] = ['Browse', 'Analysis', 'About the data'];

export const VIEWS: ViewSpec[] = [
    { id: 'overview', label: 'Overview', analytics: true, group: 'Analysis' },
    { id: 'rankings', label: 'Rankings', analytics: true, group: 'Analysis' },
    { id: 'predictions', label: 'Predictions', analytics: true, group: 'Analysis' },
    { id: 'impact', label: 'Player impact', analytics: true, group: 'Analysis' },
    { id: 'players', label: 'Season stats', analytics: true, group: 'Analysis' },
    { id: 'teams', label: 'Teams', analytics: false, group: 'Browse' },
    { id: 'games', label: 'Games', analytics: false, group: 'Browse' },
    { id: 'directory', label: 'Players', analytics: false, group: 'Browse' },
    { id: 'status', label: 'Data status', analytics: false, group: 'About the data' }
];
