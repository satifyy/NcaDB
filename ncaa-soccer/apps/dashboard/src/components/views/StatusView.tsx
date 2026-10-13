import { useState } from 'react';
import { apiGet, useApi } from '../../api';
import { percent, num } from '../../format';
import { Loaded } from '../data';
import { Card, Notice, Stat } from '../ui';

interface Coverage {
    season: number;
    games: number;
    final: number;
    scheduled: number;
    boxscore_complete: number;
    boxscore_partial: number;
    boxscore_missing: number;
    boxscore_coverage: number | null;
    score_conflicts: number;
    goals_excess: number;
    players: number;
    division_one_teams_with_games: number;
    last_final_date: string | null;
}

interface Run {
    id: number;
    kind: string;
    trigger: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    seconds: number | null;
    totals: Record<string, number> | null;
}

export interface DataStatus {
    freshness: {
        last_successful_sync: string | null;
        hours_since_sync: number | null;
        last_final_game_date: string | null;
        latest_run: { id: number; kind: string; status: string; started_at: string } | null;
    };
    coverage: Coverage[];
    recent_runs: Run[];
    latest_run_issues: { category: string; severity: string; code: string; rows: number }[];
}

const STATUS_CLASS: Record<string, string> = {
    succeeded: 'is-win',
    failed: 'is-loss',
    abandoned: 'is-loss',
    running: 'is-upset',
    skipped: 'is-draw'
};

function ago(iso: string | null): string {
    if (!iso) return 'never';
    const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
    if (hours < 48) return `${hours.toFixed(1)} h ago`;
    return `${Math.round(hours / 24)} days ago`;
}

