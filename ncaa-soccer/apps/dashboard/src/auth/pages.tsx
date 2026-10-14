/**
 * The account pages: /ncadb/login, /signup, /profile, /dashboard and /admin.
 *
 * Login and sign-up hand over to Clerk's hosted pages, which do the credential work
 * (email codes, passwords, Google, verification, recovery, lockout after repeated
 * failures) on Clerk's origin. Everything here only reads and writes our own profile
 * data through the API, which checks the session on every request.
 */

import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { LogIn, Star, Trash2, UserPlus } from 'lucide-react';
import { ApiRequestError, useApi } from '../api';
import { Card, Notice } from '../components/ui';
import { Loaded } from '../components/data';
import { href } from '../route';
import { BASE, pagePath } from './config';
import type { AuthPage } from './config';
import { accountRequest, useAccount } from './account-api';
import type { Preferences, Profile } from './account-api';
import { useSession } from './session-context';

function Page({ title, lede, children }: { title: string; lede?: ReactNode; children: ReactNode }) {
    useEffect(() => {
        document.title = `${title} — College Soccer Lab`;
    }, [title]);
    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">{title}</h1>
                    {lede && <p className="page-lede">{lede}</p>}
                </div>
            </div>
            {children}
        </>
    );
}

function Pending({ label }: { label: string }) {
    return (
        <div className="empty-state" role="status" aria-live="polite">
            {label}
        </div>
    );
}

function Unavailable() {
    return (
        <Notice kind="info">
            Accounts are not switched on for this deployment yet. Every statistic on the site is available without one:{' '}
            <a className="data-link" href={BASE}>
                go to the statistics
            </a>
            .
        </Notice>
    );
}

/** Gate for pages that need a session: says why and offers sign-in, never a blank page. */
function RequireSignIn({ page, children }: { page: AuthPage; children: ReactNode }) {
    const session = useSession();
    if (!session.enabled) return <Unavailable />;
    if (session.failed) return <Notice>The sign-in service could not be reached. Reload the page to try again.</Notice>;
    if (!session.loaded) return <Pending label="Checking your session…" />;
    if (!session.signedIn) {
        return (
            <div className="auth-card">
                <p>Sign in to see this page.</p>
                <button
                    type="button"
                    className="button button-primary"
                    onClick={() => session.signIn(new URL(pagePath(page), window.location.origin).toString())}
                >
                    <LogIn size={16} aria-hidden="true" /> Log in
                </button>
            </div>
        );
    }
    return <>{children}</>;
}

// ----- login / signup -------------------------------------------------------------------

function Handoff({ mode }: { mode: 'login' | 'signup' }) {
    const session = useSession();
    const [leaving, setLeaving] = useState(false);
    const login = mode === 'login';
    const title = login ? 'Log in' : 'Create an account';

    useEffect(() => {
        // Already signed in: there is nothing to do here.
        if (session.loaded && session.signedIn) window.location.replace(pagePath('dashboard'));
    }, [session.loaded, session.signedIn]);

    if (!session.enabled) {
        return (
            <Page title={title}>
                <Unavailable />
            </Page>
        );
    }
    const go = () => {
        setLeaving(true);
        if (login) session.signIn();
        else session.signUp();
    };
    return (
        <Page title={title} lede="An account lets you save teams and players and keep your preferences across devices. Statistics never need one.">
            <div className="auth-card">
                {session.failed ? (
                    <Notice>The sign-in service could not be reached. Check your connection or extensions, then reload.</Notice>
                ) : (
                    <>
                        <p>
                            {login
                                ? 'Continue with Google or with your email address. You will sign in on our secure account page and come straight back.'
                                : 'Sign up with Google or with your email address. We will send a code to confirm the address before the account is created.'}
                        </p>
                        <button
                            type="button"
                            className="button button-primary button-wide"
                            onClick={go}
                            disabled={!session.loaded || leaving}
                            aria-busy={!session.loaded || leaving}
                        >
                            {login ? <LogIn size={16} aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />}
                            {!session.loaded ? 'Loading…' : leaving ? 'Opening…' : login ? 'Continue to log in' : 'Continue to sign up'}
                        </button>
                        <p className="text-sm text-muted">
                            {login ? (
                                <>
                                    New here? <a className="data-link" href={pagePath('signup')}>Create an account</a>. Forgot your password? Choose
                                    “Forgot password” on the next page.
                                </>
                            ) : (
                                <>
                                    Already have an account? <a className="data-link" href={pagePath('login')}>Log in</a>.
                                </>
                            )}
                        </p>
                    </>
                )}
            </div>
        </Page>
    );
}

