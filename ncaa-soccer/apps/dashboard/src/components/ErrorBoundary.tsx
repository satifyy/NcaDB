import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
    children: ReactNode;
    /** `view`: one page failed, navigation still works. `app`: the shell itself failed. */
    scope: 'view' | 'app';
    /** Changing this clears the error, so navigating away from a broken page recovers. */
    resetKey?: string;
}

interface State {
    error: Error | null;
    resetKey?: string;
}

/**
 * Turns a rendering error into a message instead of an empty page.
 *
 * Without it, React unmounts the whole tree when any component throws, and a single
 * unexpected value in one view leaves the reader looking at a blank screen with no idea
 * what happened.
 */
export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null, resetKey: this.props.resetKey };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
        return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error(`[ncadb] ${this.props.scope} failed to render`, error, info.componentStack);
    }

    render() {
        if (!this.state.error) return this.props.children;
        return (
            <div className={this.props.scope === 'app' ? 'boot' : 'view-error'} role="alert">
                {this.props.scope === 'app' && <p className="boot-title">College Soccer Lab</p>}
                <p>
                    {this.props.scope === 'view'
                        ? 'This page could not be displayed. The rest of the site still works.'
                        : 'The site hit an unexpected error.'}
                </p>
                <p className="text-sm text-muted">{this.state.error.message}</p>
                <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
                    <button type="button" className="pager-button" onClick={() => window.location.reload()}>
                        Reload
                    </button>
                    {this.props.scope === 'view' && (
                        <a className="pager-button" href="#/teams" style={{ display: 'inline-flex', alignItems: 'center' }}>
                            Go to Teams
                        </a>
                    )}
                </div>
            </div>
        );
    }
}
