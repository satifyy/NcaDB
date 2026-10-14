/**
 * The frame around an account page: the same masthead as the statistics, whose view
 * buttons lead back to them, and the page itself.
 */

import { Masthead } from '../components/Layout/Masthead';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { navigate } from '../route';
import type { AuthPage } from './config';
import { AuthPageView } from './pages';

export function AuthShell({ page }: { page: AuthPage }) {
    return (
        <div className="app-shell">
            <Masthead view={null} onView={next => navigate(next)} />
            <main className="container" id="main">
                <ErrorBoundary scope="view" resetKey={page}>
                    <AuthPageView page={page} />
                </ErrorBoundary>
            </main>
        </div>
    );
}