// ----- profile ---------------------------------------------------------------------------

function ProfileForm({ profile }: { profile: Profile }) {
    const session = useSession();
    const account = useAccount();
    const [name, setName] = useState(profile.display_name ?? '');
    const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ kind: 'idle' });

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setStatus({ kind: 'saving' });
        try {
            const res = await accountRequest<{ data: Profile }>(session.getToken, 'PATCH', '/api/v1/me', {
                display_name: name.trim() ? name.trim() : null
            });
            account.setProfile(res.data);
            setStatus({ kind: 'saved' });
        } catch (err) {
            setStatus({ kind: 'error', message: (err as Error).message });
        }
    };
    return (
        <form className="form" onSubmit={submit} noValidate>
            <label className="form-field">
                <span className="control-label">Display name</span>
                <input
                    className="input"
                    value={name}
                    maxLength={80}
                    onChange={e => setName(e.target.value)}
                    aria-invalid={status.kind === 'error'}
                    aria-describedby="display-name-help"
                />
                <span id="display-name-help" className="text-sm text-muted">
                    Shown on this site only. Leave empty to use your account name.
                </span>
            </label>
            <FormStatus status={status} />
            <button type="submit" className="button button-primary" disabled={status.kind === 'saving'}>
                {status.kind === 'saving' ? 'Saving…' : 'Save'}
            </button>
        </form>
    );
}

function FormStatus({ status }: { status: { kind: string; message?: string } }) {
    if (status.kind === 'error') {
        return (
            <p className="form-error" role="alert">
                {status.message}
            </p>
        );
    }
    if (status.kind === 'saved') {
        return (
            <p className="form-ok" role="status">
                Saved.
            </p>
        );
    }
    return null;
}

function PreferencesForm({ preferences }: { preferences: Preferences }) {
    const session = useSession();
    const account = useAccount();
    const seasons = useApi<{ data: { season: number }[] }>('/api/v1/seasons');
    const [season, setSeason] = useState(preferences.default_season === null ? '' : String(preferences.default_season));
    const [favoritesFirst, setFavoritesFirst] = useState(preferences.favorites_first);
    const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ kind: 'idle' });

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setStatus({ kind: 'saving' });
        try {
            const res = await accountRequest<{ data: Preferences }>(session.getToken, 'PUT', '/api/v1/me/preferences', {
                default_season: season ? Number(season) : null,
                default_view: preferences.default_view,
                favorites_first: favoritesFirst
            });
            if (account.profile) account.setProfile({ ...account.profile, preferences: res.data });
            setStatus({ kind: 'saved' });
        } catch (err) {
            setStatus({ kind: 'error', message: (err as Error).message });
        }
    };
    return (
        <form className="form" onSubmit={submit}>
            <label className="form-field">
                <span className="control-label">Default season</span>
                <select className="input" value={season} onChange={e => setSeason(e.target.value)}>
                    <option value="">Latest season</option>
                    {(seasons.data?.data ?? []).map(s => (
                        <option key={s.season} value={s.season}>
                            {s.season}
                        </option>
                    ))}
                </select>
            </label>
            <label className="form-check">
                <input type="checkbox" checked={favoritesFirst} onChange={e => setFavoritesFirst(e.target.checked)} />
                <span>Show my favorites first on my dashboard</span>
            </label>
            <FormStatus status={status} />
            <button type="submit" className="button button-primary" disabled={status.kind === 'saving'}>
                {status.kind === 'saving' ? 'Saving…' : 'Save preferences'}
            </button>
        </form>
    );
}

