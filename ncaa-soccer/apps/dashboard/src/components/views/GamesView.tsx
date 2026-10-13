import { useState } from 'react';
import { useApi } from '../../api';
import type { Paged } from '../../api';
import { shortDate, BOXSCORE_LABEL, num, STATUS_LABEL } from '../../format';
import { Link, Loaded, Pager, SeasonSelect } from '../data';
import { Card, Notice } from '../ui';

interface GameRow {
    id: number;
    date: string;
    season: number;
    status: string;
    game_type: string | null;
    location_type: string;
    home_score: number | null;
    away_score: number | null;
    boxscore_status: string;
    quality_flags: string[];
    home_team_slug: string;
    home_team_name: string;
    away_team_slug: string;
    away_team_name: string;
}

interface Line {
    player_id: number;
    name: string;
    jersey_number: string | null;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    shots: number | null;
    shots_on_goal: number | null;
    saves: number | null;
}

interface Totals {
    players: number;
    goals: number | null;
    shots: number | null;
    shots_on_goal: number | null;
    saves: number | null;
    reported_score: number | null;
    goals_reconciliation: 'ok' | 'unattributed' | 'excess' | 'unknown';
}

interface Side {
    team_id: number;
    team_slug: string;
    team_name: string;
    totals: Totals | null;
    players: Line[];
}

interface BoxScore {
    game: GameRow & { boxscore_url: string | null; boxscore_url_alt: string | null; last_verified_at: string };
    available: boolean;
    home: Side;
    away: Side;
    unattributed: Line[];
}

export function GamesView({ gameId }: { gameId: string | null }) {
    return gameId ? <GameDetail id={gameId} /> : <GameList />;
}

