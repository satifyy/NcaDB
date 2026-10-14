import { useState } from 'react';
import { useApi } from '../../api';
import type { Paged } from '../../api';
import { shortDate, BOXSCORE_LABEL, num, STATUS_LABEL } from '../../format';
import { Link, Loaded, Pager, ResultBadge, SeasonSelect } from '../data';
import { Card, Stat } from '../ui';

interface TeamListRow {
    id: number;
    slug: string;
    name: string;
    is_division_one: boolean;
    conference: string | null;
    played: number | null;
    wins: number | null;
    draws: number | null;
    losses: number | null;
    goals_for: number | null;
    goals_against: number | null;
}

interface SeasonRecord {
    season: number;
    conference: string | null;
    conference_source: string;
    played: number | null;
    wins: number | null;
    draws: number | null;
    losses: number | null;
    goals_for: number | null;
    goals_against: number | null;
}

interface TeamDetail {
    id: number;
    slug: string;
    name: string;
    is_division_one: boolean;
    conference: string | null;
    schedule_url: string | null;
    platform: string | null;
    seasons: SeasonRecord[];
}

interface TeamGame {
    id: number;
    date: string;
    status: string;
    game_type: string | null;
    venue: 'home' | 'away' | 'neutral';
    opponent_slug: string;
    opponent_name: string;
    opponent_division_one: boolean;
    team_score: number | null;
    opponent_score: number | null;
    boxscore_status: string;
    result: 'W' | 'D' | 'L' | null;
}

interface RosterRow {
    id: number;
    name: string;
    jersey_number: string | null;
    games_played: number | null;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    points: number;
    shots: number | null;
    shots_on_goal: number | null;
    saves: number | null;
}

interface SeasonStats {
    season: number;
    games_with_boxscore: number | null;
    shots: number | null;
    shots_on_goal: number | null;
    saves: number | null;
    shots_against: number | null;
}

const record = (r: { wins: number | null; draws: number | null; losses: number | null }) =>
    r.wins === null ? '—' : `${r.wins}-${r.draws}-${r.losses}`;

export function TeamsView({ searchTerm, teamId }: { searchTerm: string; teamId: string | null }) {
    return teamId ? <TeamProfile slug={teamId} /> : <TeamList searchTerm={searchTerm} />;
}

