import { useEffect, useMemo, useState } from 'react';
import { Bar, Scatter } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { ANALYTICS, loadImpact, loadStandouts } from '../../analytics';
import type { ImpactPlayer, Standout } from '../../analytics';
import { BAR_GEOMETRY, baseOptions, token } from '../../charts';
import { count, shortDate, weekLabel } from '../../format';
import { Card, Legend, Notice, Stat } from '../ui';

type SortKey = 'impact' | 'per90' | 'rating' | 'goals' | 'assists' | 'saves' | 'minutes' | 'opponents';

const COLUMNS: { key: SortKey; label: string }[] = [
    { key: 'impact', label: 'Impact' },
    { key: 'per90', label: 'Per 90' },
    { key: 'rating', label: 'Pctl' },
    { key: 'goals', label: 'G' },
    { key: 'assists', label: 'A' },
    { key: 'saves', label: 'Sv' },
    { key: 'minutes', label: 'Min' },
    { key: 'opponents', label: 'Opp Elo' }
];

const LEADERBOARD = 40;
const BAR_ROWS = 15;

interface Props {
    searchTerm: string;
}

/**
 * Player impact: everything a box score records, in one unit.
 *
 * A scoring leaderboard answers "who scored most", which is a different question from
 * "who was worth most" in a dataset where a third of the fixtures are against opponents
 * outside Division I and a goalkeeper never appears on it at all. Impact converts goals,
 * chances and saves into goal equivalents, scales them by the opponent's rating at
 * kickoff, and shrinks short samples toward the league mean so a substitute who scored
 * once in twenty minutes does not top the country.
 */
