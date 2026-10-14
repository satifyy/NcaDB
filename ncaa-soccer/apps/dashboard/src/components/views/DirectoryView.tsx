import { useState } from 'react';
import { FavoriteButton } from '../../auth/controls';
import { useApi } from '../../api';
import type { Paged } from '../../api';
import { shortDate, num } from '../../format';
import { Link, Loaded, Pager, ResultBadge, SeasonSelect } from '../data';
import { Card, Notice, Stat } from '../ui';

interface PlayerRow {
    id: number;
    name: string;
    team_slug: string;
    team_name: string;
    conference: string | null;
    games_played: number | null;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    points: number;
    shots: number | null;
    shots_on_goal: number | null;
    saves: number | null;
}

interface PlayerSeason {
    season: number;
    team_slug: string;
    team_name: string;
    jersey_number: string | null;
    games_played: number | null;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    shots: number | null;
    shots_on_goal: number | null;
    saves: number | null;
}

interface PlayerDetail {
    id: number;
    name: string;
    team_slug: string;
    team_name: string;
    conference: string | null;
    seasons: PlayerSeason[];
    career: Record<string, number | null>;
    same_name_elsewhere: { id: number; name: string; team_slug: string; team_name: string; seasons: number[] }[];
}

interface GameLine {
    game_id: number;
    date: string;
    opponent_slug: string | null;
    opponent_name: string | null;
    team_score: number | null;
    opponent_score: number | null;
    result: 'W' | 'D' | 'L' | null;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    shots: number | null;
    shots_on_goal: number | null;
    saves: number | null;
}

const SORTS: { value: string; label: string }[] = [
    { value: '-points', label: 'Points' },
    { value: '-goals', label: 'Goals' },
    { value: '-assists', label: 'Assists' },
    { value: '-minutes', label: 'Minutes' },
    { value: '-shots', label: 'Shots' },
    { value: '-saves', label: 'Saves' },
    { value: 'name', label: 'Name' }
];

export function DirectoryView({ searchTerm, playerId }: { searchTerm: string; playerId: string | null }) {
    return playerId ? <PlayerProfile id={playerId} /> : <PlayerSearch searchTerm={searchTerm} />;
}