function FavoritesList() {
    const account = useAccount();
    const [error, setError] = useState<string | null>(null);
    const remove = async (action: () => Promise<void>) => {
        setError(null);
        try {
            await action();
        } catch (err) {
            setError((err as Error).message);
        }
    };
    return (
        <div className="grid grid-2">
            <Card title="Favorite teams" note={`${account.teams.length}`}>
                {account.teams.length === 0 ? (
                    <p className="text-muted text-sm">
                        None yet. Open a team from <a className="data-link" href={href('teams')}>Teams</a> and choose “Save team”.
                    </p>
                ) : (
                    <ul className="favorites-list">
                        {account.teams.map(t => (
                            <li key={t.id}>
                                <a className="data-link" href={href('teams', t.slug)}>
                                    {t.name}
                                </a>
                                <button type="button" className="link-button" onClick={() => void remove(() => account.toggleTeam(t.slug))}>
                                    Remove<span className="visually-hidden"> {t.name}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
            <Card title="Favorite players" note={`${account.players.length}`}>
                {account.players.length === 0 ? (
                    <p className="text-muted text-sm">
                        None yet. Open a player from <a className="data-link" href={href('directory')}>Players</a> and choose “Save player”.
                    </p>
                ) : (
                    <ul className="favorites-list">
                        {account.players.map(p => (
                            <li key={p.id}>
                                <a className="data-link" href={href('directory', p.id)}>
                                    {p.name}
                                </a>
                                <button type="button" className="link-button" onClick={() => void remove(() => account.togglePlayer(p.id))}>
                                    Remove<span className="visually-hidden"> {p.name}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
            {error && (
                <p className="form-error" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}

function DeleteData() {
    const session = useSession();
    const [confirming, setConfirming] = useState(false);
    const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'error'; message?: string }>({ kind: 'idle' });
    const remove = async () => {
        setStatus({ kind: 'saving' });
        try {
            await accountRequest(session.getToken, 'DELETE', '/api/v1/me');
            await session.signOut();
        } catch (err) {
            setStatus({ kind: 'error', message: (err as Error).message });
        }
    };
    return (
        <div className="stack">
            <p className="text-sm text-muted">
                Removes your NCADB profile, favorites and preferences. Your sign-in account itself is managed on the account page.
            </p>
            {!confirming ? (
                <button type="button" className="button button-danger" onClick={() => setConfirming(true)}>
                    <Trash2 size={16} aria-hidden="true" /> Delete my NCADB data
                </button>
            ) : (
                <div className="confirm-row" role="group" aria-label="Confirm deletion">
                    <span>This cannot be undone.</span>
                    <button type="button" className="button button-danger" onClick={() => void remove()} disabled={status.kind === 'saving'}>
                        {status.kind === 'saving' ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button type="button" className="button button-ghost" onClick={() => setConfirming(false)}>
                        Cancel
                    </button>
                </div>
            )}
            <FormStatus status={status} />
        </div>
    );
}

function ProfilePage() {
    const session = useSession();
    const account = useAccount();
    return (
        <Page title="Profile and favorites">
            <RequireSignIn page="profile">
                {account.error ? (
                    <Notice>
                        {account.error}{' '}
                        <button type="button" className="link-button" onClick={account.reload}>
                            Try again
                        </button>
                    </Notice>
                ) : !account.profile ? (
                    <Pending label="Loading your profile…" />
                ) : (
                    <div className="stack">
                        <div className="grid grid-2">
                            <Card title="Account" note={account.profile.role === 'admin' ? 'Administrator' : undefined}>
                                <dl className="detail-list">
                                    <dt>Email</dt>
                                    <dd>{session.user?.email ?? '—'}</dd>
                                    <dt>Member since</dt>
                                    <dd>{new Date(account.profile.created_at).toLocaleDateString()}</dd>
                                </dl>
                                <div className="button-row">
                                    <button type="button" className="button button-ghost" onClick={session.manageAccount}>
                                        Email, password and security
                                    </button>
                                    <button type="button" className="button button-ghost" onClick={() => void session.signOut()}>
                                        Sign out
                                    </button>
                                </div>
                            </Card>
                            <Card title="Profile">
                                <ProfileForm profile={account.profile} />
                            </Card>
                        </div>
                        <FavoritesList />
                        <Card title="Preferences">
                            <PreferencesForm preferences={account.profile.preferences} />
                        </Card>
                        <Card title="Your data">
                            <DeleteData />
                        </Card>
                    </div>
                )}
            </RequireSignIn>
        </Page>
    );
}

// ----- dashboard -------------------------------------------------------------------------

interface TeamSummary {
    data: { id: number; slug: string; name: string; conference: string | null; seasons: { season: number; wins: number | null; losses: number | null; draws: number | null }[] };
}

function TeamTile({ slug }: { slug: string }) {
    const team = useApi<TeamSummary>(`/api/v1/teams/${encodeURIComponent(slug)}`);
    return (
        <Loaded state={team}>
            {({ data }) => {
                const latest = data.seasons[0];
                return (
                    <a className="stat favorite-tile" href={href('teams', data.slug)}>
                        <div className="stat-label">{data.conference ?? 'Team'}</div>
                        <div className="stat-value is-small">{data.name}</div>
                        <div className="stat-foot">
                            {latest ? `${latest.season}: ${latest.wins ?? 0}-${latest.draws ?? 0}-${latest.losses ?? 0} (W-D-L)` : 'No games recorded'}
                        </div>
                    </a>
                );
            }}
        </Loaded>
    );
}

function DashboardPage() {
    const session = useSession();
    const account = useAccount();
    const name = account.profile?.display_name || session.user?.name;
    return (
        <Page title={name ? `Welcome, ${name}` : 'My dashboard'} lede="Your saved teams and players, with their latest records.">
            <RequireSignIn page="dashboard">
                {account.error ? (
                    <Notice>{account.error}</Notice>
                ) : account.loading && !account.profile ? (
                    <Pending label="Loading your favorites…" />
                ) : (
                    <div className="stack">
                        <Card title="Your teams" note={`${account.teams.length} saved`}>
                            {account.teams.length === 0 ? (
                                <p className="text-sm text-muted">
                                    <Star size={14} aria-hidden="true" /> Save teams from their pages under{' '}
                                    <a className="data-link" href={href('teams')}>Teams</a> to follow them here.
                                </p>
                            ) : (
                                <div className="grid grid-4">
                                    {account.teams.map(t => (
                                        <TeamTile key={t.id} slug={t.slug} />
                                    ))}
                                </div>
                            )}
                        </Card>
                        <Card title="Your players" note={`${account.players.length} saved`}>
                            {account.players.length === 0 ? (
                                <p className="text-sm text-muted">
                                    Save players from their pages under <a className="data-link" href={href('directory')}>Players</a>.
                                </p>
                            ) : (
                                <ul className="favorites-list">
                                    {account.players.map(p => (
                                        <li key={p.id}>
                                            <a className="data-link" href={href('directory', p.id)}>
                                                {p.name}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>
                        <p className="text-sm">
                            <a className="data-link" href={pagePath('profile')}>
                                Manage favorites and preferences
                            </a>
                        </p>
                    </div>
                )}
            </RequireSignIn>
        </Page>
    );
}

// ----- admin ------------------------------------------------------------------------------

interface Run {
    id: number;
    kind: string;
    trigger: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    error: string | null;
}
interface MaintenanceRow {
    id: number;
    action: string;
    target_run_id: number | null;
    reason: string;
    requested_by: string;
    status: string;
    created_at: string;
    note: string | null;
}
interface ErrorRow {
    id: number;
    run_id: number;
    category: string;
    severity: string;
    code: string;
    message: string;
    count: number;
}

function useAdmin<T>(path: string, generation: number) {
    const session = useSession();
    const [state, setState] = useState<{ data: T | null; error: ApiRequestError | null }>({ data: null, error: null });
    useEffect(() => {
        let cancelled = false;
        accountRequest<T>(session.getToken, 'GET', path)
            .then(data => !cancelled && setState({ data, error: null }))
            .catch(err => !cancelled && setState({ data: null, error: err as ApiRequestError }));
        return () => {
            cancelled = true;
        };
    }, [path, session.getToken, generation]);
    return state;
}

function MaintenanceForm({ runs, onDone }: { runs: Run[]; onDone: () => void }) {
    const session = useSession();
    const failed = runs.filter(r => r.status === 'failed' || r.status === 'abandoned');
    const [action, setAction] = useState<'retry_run' | 'rebuild_analytics'>(failed.length ? 'retry_run' : 'rebuild_analytics');
    const [target, setTarget] = useState(failed[0] ? String(failed[0].id) : '');
    const [reason, setReason] = useState('');
    const [confirm, setConfirm] = useState(false);
    const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ kind: 'idle' });
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (reason.trim().length < 10) return setStatus({ kind: 'error', message: 'Give a reason of at least 10 characters.' });
        if (!confirm) return setStatus({ kind: 'error', message: 'Tick the confirmation to authorize this request.' });
        setStatus({ kind: 'saving' });
        try {
            await accountRequest(session.getToken, 'POST', '/api/v1/admin/maintenance', {
                action,
                ...(action === 'retry_run' ? { target_run_id: Number(target) } : {}),
                reason: reason.trim(),
                confirm: true
            });
            setStatus({ kind: 'saved' });
            setReason('');
            setConfirm(false);
            onDone();
        } catch (err) {
            setStatus({ kind: 'error', message: (err as Error).message });
        }
    };
    return (
        <form className="form" onSubmit={submit}>
            <label className="form-field">
                <span className="control-label">Action</span>
                <select className="input" value={action} onChange={e => setAction(e.target.value as typeof action)}>
                    <option value="retry_run" disabled={!failed.length}>
                        Retry a failed run
                    </option>
                    <option value="rebuild_analytics">Rebuild analytics from the database</option>
                </select>
            </label>
            {action === 'retry_run' && (
                <label className="form-field">
                    <span className="control-label">Run</span>
                    <select className="input" value={target} onChange={e => setTarget(e.target.value)}>
                        {failed.map(r => (
                            <option key={r.id} value={r.id}>
                                #{r.id} {r.kind} ({r.status}, {new Date(r.started_at).toLocaleString()})
                            </option>
                        ))}
                    </select>
                </label>
            )}
            <label className="form-field">
                <span className="control-label">Reason (recorded in the audit trail)</span>
                <textarea className="input" rows={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} required />
            </label>
            <label className="form-check">
                <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
                <span>I authorize this maintenance. The worker carries it out after its next scheduled run.</span>
            </label>
            {status.kind === 'saved' ? (
                <p className="form-ok" role="status">
                    Requested. It will run after the next scheduled worker run.
                </p>
            ) : (
                <FormStatus status={status} />
            )}
            <button type="submit" className="button button-primary" disabled={status.kind === 'saving'}>
                {status.kind === 'saving' ? 'Sending…' : 'Request maintenance'}
            </button>
        </form>
    );
}

function AdminConsole() {
    const [generation, setGeneration] = useState(0);
    const runs = useAdmin<{ data: Run[] }>('/api/v1/admin/runs?page_size=15', generation);
    const errors = useAdmin<{ data: ErrorRow[] }>('/api/v1/admin/errors?days=7&page_size=25', generation);
    const requests = useAdmin<{ data: MaintenanceRow[] }>('/api/v1/admin/maintenance?page_size=10', generation);

    if (runs.error) {
        if (runs.error.status === 403) {
            return (
                <Notice>
                    <strong>Administrator access is required.</strong> Your account does not have it. Roles are granted by the
                    operators, never by signing up.
                </Notice>
            );
        }
        return <Notice>{runs.error.message}</Notice>;
    }
    if (!runs.data) return <Pending label="Loading operational data…" />;
    return (
        <div className="stack">
            <Card title="Ingestion runs" note="latest 15" bodyless>
                <div className="table-scroll">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th scope="col">Run</th>
                                <th scope="col">Kind</th>
                                <th scope="col">Trigger</th>
                                <th scope="col">Status</th>
                                <th scope="col">Started</th>
                                <th scope="col">Error</th>
                            </tr>
                        </thead>
                        <tbody>
                            {runs.data.data.map(r => (
                                <tr key={r.id}>
                                    <td>#{r.id}</td>
                                    <td>{r.kind}</td>
                                    <td>{r.trigger}</td>
                                    <td>
                                        <span className={`badge ${r.status === 'succeeded' ? 'is-win' : r.status === 'running' ? 'is-draw' : 'is-loss'}`}>
                                            {r.status}
                                        </span>
                                    </td>
                                    <td>{new Date(r.started_at).toLocaleString()}</td>
                                    <td className="text-sm">{r.error ?? ''}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>
            <Card title="Failed tasks and data issues" note="last 7 days" bodyless>
                <div className="table-scroll">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th scope="col">Run</th>
                                <th scope="col">Severity</th>
                                <th scope="col">Category</th>
                                <th scope="col">Code</th>
                                <th scope="col">Rows</th>
                                <th scope="col">Message</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(errors.data?.data ?? []).map(e => (
                                <tr key={e.id}>
                                    <td>#{e.run_id}</td>
                                    <td>{e.severity}</td>
                                    <td>{e.category}</td>
                                    <td>{e.code}</td>
                                    <td>{e.count}</td>
                                    <td className="text-sm">{e.message}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>
            <div className="grid grid-2">
                <Card title="Request maintenance">
                    <MaintenanceForm runs={runs.data.data} onDone={() => setGeneration(g => g + 1)} />
                </Card>
                <Card title="Maintenance requests">
                    {(requests.data?.data ?? []).length === 0 ? (
                        <p className="text-sm text-muted">None yet.</p>
                    ) : (
                        <ul className="favorites-list">
                            {requests.data!.data.map(m => (
                                <li key={m.id}>
                                    <span>
                                        #{m.id} {m.action}
                                        {m.target_run_id ? ` of run #${m.target_run_id}` : ''} — <strong>{m.status}</strong>
                                        <br />
                                        <span className="text-sm text-muted">
                                            {m.reason} · {new Date(m.created_at).toLocaleString()}
                                        </span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            </div>
        </div>
    );
}

function AdminPage() {
    return (
        <Page title="Operations" lede="Ingestion status, failed tasks and audited maintenance. Every request here is checked and logged by the server.">
            <RequireSignIn page="admin">
                <AdminConsole />
            </RequireSignIn>
        </Page>
    );
}

export function AuthPageView({ page }: { page: AuthPage }) {
    switch (page) {
        case 'login':
            return <Handoff mode="login" />;
        case 'signup':
            return <Handoff mode="signup" />;
        case 'profile':
            return <ProfilePage />;
        case 'dashboard':
            return <DashboardPage />;
        case 'admin':
            return <AdminPage />;
    }
}