export function ImpactView({ searchTerm }: Props) {
    const [season, setSeason] = useState(ANALYTICS.current_season);
    // Keyed by the season it belongs to, so switching seasons shows the loading state
    // without a second render to clear the old one.
    const [loaded, setLoaded] = useState<{ season: string; players: ImpactPlayer[] } | null>(null);
    const [standouts, setStandouts] = useState<Standout[]>([]);
    const [conference, setConference] = useState('all');
    const [sort, setSort] = useState<SortKey>('impact');
    const [role, setRole] = useState<'all' | 'outfield' | 'keeper'>('all');

    useEffect(() => {
        let current = true;
        loadImpact(season).then(players => current && setLoaded({ season, players }));
        return () => {
            current = false;
        };
    }, [season]);

    const players = loaded?.season === season ? loaded.players : null;

    useEffect(() => {
        loadStandouts().then(setStandouts);
    }, []);

    const conferences = useMemo(
        () => [...new Set((players ?? []).map(player => player.conference))].sort(),
        [players]
    );

    const filtered = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        return (players ?? []).filter(player => {
            if (conference !== 'all' && player.conference !== conference) return false;
            if (role === 'keeper' && !player.keeper) return false;
            if (role === 'outfield' && player.keeper) return false;
            if (!term) return true;
            return (
                player.name.toLowerCase().includes(term) ||
                player.team.toLowerCase().includes(term) ||
                player.conference.toLowerCase().includes(term)
            );
        });
    }, [players, conference, role, searchTerm]);

    /**
     * Ranked lists hold players with enough minutes to rank, from Division I schools.
     *
     * The rest stay in the file so a search for a specific player still finds them, and
     * selecting the "Other / Non-D1" conference ranks them too — a third of the players
     * here are opponents from D2, D3 and NAIA programs, and a D2 forward's twenty goals
     * against D2 defences is not a Division I leaderboard entry.
     */
    const ranked = useMemo(() => {
        const qualified = filtered.filter(
            player => player.qualified && (player.d1 || conference !== 'all')
        );
        return [...qualified].sort((a, b) => b[sort] - a[sort]);
    }, [filtered, sort, conference]);

    const leader = ranked[0];
    const bestKeeper = useMemo(
        () => [...ranked].filter(p => p.keeper).sort((a, b) => b.impact - a.impact)[0],
        [ranked]
    );
    const bestRate = useMemo(() => [...ranked].sort((a, b) => b.per90 - a.per90)[0], [ranked]);

    const barChart = useMemo(() => {
        // Highest first: with a category y-axis the first label sits at the top.
        const top = [...ranked].sort((a, b) => b.impact - a.impact).slice(0, BAR_ROWS);
        return {
            labels: top.map(player => player.name),
            datasets: [
                {
                    label: 'Impact',
                    data: top.map(player => player.impact),
                    backgroundColor: token('--series-1'),
                    ...BAR_GEOMETRY
                }
            ]
        };
    }, [ranked]);

    const barOptions = useMemo<ChartOptions<'bar'>>(() => {
        const base = baseOptions<'bar'>();
        return {
            ...base,
            indexAxis: 'y',
            plugins: {
                ...base.plugins,
                tooltip: {
                    ...base.plugins?.tooltip,
                    callbacks: {
                        label: item => `${Number(item.parsed.x).toFixed(1)} goal equivalents`
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: token('--chart-grid') },
                    border: { display: false },
                    ticks: { color: token('--chart-axis'), font: { size: 11 } }
                },
                y: {
                    grid: { display: false },
                    border: { display: false },
                    ticks: { color: token('--color-text-secondary'), font: { size: 11 } }
                }
            }
        };
    }, []);

    // Two series only. A scatter compares every pair of colours at once, and the palette
    // is validated all-pairs to three slots; two keeps it comfortably inside that.
    const scatterChart = useMemo(() => {
        const point = (player: ImpactPlayer) => ({ x: player.minutes, y: player.per90 });
        return {
            datasets: [
                {
                    label: 'Outfield',
                    data: ranked.filter(player => !player.keeper).map(point),
                    backgroundColor: token('--series-1'),
                    pointRadius: 3,
                    pointHoverRadius: 6
                },
                {
                    label: 'Goalkeeper',
                    data: ranked.filter(player => player.keeper).map(point),
                    backgroundColor: token('--series-3'),
                    pointRadius: 3,
                    pointHoverRadius: 6
                }
            ]
        };
    }, [ranked]);

    const scatterOptions = useMemo<ChartOptions<'scatter'>>(() => {
        const base = baseOptions<'scatter'>();
        return {
            ...base,
            interaction: { mode: 'nearest', intersect: true },
            plugins: {
                ...base.plugins,
                tooltip: {
                    ...base.plugins?.tooltip,
                    callbacks: {
                        label: item =>
                            `${Math.round(Number(item.parsed.x))} min · ${Number(item.parsed.y).toFixed(2)} per 90`
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: token('--chart-grid') },
                    border: { display: false },
                    ticks: { color: token('--chart-axis'), font: { size: 11 } },
                    title: { display: true, text: 'Minutes played', color: token('--chart-axis'), font: { size: 11 } }
                },
                y: {
                    grid: { color: token('--chart-grid') },
                    border: { display: false },
                    ticks: { color: token('--chart-axis'), font: { size: 11 } },
                    title: {
                        display: true,
                        text: 'Impact per 90',
                        color: token('--chart-axis'),
                        font: { size: 11 }
                    }
                }
            }
        };
    }, []);

    const weeksOfSeason = useMemo(() => {
        const inSeason = standouts.filter(entry => entry.season === season);
        const weeks = [...new Set(inSeason.map(entry => entry.week))].sort().reverse();
        return weeks.map(week => ({
            week,
            players: inSeason.filter(entry => entry.week === week).sort((a, b) => b.impact - a.impact)
        }));
    }, [standouts, season]);

    // The chosen week carries its season, so changing season starts again at the most
    // recent week rather than at whatever index the previous season was showing.
    const [chosenWeek, setChosenWeek] = useState<{ season: string; index: number }>({ season, index: 0 });
    const weekIndex = chosenWeek.season === season ? chosenWeek.index : 0;
    const setWeekIndex = (next: number) => setChosenWeek({ season, index: next });
    const featuredWeek = weeksOfSeason[Math.min(weekIndex, Math.max(weeksOfSeason.length - 1, 0))];

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Player impact</h1>
                    <p className="page-lede">
                        Goals, chances and saves converted into one currency — goal equivalents — then scaled by
                        who they came against and shrunk toward the league mean where the sample is short. It is
                        the only leaderboard here on which a goalkeeper can finish first.
                    </p>
                </div>
            </div>

            <div className="chip-row" style={{ marginBottom: 'var(--space-4)' }}>
                {[...ANALYTICS.seasons].reverse().map(year => (
                    <button
                        key={year}
                        type="button"
                        className="chip"
                        aria-pressed={year === season}
                        style={year === season ? { backgroundColor: 'var(--color-accent-light)' } : undefined}
                        onClick={() => setSeason(year)}
                    >
                        {year}
                    </button>
                ))}
            </div>

            {!players ? (
                <div className="loading">Loading {season} impact…</div>
            ) : (
                <>
                    <div className="grid grid-3" style={{ marginBottom: 'var(--space-4)' }}>
                        <Stat
                            label={`Most valuable, ${season}`}
                            value={leader?.name ?? '—'}
                            small
                            foot={
                                leader &&
                                `${leader.team} · ${leader.impact.toFixed(1)} goal equivalents in ${leader.games} games`
                            }
                        />
                        <Stat
                            label="Best per 90"
                            value={bestRate?.name ?? '—'}
                            small
                            foot={bestRate && `${bestRate.team} · ${bestRate.per90.toFixed(2)} per 90`}
                        />
                        <Stat
                            label="Best goalkeeper"
                            value={bestKeeper?.name ?? '—'}
                            small
                            foot={
                                bestKeeper &&
                                `${bestKeeper.team} · ${bestKeeper.saves} saves over ${bestKeeper.keeper_games} recorded games`
                            }
                        />
                    </div>

                    <div className="stack">
                        {featuredWeek && (
                            <Card
                                title="Players of the week"
                                note={
                                    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                                        <button
                                            type="button"
                                            className="link-button"
                                            disabled={weekIndex >= weeksOfSeason.length - 1}
                                            onClick={() => setWeekIndex(weekIndex + 1)}
                                        >
                                            ← earlier
                                        </button>
                                        {weekLabel(featuredWeek.week)}
                                        <button
                                            type="button"
                                            className="link-button"
                                            disabled={weekIndex === 0}
                                            onClick={() => setWeekIndex(Math.max(0, weekIndex - 1))}
                                        >
                                            later →
                                        </button>
                                    </span>
                                }
                                bodyless
                            >
                                <div>
                                    {featuredWeek.players.slice(0, 6).map((entry, index) => (
                                        <div className="standout" key={entry.identity + entry.date}>
                                            <span className={`standout-rank ${index === 0 ? 'is-first' : ''}`}>
                                                {index + 1}
                                            </span>
                                            <span>
                                                <span className="standout-name">{entry.player_name}</span>{' '}
                                                {entry.is_keeper && <span className="badge is-keeper">GK</span>}
                                                <div className="standout-meta">
                                                    {entry.team} vs {entry.opponent ?? 'unknown'} ·{' '}
                                                    {shortDate(entry.date)} ·{' '}
                                                    {entry.is_keeper
                                                        ? `${entry.saves} saves, ${entry.goals_against} conceded`
                                                        : `${entry.goals}G ${entry.assists}A in ${entry.minutes}'`}
                                                </div>
                                            </span>
                                            <span className="standout-value">
                                                <div className="standout-impact">{entry.impact.toFixed(1)}</div>
                                                <div className="standout-meta">
                                                    {entry.result && (
                                                        <span
                                                            className={`badge ${
                                                                entry.result === 'W'
                                                                    ? 'is-win'
                                                                    : entry.result === 'L'
                                                                      ? 'is-loss'
                                                                      : 'is-draw'
                                                            }`}
                                                        >
                                                            {entry.result} {entry.score}
                                                        </span>
                                                    )}
                                                </div>
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </Card>
                        )}

                        <div className="grid grid-2">
                            <Card title={`Top ${BAR_ROWS} by impact`} note={`${season} season`}>
                                <div className="chart-frame is-tall">
                                    <Bar data={barChart} options={barOptions} />
                                </div>
                            </Card>

                            <Card
                                title="Rate against workload"
                                note="Every qualified player"
                                bodyless
                            >
                                <div className="card-body">
                                    <div className="chart-frame is-tall">
                                        <Scatter data={scatterChart} options={scatterOptions} />
                                    </div>
                                </div>
                                <Legend
                                    items={[
                                        { label: 'Outfield', color: '--series-1' },
                                        { label: 'Goalkeeper', color: '--series-3' }
                                    ]}
                                />
                            </Card>
                        </div>

                        <Card
                            title="Impact leaderboard"
                            note={`${count(ranked.length)} qualified ${
                                conference === 'all' ? 'Division I ' : ''
                            }players`}
                            bodyless
                        >
                            <div
                                className="card-body"
                                style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}
                            >
                                <div className="control" style={{ maxWidth: 260 }}>
                                    <label className="control-label" htmlFor="impact-conference">
                                        Conference
                                    </label>
                                    <select
                                        id="impact-conference"
                                        value={conference}
                                        onChange={event => setConference(event.target.value)}
                                    >
                                        <option value="all">All conferences</option>
                                        {conferences.map(name => (
                                            <option key={name} value={name}>
                                                {name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="control">
                                    <span className="control-label">Role</span>
                                    <div className="segmented" role="group" aria-label="Role">
                                        {(['all', 'outfield', 'keeper'] as const).map(option => (
                                            <button
                                                key={option}
                                                type="button"
                                                aria-pressed={role === option}
                                                onClick={() => setRole(option)}
                                            >
                                                {option === 'all'
                                                    ? 'Everyone'
                                                    : option === 'outfield'
                                                      ? 'Outfield'
                                                      : 'Keepers'}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {ranked.length === 0 ? (
                                <div className="card-body">
                                    <Notice kind="info">No qualified players match these filters.</Notice>
                                </div>
                            ) : (
                                <div className="table-scroll">
                                    <table className="data-table">
                                        <thead>
                                            <tr>
                                                <th className="rank-cell">#</th>
                                                <th>Player</th>
                                                <th>Team</th>
                                                {COLUMNS.map(column => (
                                                    <th
                                                        key={column.key}
                                                        className="numeric sortable"
                                                        onClick={() => setSort(column.key)}
                                                        aria-sort={sort === column.key ? 'descending' : 'none'}
                                                    >
                                                        {column.label}
                                                        {sort === column.key ? ' ▾' : ''}
                                                    </th>
                                                ))}

                                            </tr>
                                        </thead>
                                        <tbody>
                                            {ranked.slice(0, LEADERBOARD).map((player, index) => (
                                                <tr key={player.id}>
                                                    <td className="rank-cell">{index + 1}</td>
                                                    <td className="team-cell">
                                                        {player.name}{' '}
                                                        {player.keeper && <span className="badge is-keeper">GK</span>}
                                                    </td>
                                                    <td className="text-muted">{player.team}</td>
                                                    <td className="numeric elo-cell">{player.impact.toFixed(1)}</td>
                                                    <td className="numeric">{player.per90.toFixed(2)}</td>
                                                    <td className="numeric" style={{ minWidth: 120 }}>
                                                        <span
                                                            style={{
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                gap: '0.5rem',
                                                                justifyContent: 'flex-end'
                                                            }}
                                                        >
                                                            {player.rating.toFixed(1)}
                                                            <span
                                                                className="meter"
                                                                style={{ minWidth: 56, width: 56 }}
                                                                role="img"
                                                                aria-label={`better than ${player.rating.toFixed(
                                                                    1
                                                                )}% of qualified players`}
                                                            >
                                                                <span
                                                                    className="meter-fill"
                                                                    style={{ width: `${player.rating}%` }}
                                                                />
                                                            </span>
                                                        </span>
                                                    </td>
                                                    <td className="numeric">{player.goals}</td>
                                                    <td className="numeric">{player.assists}</td>
                                                    <td className="numeric">{player.saves}</td>
                                                    <td className="numeric">{count(player.minutes)}</td>
                                                    <td className="numeric text-muted">{player.opponents}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </Card>
                    </div>
                </>
            )}

            <p className="footnote">
                <strong>Opponent Elo</strong> is the average rating of the teams a player faced, and it is the
                column to check before believing a total. Conference membership is current alignment
                throughout, so a programme that has since moved up to Division I appears in earlier seasons
                playing a schedule its rating shows was not a Division I one.
                <br />
                <br />
                <strong>Goalkeepers, and what is missing.</strong> Half the team-games in this dataset have no
                saves recorded at all — the box score simply does not carry the column. A keeper is judged only
                on the games that do, so their totals cover roughly half a season and the leaderboard says how
                many games that was. Judging them on the rest would charge every goal to a keeper who,
                as far as the data shows, faced nothing else.
                <br />
                <br />
                <strong>What impact counts.</strong> A goal is one unit, an assist 0.75, and a shot on target
                that did not score is worth the goals a shot on target actually produced that season. A
                goalkeeper is credited with the goals they prevented relative to a league-average save rate on
                the same shots. Everything is multiplied by the opponent's Elo at kickoff, so a goal against a
                national contender counts for more than one against an exhibition opponent.
                <br />
                <br />
                <strong>What it does not.</strong> Nothing in a college box score measures defending, so a
                centre back’s number here reflects their attacking contribution only. Percentile is against the
                season’s qualified players, and the bar for qualifying scales with how much of the season has
                been played — about a third of what a regular has on the clock, up to three full games once the
                season is over. Players below it stay in the data and stay searchable; they are only kept off
                the ranked lists.
            </p>
        </>
    );
}