function TeamList({ searchTerm }: { searchTerm: string }) {
    const [conference, setConference] = useState('');
    const [division, setDivision] = useState('true');
    const [page, setPage] = useState(1);
    const conferences = useApi<{ data: { name: string; teams: number }[] }>('/api/v1/conferences');
    const teams = useApi<Paged<TeamListRow> & { season: number }>('/api/v1/teams', {
        search: searchTerm.trim() || undefined,
        conference: conference || undefined,
        division_one: division,
        page,
        page_size: 50
    });

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Teams</h1>
                    <p className="page-lede">
                        Every program in the database, with its record for the current season. Division I programs
                        are scraped directly; other teams appear because they played one.
                    </p>
                </div>
            </div>

            <section className="filter-bar" aria-label="Filters">
                <div className="control">
                    <label className="control-label" htmlFor="conference-select">
                        Conference
                    </label>
                    <select
                        id="conference-select"
                        value={conference}
                        onChange={e => {
                            setConference(e.target.value);
                            setPage(1);
                        }}
                    >
                        <option value="">All conferences</option>
                        {conferences.data?.data.map(c => (
                            <option key={c.name} value={c.name}>
                                {c.name} ({c.teams})
                            </option>
                        ))}
                    </select>
                </div>
                <div className="control">
                    <label className="control-label" htmlFor="division-select">
                        Programs
                    </label>
                    <select
                        id="division-select"
                        value={division}
                        onChange={e => {
                            setDivision(e.target.value);
                            setPage(1);
                        }}
                    >
                        <option value="true">Division I</option>
                        <option value="false">Opponents outside Division I</option>
                        <option value="all">All</option>
                    </select>
                </div>
            </section>

            <Loaded state={teams} isEmpty={d => d.data.length === 0} empty="No teams match.">
                {d => (
                    <Card title={`${num(d.pagination.total)} teams`} note={`Records are for ${d.season}`} bodyless>
                        <div className="table-scroll">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th scope="col">Team</th>
                                        <th scope="col">Conference</th>
                                        <th scope="col" className="numeric">
                                            W-D-L
                                        </th>
                                        <th scope="col" className="numeric">
                                            GF
                                        </th>
                                        <th scope="col" className="numeric">
                                            GA
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {d.data.map(t => (
                                        <tr key={t.id}>
                                            <td className="team-cell">
                                                <Link view="teams" id={t.slug}>
                                                    {t.name}
                                                </Link>
                                            </td>
                                            <td className="text-muted">{t.conference ?? (t.is_division_one ? '—' : 'Non-D1')}</td>
                                            <td className="numeric">{record(t)}</td>
                                            <td className="numeric">{num(t.goals_for)}</td>
                                            <td className="numeric">{num(t.goals_against)}</td>
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

function TeamProfile({ slug }: { slug: string }) {
    const team = useApi<{ data: TeamDetail }>(`/api/v1/teams/${encodeURIComponent(slug)}`);
    return (
        <Loaded state={team}>
            {({ data }) => <TeamSeasonPage team={data} key={data.id} />}
        </Loaded>
    );
}

function TeamSeasonPage({ team }: { team: TeamDetail }) {
    const seasons = team.seasons.map(s => s.season);
    const [season, setSeason] = useState(String(seasons[0] ?? ''));
    const current = team.seasons.find(s => String(s.season) === season);
    const games = useApi<Paged<TeamGame>>(`/api/v1/teams/${team.id}/games`, { season, page_size: 100, sort: 'date' });
    const roster = useApi<{ data: RosterRow[] }>(`/api/v1/teams/${team.id}/players`, { season, sort: '-points' });
    const stats = useApi<{ data: SeasonStats[] }>(`/api/v1/teams/${team.id}/stats`, { season });
    const totals = stats.data?.data[0];

    return (
        <>
            <div className="page-header">
                <div>
                    <p className="text-sm text-muted">
                        <a className="data-link" href="#/teams">
                            Teams
                        </a>{' '}
                        / {team.conference ?? (team.is_division_one ? 'Division I' : 'Outside Division I')}
                    </p>
                    <h1 className="page-title">{team.name}</h1>
                    {team.schedule_url && (
                        <p className="page-lede">
                            Source:{' '}
                            <a className="data-link" href={team.schedule_url} target="_blank" rel="noreferrer noopener">
                                official schedule
                            </a>
                            {team.platform ? ` (${team.platform})` : ''}
                        </p>
                    )}
                </div>
                {seasons.length > 0 && <SeasonSelect seasons={seasons} value={season} onChange={setSeason} />}
            </div>

            {seasons.length === 0 ? (
                <div className="empty-state">No games recorded for this team.</div>
            ) : (
                <div className="stack">
                    <div className="grid grid-4">
                        <Stat label="Record" value={current ? record(current) : '—'} foot={`${num(current?.played)} completed games`} />
                        <Stat label="Goals" value={`${num(current?.goals_for)} – ${num(current?.goals_against)}`} foot="For – against" />
                        <Stat
                            label="Shots"
                            value={num(totals?.shots)}
                            foot={`${num(totals?.shots_on_goal)} on goal · ${num(totals?.games_with_boxscore)} box scores`}
                        />
                        <Stat label="Saves" value={num(totals?.saves)} foot={`${num(totals?.shots_against)} shots faced`} />
                    </div>

                    <Card title="Schedule and results" note={current?.conference ? `${current.conference} · ${season}` : season} bodyless>
                        <Loaded state={games} isEmpty={d => d.data.length === 0} empty="No games this season.">
                            {d => (
                                <div className="table-scroll">
                                    <table className="data-table">
                                        <thead>
                                            <tr>
                                                <th scope="col">Date</th>
                                                <th scope="col">Opponent</th>
                                                <th scope="col">Venue</th>
                                                <th scope="col">Result</th>
                                                <th scope="col" className="numeric">
                                                    Score
                                                </th>
                                                <th scope="col">Box score</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {d.data.map(g => (
                                                <tr key={g.id}>
                                                    <td>{shortDate(g.date)}</td>
                                                    <td className="team-cell">
                                                        <Link view="teams" id={g.opponent_slug}>
                                                            {g.opponent_name}
                                                        </Link>
                                                        {g.game_type && g.game_type !== 'regular' && (
                                                            <span className="badge" style={{ marginLeft: '0.5rem' }}>
                                                                {g.game_type.replace('_', ' ')}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="text-muted">{g.venue}</td>
                                                    <td>
                                                        {g.status === 'final' ? (
                                                            <ResultBadge result={g.result} />
                                                        ) : (
                                                            <span className="text-muted">{STATUS_LABEL[g.status] ?? g.status}</span>
                                                        )}
                                                    </td>
                                                    <td className="numeric">
                                                        {g.team_score === null ? '—' : `${g.team_score}–${g.opponent_score}`}
                                                    </td>
                                                    <td>
                                                        {g.boxscore_status !== 'none' ? (
                                                            <Link view="games" id={g.id}>
                                                                {BOXSCORE_LABEL[g.boxscore_status]}
                                                            </Link>
                                                        ) : (
                                                            <span className="text-muted">{g.status === 'final' ? 'Missing' : '—'}</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </Loaded>
                    </Card>

                    <Card title="Roster" note="Season totals from box scores" bodyless>
                        <Loaded state={roster} isEmpty={d => d.data.length === 0} empty="No box scores for this team this season.">
                            {d => (
                                <div className="table-scroll">
                                    <table className="data-table">
                                        <thead>
                                            <tr>
                                                <th scope="col">#</th>
                                                <th scope="col">Player</th>
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
                                            {d.data.map(p => (
                                                <tr key={p.id}>
                                                    <td className="rank-cell">{p.jersey_number ?? ''}</td>
                                                    <td className="team-cell">
                                                        <Link view="directory" id={p.id}>
                                                            {p.name}
                                                        </Link>
                                                    </td>
                                                    <td className="numeric">{num(p.games_played)}</td>
                                                    <td className="numeric">{num(p.minutes)}</td>
                                                    <td className="numeric">{num(p.goals)}</td>
                                                    <td className="numeric">{num(p.assists)}</td>
                                                    <td className="numeric">{num(p.shots)}</td>
                                                    <td className="numeric">{num(p.shots_on_goal)}</td>
                                                    <td className="numeric">{num(p.saves)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </Loaded>
                    </Card>

                    {team.seasons.length > 1 && (
                        <Card title="By season" bodyless>
                            <div className="table-scroll">
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th scope="col">Season</th>
                                            <th scope="col">Conference</th>
                                            <th scope="col" className="numeric">W-D-L</th>
                                            <th scope="col" className="numeric">GF</th>
                                            <th scope="col" className="numeric">GA</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {team.seasons.map(s => (
                                            <tr key={s.season}>
                                                <td>
                                                    <button type="button" className="link-button" onClick={() => setSeason(String(s.season))}>
                                                        {s.season}
                                                    </button>
                                                </td>
                                                <td className="text-muted" title={s.conference_source === 'inventory_current' ? 'Current alignment; may differ from that season' : undefined}>
                                                    {s.conference ?? '—'}
                                                </td>
                                                <td className="numeric">{record(s)}</td>
                                                <td className="numeric">{num(s.goals_for)}</td>
                                                <td className="numeric">{num(s.goals_against)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </Card>
                    )}
                    <p className="footnote">
                        Conference shown for past seasons is the program’s current alignment; the source inventory does not
                        record historical membership.
                    </p>
                </div>
            )}
        </>
    );
}