export function StatusView() {
    const status = useApi<DataStatus>('/api/v1/data-status');
    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Data status</h1>
                    <p className="page-lede">
                        How fresh and how complete the database is. The ingestion worker runs nightly at 3:00 AM Central;
                        coverage is measured against what the schools themselves published.
                    </p>
                </div>
            </div>
            <Loaded state={status}>
                {s => (
                    <div className="stack">
                        {s.freshness.hours_since_sync !== null && s.freshness.hours_since_sync > 36 && (
                            <Notice>
                                The last successful sync was {ago(s.freshness.last_successful_sync)}. Recent results may be missing.
                            </Notice>
                        )}
                        <div className="grid grid-4">
                            <Stat label="Last sync" value={ago(s.freshness.last_successful_sync)} small
                                foot={s.freshness.last_successful_sync ? new Date(s.freshness.last_successful_sync).toLocaleString() : undefined} />
                            <Stat label="Latest completed game" value={s.freshness.last_final_game_date ?? '—'} small />
                            <Stat label="Latest run" small
                                value={s.freshness.latest_run ? `#${s.freshness.latest_run.id} ${s.freshness.latest_run.status}` : '—'}
                                foot={s.freshness.latest_run?.kind} />
                            <Stat label="Seasons" value={s.coverage.length} small
                                foot={s.coverage.length ? `${s.coverage[0].season}–${s.coverage[s.coverage.length - 1].season}` : undefined} />
                        </div>

                        <Card title="Coverage by season" note="Box scores counted per completed game" bodyless>
                            <div className="table-scroll">
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th scope="col">Season</th>
                                            <th scope="col" className="numeric">Games</th>
                                            <th scope="col" className="numeric">Completed</th>
                                            <th scope="col" className="numeric">Both box scores</th>
                                            <th scope="col" className="numeric">One side</th>
                                            <th scope="col" className="numeric">Missing</th>
                                            <th scope="col" className="numeric">Coverage</th>
                                            <th scope="col" className="numeric">Players</th>
                                            <th scope="col" className="numeric">D1 teams</th>
                                            <th scope="col" className="numeric">Flags</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {[...s.coverage].reverse().map(c => (
                                            <tr key={c.season}>
                                                <td className="font-medium">{c.season}</td>
                                                <td className="numeric">{num(c.games)}</td>
                                                <td className="numeric">{num(c.final)}</td>
                                                <td className="numeric">{num(c.boxscore_complete)}</td>
                                                <td className="numeric">{num(c.boxscore_partial)}</td>
                                                <td className="numeric">{num(c.boxscore_missing)}</td>
                                                <td className="numeric">{c.boxscore_coverage === null ? '—' : percent(c.boxscore_coverage)}</td>
                                                <td className="numeric">{num(c.players)}</td>
                                                <td className="numeric">{num(c.division_one_teams_with_games)}</td>
                                                <td className="numeric" title="Score conflicts between sources · teams with more player goals than their score">
                                                    {c.score_conflicts + c.goals_excess || ''}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </Card>

                        <Card title="Recent ingestion runs" bodyless>
                            <div className="table-scroll">
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th scope="col">Run</th>
                                            <th scope="col">Kind</th>
                                            <th scope="col">Status</th>
                                            <th scope="col">Started</th>
                                            <th scope="col" className="numeric">Duration</th>
                                            <th scope="col" className="numeric">Games +/~</th>
                                            <th scope="col" className="numeric">Stat rows +/~</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {s.recent_runs.map(r => (
                                            <tr key={r.id}>
                                                <td className="rank-cell">#{r.id}</td>
                                                <td>{r.kind}{r.trigger === 'cron' ? '' : ` (${r.trigger})`}</td>
                                                <td><span className={`badge ${STATUS_CLASS[r.status] ?? ''}`}>{r.status}</span></td>
                                                <td className="text-muted">{new Date(r.started_at).toLocaleString()}</td>
                                                <td className="numeric">{r.seconds === null ? '—' : `${Math.round(r.seconds / 60)} min`}</td>
                                                <td className="numeric">
                                                    {r.totals ? `${num(r.totals.games_inserted)} / ${num(r.totals.games_updated)}` : '—'}
                                                </td>
                                                <td className="numeric">
                                                    {r.totals ? `${num(r.totals.player_stats_inserted)} / ${num(r.totals.player_stats_updated)}` : '—'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </Card>

                        {s.latest_run_issues.length > 0 && (
                            <Card title="Data-quality issues in the latest load" note="Rows rejected or flagged, not altered" bodyless>
                                <div className="table-scroll">
                                    <table className="data-table">
                                        <thead>
                                            <tr>
                                                <th scope="col">Issue</th>
                                                <th scope="col">Category</th>
                                                <th scope="col" className="numeric">Rows</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {s.latest_run_issues.map(i => (
                                                <tr key={i.code}>
                                                    <td>{i.code.replace(/_/g, ' ')}</td>
                                                    <td className="text-muted">{i.category}</td>
                                                    <td className="numeric">{num(i.rows)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </Card>
                        )}
                        <OperationsPanel />
                    </div>
                )}
            </Loaded>
        </>
    );
}

const TOKEN_KEY = 'ncadb-admin-token';

function readToken(): string {
    try {
        return sessionStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
        return '';
    }
}

interface AdminRun {
    id: number;
    kind: string;
    status: string;
    error: string | null;
    started_at: string;
    stats: Record<string, unknown>;
}

/**
 * Run details and errors, from the token-protected admin routes. The token lives in
 * session storage only, and nothing here can start a scrape.
 */
function OperationsPanel() {
    const [token, setToken] = useState(readToken);
    const [draft, setDraft] = useState('');
    const [runs, setRuns] = useState<AdminRun[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = async (value: string) => {
        setError(null);
        try {
            const result = await apiGet<{ data: AdminRun[] }>('/api/v1/admin/runs', { page_size: 15 }, {
                headers: { Authorization: `Bearer ${value}` }
            });
            setRuns(result.data);
            setToken(value);
            try {
                sessionStorage.setItem(TOKEN_KEY, value);
            } catch {
                /* storage unavailable; keep it in memory */
            }
        } catch (err) {
            setRuns(null);
            setError((err as Error).message);
        }
    };

    return (
        <Card title="Operations" note="Admin token required">
            {runs === null ? (
                <form
                    className="filter-bar"
                    style={{ marginBottom: 0 }}
                    onSubmit={e => {
                        e.preventDefault();
                        void load(draft || token);
                    }}
                >
                    <div className="control" style={{ flex: '1 1 260px' }}>
                        <label className="control-label" htmlFor="admin-token">Admin token</label>
                        <input id="admin-token" className="date-input" type="password" autoComplete="off"
                            value={draft} onChange={e => setDraft(e.target.value)} placeholder={token ? 'Saved for this session' : ''} />
                    </div>
                    <button type="submit" className="pager-button">Load run details</button>
                    {error && <span className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</span>}
                </form>
            ) : (
                <div className="table-scroll">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th scope="col">Run</th>
                                <th scope="col">Kind</th>
                                <th scope="col">Status</th>
                                <th scope="col">Started</th>
                                <th scope="col">Error</th>
                            </tr>
                        </thead>
                        <tbody>
                            {runs.map(r => (
                                <tr key={r.id}>
                                    <td className="rank-cell">#{r.id}</td>
                                    <td>{r.kind}</td>
                                    <td><span className={`badge ${STATUS_CLASS[r.status] ?? ''}`}>{r.status}</span></td>
                                    <td className="text-muted">{new Date(r.started_at).toLocaleString()}</td>
                                    <td className="text-sm" style={{ whiteSpace: 'normal', maxWidth: '48ch' }}>{r.error ?? ''}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="footnote">
                        Full task and error detail: <code>GET /api/v1/admin/runs/:id</code>. To re-run a failed run, use the worker
                        CLI (<code>retry</code>) — see OPERATIONS.md.
                    </p>
                </div>
            )}
        </Card>
    );
}
