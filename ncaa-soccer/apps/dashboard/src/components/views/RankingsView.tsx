import { useEffect, useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { ANALYTICS, loadRatings, loadTimeline } from '../../analytics';
import type { EloTimeline, TeamRating } from '../../analytics';
import type { ChartOptions } from 'chart.js';
import { baseOptions, LINE_GEOMETRY, MAX_SERIES, seriesColor, SERIES, token } from '../../charts';
import { count, shortDate, signed } from '../../format';
import { Card, Legend, Notice, Stat } from '../ui';

type SortKey = 'rank' | 'elo' | 'trend' | 'wins' | 'goals_for' | 'peak_elo';

/** Sortable numeric columns, in the order they read. Team and conference are not sortable. */
const COLUMNS: { key: SortKey; label: string }[] = [
    { key: 'elo', label: 'Elo' },
    { key: 'trend', label: '4wk' },
    { key: 'wins', label: 'W-D-L' },
    { key: 'goals_for', label: 'GF / GA' },
    { key: 'peak_elo', label: 'Peak' }
];

/** Teams the timeline will draw at once. The palette is validated to five slots. */
const MAX_LINES = MAX_SERIES;

/**
 * Rows shown before the reader asks for more.
 *
 * All 197 programs in one page is 10,000 pixels of table, and nobody scrolls to 150th.
 * The top fifty is the part anyone reads; the rest is one click away.
 */
const PAGE = 50;

interface Props {
    searchTerm: string;
}

/**
 * The rating table and where each team's rating has been.
 *
 * Two questions, and they want different forms. "Who is best right now" is a ranked
 * table — a bar chart of two hundred teams is unreadable and a table sorts. "How did they
 * get there" is a line, and only for the handful of teams a reader picks out, because
 * two hundred lines is a texture rather than a chart.
 */
export function RankingsView({ searchTerm }: Props) {
    const [ratings, setRatings] = useState<TeamRating[] | null>(null);
    const [timeline, setTimeline] = useState<EloTimeline | null>(null);
    const [conference, setConference] = useState('all');
    const [sort, setSort] = useState<SortKey>('rank');
    const [selected, setSelected] = useState<string[]>([]);
    const [span, setSpan] = useState<'current' | 'all'>('current');
    const [showAll, setShowAll] = useState(false);

    useEffect(() => {
        loadRatings().then(setRatings);
        loadTimeline().then(setTimeline);
    }, []);

    const divisionOne = useMemo(() => (ratings ?? []).filter(team => team.rated), [ratings]);

    // The default selection is the top five, set once the ratings arrive rather than held
    // as state that has to be kept in step with them.
    useEffect(() => {
        if (divisionOne.length > 0 && selected.length === 0) {
            setSelected(divisionOne.slice(0, MAX_LINES).map(team => team.team));
        }
    }, [divisionOne, selected.length]);

    const conferences = useMemo(
        () => [...new Set(divisionOne.map(team => team.conference))].sort(),
        [divisionOne]
    );

    const rows = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        const filtered = divisionOne.filter(team => {
            if (conference !== 'all' && team.conference !== conference) return false;
            if (!term) return true;
            return team.team.toLowerCase().includes(term) || team.conference.toLowerCase().includes(term);
        });
        return [...filtered].sort((a, b) => {
            if (sort === 'rank') return a.rank - b.rank;
            if (sort === 'wins') return b.wins - a.wins || a.losses - b.losses;
            return (b[sort] as number) - (a[sort] as number);
        });
    }, [divisionOne, conference, searchTerm, sort]);

    const toggle = (team: string) => {
        setSelected(current => {
            if (current.includes(team)) return current.filter(name => name !== team);
            if (current.length >= MAX_LINES) return current;
            return [...current, team];
        });
    };

    const chart = useMemo(() => {
        if (!timeline) return null;
        const from = span === 'current' ? `${ANALYTICS.current_season}-01-01` : '';
        const byTeam = new Map(timeline.teams.map(entry => [entry.team, entry.points]));

        const weeks = [
            ...new Set(
                selected.flatMap(team =>
                    (byTeam.get(team) ?? []).filter(([week]) => week >= from).map(([week]) => week)
                )
            )
        ].sort();

        return {
            labels: weeks,
            datasets: selected.map((team, index) => {
                const points = new Map((byTeam.get(team) ?? []).filter(([week]) => week >= from));
                return {
                    label: team,
                    data: weeks.map(week => points.get(week) ?? null),
                    borderColor: seriesColor(index),
                    backgroundColor: seriesColor(index),
                    // Teams do not play every week, so the line bridges the idle ones
                    // rather than breaking into disconnected fragments.
                    spanGaps: true,
                    ...LINE_GEOMETRY
                };
            })
        };
    }, [timeline, selected, span]);

    const timelineOptions = useMemo<ChartOptions<'line'>>(() => {
        const base = baseOptions<'line'>();
        return {
            ...base,
            plugins: {
                ...base.plugins,
                tooltip: {
                    ...base.plugins?.tooltip,
                    callbacks: {
                        title: items => `Week of ${shortDate(String(items[0].label))}`,
                        label: item => `${item.dataset.label}: ${Math.round(Number(item.parsed.y))}`
                    }
                }
            },
            scales: {
                ...base.scales,
                x: {
                    ...base.scales?.x,
                    ticks: {
                        color: token('--chart-axis'),
                        font: { size: 11 },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 10,
                        // Eleven seasons of weekly labels do not fit; at that span the
                        // year is the only part a reader needs.
                        callback(value) {
                            const label = String(this.getLabelForValue(Number(value)));
                            return span === 'all' ? label.slice(0, 4) : shortDate(label);
                        }
                    }
                }
            }
        };
    }, [span]);

    const leader = divisionOne[0];
    const riser = useMemo(
        () => [...divisionOne].sort((a, b) => b.trend - a.trend)[0],
        [divisionOne]
    );

    if (!ratings) return <div className="loading">Loading ratings…</div>;

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Elo ratings</h1>
                    <p className="page-lede">
                        Every Division I program on one scale, updated after each result. A rating of 1500 is
                        an average team; roughly 100 points of gap is the difference between a coin flip and a
                        two-thirds favourite. Ratings carry over between seasons at{' '}
                        {(ANALYTICS.model.elo.carryover * 100).toFixed(0)}% — college squads turn over, and a
                        rating built by a graduating class should not survive them intact.
                    </p>
                </div>
            </div>

            <div className="grid grid-4" style={{ marginBottom: 'var(--space-4)' }}>
                <Stat
                    label="Top rated"
                    value={leader?.team ?? '—'}
                    small
                    foot={leader && `${leader.elo} Elo · ${leader.conference}`}
                />
                <Stat
                    label="Biggest four-week rise"
                    value={riser ? signed(riser.trend) : '—'}
                    foot={riser && `${riser.team} · now ${riser.elo}`}
                />
                <Stat label="Programs rated" value={count(divisionOne.length)} foot="Division I inventory" />
                <Stat
                    label="Seasons behind the ratings"
                    value={ANALYTICS.seasons.length}
                    foot={`${ANALYTICS.seasons[0]}–${ANALYTICS.seasons[ANALYTICS.seasons.length - 1]}`}
                />
            </div>

            <div className="stack">
                <Card
                    title="Rating history"
                    note={`Pick up to ${MAX_LINES} teams`}
                    bodyless
                >
                    <div style={{ padding: '0 var(--space-5) var(--space-4)' }}>
                        <div className="chip-row" style={{ marginBottom: 'var(--space-3)' }}>
                            <button
                                type="button"
                                className="chip"
                                aria-pressed={span === 'current'}
                                style={span === 'current' ? { backgroundColor: 'var(--color-accent-light)' } : undefined}
                                onClick={() => setSpan('current')}
                            >
                                {ANALYTICS.current_season} season
                            </button>
                            <button
                                type="button"
                                className="chip"
                                aria-pressed={span === 'all'}
                                style={span === 'all' ? { backgroundColor: 'var(--color-accent-light)' } : undefined}
                                onClick={() => setSpan('all')}
                            >
                                All seasons
                            </button>
                        </div>
                        <div className="chip-row">
                            {rows.slice(0, 24).map(team => {
                                const index = selected.indexOf(team.team);
                                const on = index >= 0;
                                return (
                                    <button
                                        key={team.team}
                                        type="button"
                                        className="chip"
                                        aria-pressed={on}
                                        onClick={() => toggle(team.team)}
                                        disabled={!on && selected.length >= MAX_LINES}
                                        style={
                                            on
                                                ? { backgroundColor: 'rgba(148,163,184,0.14)' }
                                                : selected.length >= MAX_LINES
                                                  ? { opacity: 0.45 }
                                                  : undefined
                                        }
                                    >
                                        {on && (
                                            <span
                                                className="chip-dot"
                                                style={{ backgroundColor: `var(${SERIES[index]})` }}
                                            />
                                        )}
                                        {team.team}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {chart && chart.datasets.length > 0 ? (
                        <>
                            <div className="card-body">
                                <div className="chart-frame is-tall">
                                    <Line data={chart} options={timelineOptions} />
                                </div>
                            </div>
                            <Legend
                                items={selected.map((team, index) => ({ label: team, color: SERIES[index] }))}
                            />
                        </>
                    ) : (
                        <div className="card-body">
                            <Notice kind="info">Choose a team above to draw its rating history.</Notice>
                        </div>
                    )}
                </Card>

                <Card title="The table" note={`${rows.length} of ${divisionOne.length} programs`} bodyless>
                    <div style={{ padding: '0 var(--space-5) var(--space-4)' }}>
                        <div className="control" style={{ maxWidth: 260 }}>
                            <label className="control-label" htmlFor="rank-conference">
                                Conference
                            </label>
                            <select
                                id="rank-conference"
                                value={conference}
                                onChange={event => {
                                    setConference(event.target.value);
                                    setShowAll(false);
                                }}
                            >
                                <option value="all">All conferences</option>
                                {conferences.map(name => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="table-scroll">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th
                                        className="sortable rank-cell"
                                        onClick={() => setSort('rank')}
                                        aria-sort={sort === 'rank' ? 'descending' : 'none'}
                                    >
                                        #{sort === 'rank' ? ' ▾' : ''}
                                    </th>
                                    <th>Team</th>
                                    <th>Conference</th>
                                    {COLUMNS.map(column => (
                                        <th
                                            key={column.key}
                                            className="sortable numeric"
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
                                {(showAll ? rows : rows.slice(0, PAGE)).map(team => (
                                    <tr key={team.team}>
                                        <td className="rank-cell">{team.rank}</td>
                                        <td className="team-cell">{team.team}</td>
                                        <td className="text-muted">{team.conference}</td>
                                        <td className="numeric elo-cell">{team.elo}</td>
                                        <td
                                            className={`numeric delta ${
                                                team.trend > 0 ? 'is-up' : team.trend < 0 ? 'is-down' : 'is-flat'
                                            }`}
                                        >
                                            {team.trend === 0 ? '—' : signed(team.trend)}
                                        </td>
                                        <td className="numeric">
                                            {team.wins}-{team.draws}-{team.losses}
                                        </td>
                                        <td className="numeric">
                                            {team.goals_for} / {team.goals_against}
                                        </td>
                                        <td className="numeric">
                                            {team.peak_elo}
                                            <span className="text-muted"> ’{team.peak_season.slice(2)}</span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {rows.length > PAGE && (
                        <div className="card-body">
                            <button type="button" className="link-button" onClick={() => setShowAll(value => !value)}>
                                {showAll ? 'Show the top 50 only' : `Show all ${rows.length} programs`}
                            </button>
                        </div>
                    )}
                </Card>
            </div>

            <p className="footnote">
                <strong>How the rating moves.</strong> A result shifts both teams by up to{' '}
                {ANALYTICS.model.elo.k.toFixed(0)} points, scaled by how surprising it was and by the margin —
                logarithmically, so a 5–0 counts for more than a 1–0 and much less than five times as much.
                Home advantage is worth {ANALYTICS.model.elo.homeAdvantage.toFixed(0)} points and is not applied
                at neutral sites. Opponents outside Division I enter at{' '}
                {ANALYTICS.model.elo.initialUnrated.toFixed(0)} rather than 1500, so beating an exhibition
                opponent is not worth the same as beating a peer. W-D-L covers the {ANALYTICS.current_season}{' '}
                season only.
            </p>
        </>
    );
}