function GameList() {
    const seasons = useApi<{ data: { season: number }[] }>('/api/v1/seasons');
    const [season, setSeason] = useState<string>('');
    const [status, setStatus] = useState('final');
    const [division, setDivision] = useState('either');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [page, setPage] = useState(1);
    const effectiveSeason = season || String(seasons.data?.data[0]?.season ?? '');
    const games = useApi<Paged<GameRow>>(effectiveSeason ? '/api/v1/games' : null, {
        season: effectiveSeason,
        status: status || undefined,
        division_one: division,
        date_from: from || undefined,
        date_to: to || undefined,
        page,
        page_size: 50
    });
    const reset = (fn: () => void) => () => {
        fn();
        setPage(1);
    };

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Games</h1>
                    <p className="page-lede">
                        Every fixture in the database, merged from both schools’ schedules. Open a game for its box score.
                    </p>
                </div>
            </div>
            <section className="filter-bar" aria-label="Filters">
                {seasons.data && (
                    <SeasonSelect
                        seasons={seasons.data.data.map(s => s.season)}
                        value={effectiveSeason}
                        onChange={v => reset(() => setSeason(v))()}
                    />
                )}
                <div className="control">
                    <label className="control-label" htmlFor="status-select">Status</label>
                    <select id="status-select" value={status} onChange={e => reset(() => setStatus(e.target.value))()}>
                        <option value="">Any</option>
                        <option value="final">Final</option>
                        <option value="scheduled">Scheduled</option>
                        <option value="postponed">Postponed</option>
                        <option value="canceled">Canceled</option>
                    </select>
                </div>
                <div className="control">
                    <label className="control-label" htmlFor="division-games">Teams</label>
                    <select id="division-games" value={division} onChange={e => reset(() => setDivision(e.target.value))()}>
                        <option value="either">Involving Division I</option>
                        <option value="both">Division I vs Division I</option>
                        <option value="all">All</option>
                    </select>
                </div>
                <div className="control">
                    <label className="control-label" htmlFor="from-date">From</label>
                    <input id="from-date" className="date-input" type="date" value={from} onChange={e => reset(() => setFrom(e.target.value))()} />
                </div>
                <div className="control">
                    <label className="control-label" htmlFor="to-date">To</label>
                    <input id="to-date" className="date-input" type="date" value={to} onChange={e => reset(() => setTo(e.target.value))()} />
                </div>
            </section>

            <Loaded state={games} isEmpty={d => d.data.length === 0} empty="No games match these filters.">
                {d => (
                    <Card title={`${num(d.pagination.total)} games`} note="Newest first" bodyless>
                        <div className="table-scroll">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th scope="col">Date</th>
                                        <th scope="col">Home</th>
                                        <th scope="col" className="numeric">Score</th>
                                        <th scope="col">Away</th>
                                        <th scope="col">Status</th>
                                        <th scope="col">Box score</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {d.data.map(g => (
                                        <tr key={g.id}>
                                            <td>{shortDate(g.date)}</td>
                                            <td className="team-cell">
                                                <Link view="teams" id={g.home_team_slug}>{g.home_team_name}</Link>
                                            </td>
                                            <td className="numeric">
                                                {g.home_score === null ? '—' : `${g.home_score}–${g.away_score}`}
                                            </td>
                                            <td className="team-cell">
                                                <Link view="teams" id={g.away_team_slug}>{g.away_team_name}</Link>
                                            </td>
                                            <td className="text-muted">
                                                {STATUS_LABEL[g.status] ?? g.status}
                                                {g.location_type === 'neutral' ? ' · neutral' : ''}
                                            </td>
                                            <td>
                                                <Link view="games" id={g.id}>
                                                    {g.boxscore_status === 'none' ? 'Details' : BOXSCORE_LABEL[g.boxscore_status]}
                                                </Link>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <Pager {...d.pagination} onPage={setPage} />
                    </Card>
                )}
            </Loaded>
        </>
    );
}

const RECONCILIATION: Record<Totals['goals_reconciliation'], string | null> = {
    ok: null,
    unknown: null,
    unattributed: 'Fewer player goals than the score — usually an own goal.',
    excess: 'Player goals exceed the reported score. The source box score and schedule disagree.'
};

function SideTable({ side, score }: { side: Side; score: number | null }) {
    const note = side.totals ? RECONCILIATION[side.totals.goals_reconciliation] : null;
    return (
        <Card title={side.team_name} note={score === null ? undefined : `${score} goal${score === 1 ? '' : 's'}`} bodyless>
            {note && (
                <div className="card-body">
                    <Notice kind={side.totals?.goals_reconciliation === 'excess' ? 'warning' : 'info'}>{note}</Notice>
                </div>
            )}
            {side.players.length === 0 ? (
                <div className="card-body text-muted">No box score for this side.</div>
            ) : (
                <div className="table-scroll">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th scope="col">#</th>
                                <th scope="col">Player</th>
                                <th scope="col" className="numeric">Min</th>
                                <th scope="col" className="numeric">G</th>
                                <th scope="col" className="numeric">A</th>
                                <th scope="col" className="numeric">Sh</th>
                                <th scope="col" className="numeric">SOG</th>
                                <th scope="col" className="numeric">Sv</th>
                            </tr>
                        </thead>
                        <tbody>
                            {side.players.map(p => (
                                <tr key={`${p.player_id}-${p.jersey_number}`}>
                                    <td className="rank-cell">{p.jersey_number ?? ''}</td>
                                    <td className="team-cell">
                                        <Link view="directory" id={p.player_id}>{p.name}</Link>
                                    </td>
                                    <td className="numeric">{num(p.minutes)}</td>
                                    <td className="numeric">{num(p.goals)}</td>
                                    <td className="numeric">{num(p.assists)}</td>
                                    <td className="numeric">{num(p.shots)}</td>
                                    <td className="numeric">{num(p.shots_on_goal)}</td>
                                    <td className="numeric">{num(p.saves)}</td>
                                </tr>
                            ))}
                        </tbody>
                        {side.totals && (
                            <tfoot>
                                <tr>
                                    <td />
                                    <td className="font-medium">Totals</td>
                                    <td />
                                    <td className="numeric font-medium">{num(side.totals.goals)}</td>
                                    <td />
                                    <td className="numeric font-medium">{num(side.totals.shots)}</td>
                                    <td className="numeric font-medium">{num(side.totals.shots_on_goal)}</td>
                                    <td className="numeric font-medium">{num(side.totals.saves)}</td>
                                </tr>
                            </tfoot>
                        )}
                    </table>
                </div>
            )}
        </Card>
    );
}

function GameDetail({ id }: { id: string }) {
    const box = useApi<{ data: BoxScore }>(`/api/v1/games/${encodeURIComponent(id)}/boxscore`);
    return (
        <Loaded state={box}>
            {({ data }) => {
                const g = data.game;
                return (
                    <>
                        <div className="page-header">
                            <div>
                                <p className="text-sm text-muted">
                                    <a className="data-link" href="#/games">Games</a> / {shortDate(g.date)}, {g.season}
                                    {g.location_type === 'neutral' ? ' · neutral site' : ''}
                                    {g.game_type && g.game_type !== 'regular' ? ` · ${g.game_type.replace('_', ' ')}` : ''}
                                </p>
                                <h1 className="page-title">
                                    <Link view="teams" id={g.home_team_slug}>{g.home_team_name}</Link>{' '}
                                    {g.home_score === null ? 'vs' : `${g.home_score}–${g.away_score}`}{' '}
                                    <Link view="teams" id={g.away_team_slug}>{g.away_team_name}</Link>
                                </h1>
                                <p className="page-lede">
                                    {STATUS_LABEL[g.status] ?? g.status} · last verified{' '}
                                    {new Date(g.last_verified_at).toLocaleString()}
                                    {g.boxscore_url && (
                                        <>
                                            {' · '}
                                            <a className="data-link" href={g.boxscore_url} target="_blank" rel="noreferrer noopener">
                                                official box score
                                            </a>
                                        </>
                                    )}
                                </p>
                            </div>
                        </div>
                        {g.quality_flags.includes('score_conflict') && (
                            <Notice>The two schools’ schedules report different scores for this game. The score shown is from the primary source.</Notice>
                        )}
                        {!data.available ? (
                            <div className="empty-state">
                                {g.status === 'final'
                                    ? 'No box score has been collected for this game yet.'
                                    : 'Box scores appear once a game is final.'}
                            </div>
                        ) : (
                            <div className="grid grid-2">
                                <SideTable side={data.home} score={g.home_score} />
                                <SideTable side={data.away} score={g.away_score} />
                            </div>
                        )}
                        {data.unattributed.length > 0 && (
                            <p className="footnote">
                                {data.unattributed.length} player line(s) in this box score carry a team label that could not be
                                matched to either side, and are not shown above.
                            </p>
                        )}
                    </>
                );
            }}
        </Loaded>
    );
}