function PlayerSearch({ searchTerm }: { searchTerm: string }) {
    const seasons = useApi<{ data: { season: number }[] }>('/api/v1/seasons');
    const [season, setSeason] = useState('');
    const [sort, setSort] = useState('-points');
    const [division, setDivision] = useState('true');
    const [page, setPage] = useState(1);
    const effectiveSeason = season || String(seasons.data?.data[0]?.season ?? '');
    const players = useApi<Paged<PlayerRow>>(effectiveSeason ? '/api/v1/players' : null, {
        season: effectiveSeason,
        search: searchTerm.trim() || undefined,
        sort,
        division_one: division,
        page,
        page_size: 50
    });

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Players</h1>
                    <p className="page-lede">
                        Search by name with the box above. Totals are summed from individual box scores; a player who moved
                        schools appears once per school.
                    </p>
                </div>
            </div>
            <section className="filter-bar" aria-label="Filters">
                {seasons.data && (
                    <SeasonSelect
                        seasons={seasons.data.data.map(s => s.season)}
                        value={effectiveSeason}
                        allowAll="All seasons (career)"
                        onChange={v => {
                            setSeason(v);
                            setPage(1);
                        }}
                    />
                )}
                <div className="control">
                    <label className="control-label" htmlFor="sort-select">Rank by</label>
                    <select id="sort-select" value={sort} onChange={e => { setSort(e.target.value); setPage(1); }}>
                        {SORTS.map(s => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                    </select>
                </div>
                <div className="control">
                    <label className="control-label" htmlFor="division-players">Programs</label>
                    <select id="division-players" value={division} onChange={e => { setDivision(e.target.value); setPage(1); }}>
                        <option value="true">Division I</option>
                        <option value="all">All</option>
                    </select>
                </div>
            </section>
            <Loaded state={players} isEmpty={d => d.data.length === 0} empty="No players match.">
                {d => (
                    <Card title={`${num(d.pagination.total)} players`} bodyless>
                        <div className="table-scroll">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th scope="col">Player</th>
                                        <th scope="col">Team</th>
                                        <th scope="col" className="numeric">GP</th>
                                        <th scope="col" className="numeric">Min</th>
                                        <th scope="col" className="numeric">G</th>
                                        <th scope="col" className="numeric">A</th>
                                        <th scope="col" className="numeric">Pts</th>
                                        <th scope="col" className="numeric">Sh</th>
                                        <th scope="col" className="numeric">Sv</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {d.data.map(p => (
                                        <tr key={`${p.id}-${p.team_slug}`}>
                                            <td className="team-cell">
                                                <Link view="directory" id={p.id}>{p.name}</Link>
                                            </td>
                                            <td>
                                                <Link view="teams" id={p.team_slug}>{p.team_name}</Link>
                                            </td>
                                            <td className="numeric">{num(p.games_played)}</td>
                                            <td className="numeric">{num(p.minutes)}</td>
                                            <td className="numeric">{num(p.goals)}</td>
                                            <td className="numeric">{num(p.assists)}</td>
                                            <td className="numeric font-bold">{num(p.points)}</td>
                                            <td className="numeric">{num(p.shots)}</td>
                                            <td className="numeric">{num(p.saves)}</td>
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

function PlayerProfile({ id }: { id: string }) {
    const player = useApi<{ data: PlayerDetail }>(`/api/v1/players/${encodeURIComponent(id)}`);
    const [page, setPage] = useState(1);
    const games = useApi<Paged<GameLine>>(`/api/v1/players/${encodeURIComponent(id)}/games`, { page, page_size: 25 });

    return (
        <Loaded state={player}>
            {({ data: p }) => (
                <>
                    <div className="page-header">
                        <div>
                            <p className="text-sm text-muted">
                                <a className="data-link" href="#/directory">Players</a> /{' '}
                                <Link view="teams" id={p.team_slug}>{p.team_name}</Link>
                            </p>
                            <h1 className="page-title">{p.name}</h1>
                            <p className="page-lede">
                                {p.seasons.length} season{p.seasons.length === 1 ? '' : 's'} at {p.team_name}
                                {p.conference ? ` (${p.conference})` : ''}
                            </p>
                        </div>
                        <div className="page-actions">
                            <FavoriteButton kind="player" id={p.id} label="player" />
                        </div>
                    </div>
                    <div className="stack">
                        <div className="grid grid-4">
                            <Stat label="Games" value={num(p.career.games_played)} foot={`${num(p.career.minutes)} minutes`} />
                            <Stat label="Goals" value={num(p.career.goals)} foot={`${num(p.career.shots)} shots`} />
                            <Stat label="Assists" value={num(p.career.assists)} />
                            <Stat label="Saves" value={num(p.career.saves)} />
                        </div>

                        <Card title="By season" bodyless>
                            <div className="table-scroll">
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th scope="col">Season</th>
                                            <th scope="col">#</th>
                                            <th scope="col" className="numeric">GP</th>
                                            <th scope="col" className="numeric">Min</th>
                                            <th scope="col" className="numeric">G</th>
                                            <th scope="col" className="numeric">A</th>
                                            <th scope="col" className="numeric">Sh</th>
                                            <th scope="col" className="numeric">SOG</th>
                                            <th scope="col" className="numeric">Sv</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {p.seasons.map(s => (
                                            <tr key={s.season}>
                                                <td>{s.season}</td>
                                                <td className="text-muted">{s.jersey_number ?? ''}</td>
                                                <td className="numeric">{num(s.games_played)}</td>
                                                <td className="numeric">{num(s.minutes)}</td>
                                                <td className="numeric">{num(s.goals)}</td>
                                                <td className="numeric">{num(s.assists)}</td>
                                                <td className="numeric">{num(s.shots)}</td>
                                                <td className="numeric">{num(s.shots_on_goal)}</td>
                                                <td className="numeric">{num(s.saves)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </Card>

                        <Card title="Game log" bodyless>
                            <Loaded state={games} isEmpty={d => d.data.length === 0} empty="No games recorded.">
                                {d => (
                                    <>
                                        <div className="table-scroll">
                                            <table className="data-table">
                                                <thead>
                                                    <tr>
                                                        <th scope="col">Date</th>
                                                        <th scope="col">Opponent</th>
                                                        <th scope="col">Result</th>
                                                        <th scope="col" className="numeric">Min</th>
                                                        <th scope="col" className="numeric">G</th>
                                                        <th scope="col" className="numeric">A</th>
                                                        <th scope="col" className="numeric">Sh</th>
                                                        <th scope="col" className="numeric">Sv</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {d.data.map(g => (
                                                        <tr key={g.game_id}>
                                                            <td>
                                                                <Link view="games" id={g.game_id}>{shortDate(g.date)}</Link>
                                                            </td>
                                                            <td>
                                                                {g.opponent_slug ? (
                                                                    <Link view="teams" id={g.opponent_slug}>{g.opponent_name}</Link>
                                                                ) : (
                                                                    '—'
                                                                )}
                                                            </td>
                                                            <td>
                                                                <ResultBadge result={g.result} />{' '}
                                                                <span className="text-muted">
                                                                    {g.team_score === null ? '' : `${g.team_score}–${g.opponent_score}`}
                                                                </span>
                                                            </td>
                                                            <td className="numeric">{num(g.minutes)}</td>
                                                            <td className="numeric">{num(g.goals)}</td>
                                                            <td className="numeric">{num(g.assists)}</td>
                                                            <td className="numeric">{num(g.shots)}</td>
                                                            <td className="numeric">{num(g.saves)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                        <Pager {...d.pagination} onPage={setPage} />
                                    </>
                                )}
                            </Loaded>
                        </Card>

                        {p.same_name_elsewhere.length > 0 && (
                            <Notice kind="info">
                                The same name also appears at{' '}
                                {p.same_name_elsewhere.map((o, i) => (
                                    <span key={o.id}>
                                        {i > 0 && ', '}
                                        <Link view="directory" id={o.id}>{o.team_name}</Link> ({o.seasons.join(', ')})
                                    </span>
                                ))}
                                . That may be a transfer or a different person — box scores carry no player id, so the records
                                are kept separate.
                            </Notice>
                        )}
                    </div>
                </>
            )}
        </Loaded>
    );
}
