import { useEffect, useMemo, useState } from 'react';
import { Bar, Line } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { ANALYTICS, loadPredictions } from '../../analytics';
import type { PredictedWeek, SeasonPredictions } from '../../analytics';
import { BAR_GEOMETRY, LINE_GEOMETRY, baseOptions, token } from '../../charts';
import { percent, shortDate, weekLabel } from '../../format';
import { Card, Legend, MatchCard, Notice, Stat } from '../ui';

/** Fixtures shown before the "show the rest" control appears. */
const PAGE = 24;

interface Props {
    searchTerm: string;
}

/**
 * The week-by-week forecast, and the record it has earned.
 *
 * A prediction page that only shows the future is unfalsifiable, so every past week keeps
 * the forecast it was given at the time beside what happened. Those forecasts were made
 * from ratings frozen at the start of their week — a Sunday game is never predicted with
 * Friday's result already in the ratings — which is why the hit rate here is one a reader
 * could actually have had in advance.
 */
export function PredictionsView({ searchTerm }: Props) {
    const [season, setSeason] = useState(ANALYTICS.current_season);
    const [week, setWeek] = useState<string | null>(ANALYTICS.current_week);
    const [expanded, setExpanded] = useState(false);

    // The loaded season travels with its data. Clearing it separately when the selection
    // changes would mean writing state from the effect body, and reading `loaded.season`
    // says the same thing without the extra render.
    const [loaded, setLoaded] = useState<{ season: string; file: SeasonPredictions | null } | null>(null);

    useEffect(() => {
        let current = true;
        loadPredictions(season).then(file => {
            if (!current) return;
            setLoaded({ season, file });
            const weeks = file?.weeks ?? [];
            const preferred = weeks.find(w => w.week === ANALYTICS.current_week);
            setWeek((preferred ?? weeks[weeks.length - 1])?.week ?? null);
            setExpanded(false);
        });
        return () => {
            current = false;
        };
    }, [season]);

    const file = loaded?.season === season ? loaded.file : null;
    const weeks = file?.weeks ?? [];
    const selected: PredictedWeek | undefined = weeks.find(entry => entry.week === week) ?? weeks[weeks.length - 1];

    const games = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        const all = selected?.games ?? [];
        if (!term) return all;
        return all.filter(
            game =>
                game.home.toLowerCase().includes(term) ||
                game.away.toLowerCase().includes(term) ||
                game.home_conference.toLowerCase().includes(term) ||
                game.away_conference.toLowerCase().includes(term)
        );
    }, [selected, searchTerm]);

    const record = ANALYTICS.prediction_record;
    const test = ANALYTICS.model.performance.test;

    /**
     * The season's biggest surprises.
     *
     * Ranked by how little probability the model gave what actually happened, which is a
     * better definition of an upset than the rating gap: a 1900-rated side losing to a
     * 1850-rated one is not a shock, and a 61%-favourite losing at home is a bigger one
     * than the raw gap suggests.
     */
    const upsets = useMemo(() => {
        const settled = (file?.weeks ?? []).flatMap(week => week.games).filter(game => game.outcome !== null);
        const chanceGiven = (game: (typeof settled)[number]) =>
            game.outcome === 'home' ? game.p[0] : game.outcome === 'draw' ? game.p[1] : game.p[2];
        return [...settled].sort((a, b) => chanceGiven(a) - chanceGiven(b)).slice(0, 6);
    }, [file]);

    // Log loss against the no-information baseline, one pair of bars per season. Lower is
    // better, and the gap between the pair is what the model is actually worth.
    const lossChart = useMemo(() => {
        const seasons = ANALYTICS.seasons.filter(year => record.by_season[year]);
        return {
            labels: seasons,
            datasets: [
                {
                    label: 'Model',
                    data: seasons.map(year => record.by_season[year]!.log_loss),
                    backgroundColor: token('--series-1'),
                    ...BAR_GEOMETRY
                },
                {
                    label: 'Base rate only',
                    data: seasons.map(year => record.by_season[year]!.baseline_log_loss),
                    backgroundColor: token('--series-2'),
                    ...BAR_GEOMETRY
                }
            ]
        };
    }, [record]);

    const calibration = ANALYTICS.model.performance.calibration;
    const calibrationChart = useMemo(
        () => ({
            datasets: [
                {
                    label: 'Observed',
                    data: calibration.map(point => ({ x: point.predicted, y: point.observed })),
                    borderColor: token('--series-1'),
                    backgroundColor: token('--series-1'),
                    ...LINE_GEOMETRY,
                    pointRadius: 5
                },
                {
                    label: 'Perfect calibration',
                    data: [
                        { x: 0, y: 0 },
                        { x: 1, y: 1 }
                    ],
                    borderColor: token('--chart-axis'),
                    backgroundColor: token('--chart-axis'),
                    borderDash: [4, 4],
                    borderWidth: 1.5,
                    pointRadius: 0
                }
            ]
        }),
        [calibration]
    );

    const calibrationOptions = useMemo<ChartOptions<'line'>>(() => {
        const base = baseOptions<'line'>();
        return {
            ...base,
            interaction: { mode: 'nearest', intersect: true },
            plugins: {
                ...base.plugins,
                tooltip: {
                    ...base.plugins?.tooltip,
                    callbacks: {
                        label: item =>
                            `predicted ${percent(Number(item.parsed.x), 0)} → happened ${percent(
                                Number(item.parsed.y),
                                0
                            )}`
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    min: 0,
                    max: 1,
                    grid: { color: token('--chart-grid') },
                    border: { display: false },
                    ticks: {
                        color: token('--chart-axis'),
                        font: { size: 11 },
                        callback: value => percent(Number(value), 0)
                    },
                    title: { display: true, text: 'Predicted', color: token('--chart-axis'), font: { size: 11 } }
                },
                y: {
                    min: 0,
                    max: 1,
                    grid: { color: token('--chart-grid') },
                    border: { display: false },
                    ticks: {
                        color: token('--chart-axis'),
                        font: { size: 11 },
                        callback: value => percent(Number(value), 0)
                    },
                    title: { display: true, text: 'Happened', color: token('--chart-axis'), font: { size: 11 } }
                }
            }
        };
    }, []);

    const lossOptions = useMemo<ChartOptions<'bar'>>(() => {
        const base = baseOptions<'bar'>();
        return {
            ...base,
            scales: {
                ...base.scales,
                y: {
                    ...base.scales?.y,
                    beginAtZero: false,
                    title: {
                        display: true,
                        text: 'Log loss — lower is better',
                        color: token('--chart-axis'),
                        font: { size: 11 }
                    }
                }
            }
        };
    }, []);

    const visible = expanded ? games : games.slice(0, PAGE);

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Week-by-week predictions</h1>
                    <p className="page-lede">
                        Every fixture gets three probabilities and an expected scoreline, from ratings frozen at
                        the start of its week. Across {ANALYTICS.seasons.length} seasons and{' '}
                        {record.overall.games.toLocaleString()} completed games the model has called{' '}
                        {percent(record.overall.accuracy, 1)} of them correctly — in a sport where roughly one
                        game in five ends level.
                    </p>
                </div>
            </div>

            <div className="grid grid-4" style={{ marginBottom: 'var(--space-4)' }}>
                <Stat
                    label="Correct calls, all seasons"
                    value={percent(record.overall.accuracy, 1)}
                    foot={`${record.overall.games.toLocaleString()} completed fixtures`}
                />
                <Stat
                    label="Held-out log loss"
                    value={test.log_loss.toFixed(3)}
                    foot={`vs ${test.baseline_log_loss.toFixed(3)} knowing only the base rate`}
                />
                <Stat
                    label="Brier score"
                    value={test.brier.toFixed(3)}
                    foot="Squared error over the three outcomes"
                />
                <Stat
                    label="Fitted on"
                    value={`${ANALYTICS.model.fitted_on[0]}–${
                        ANALYTICS.model.fitted_on[ANALYTICS.model.fitted_on.length - 1]
                    }`}
                    small
                    foot={`Scored on ${ANALYTICS.model.held_out.join(' and ')}, which it never saw`}
                />
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

            {!file ? (
                <div className="loading">Loading {season} predictions…</div>
            ) : (
                <div className="stack">
                    <Card
                        title={selected ? `Week of ${weekLabel(selected.week)}` : 'No fixtures'}
                        note={
                            selected?.accuracy
                                ? `${selected.accuracy.correct}/${selected.accuracy.games} correct · log loss ${selected.accuracy.log_loss.toFixed(
                                      3
                                  )}`
                                : 'Not yet played'
                        }
                        bodyless
                    >
                        <div className="card-body">
                            <div className="week-strip">
                                {weeks.map(entry => (
                                    <button
                                        key={entry.week}
                                        type="button"
                                        className="week-pill"
                                        aria-pressed={entry.week === selected?.week}
                                        onClick={() => {
                                            setWeek(entry.week);
                                            setExpanded(false);
                                        }}
                                    >
                                        <span className="week-pill-date">{shortDate(entry.week)}</span>
                                        <span className="week-pill-meta">
                                            {entry.accuracy
                                                ? `${percent(entry.accuracy.accuracy)} · ${entry.games.length}`
                                                : `${entry.games.length} to play`}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="card-body">
                            {visible.length === 0 ? (
                                <Notice kind="info">
                                    No fixtures in this week match the current search.
                                </Notice>
                            ) : (
                                <>
                                    <div className="grid grid-2">
                                        {visible.map(game => (
                                            <MatchCard key={game.id} game={game} />
                                        ))}
                                    </div>
                                    {games.length > PAGE && (
                                        <button
                                            type="button"
                                            className="link-button"
                                            style={{ marginTop: 'var(--space-4)' }}
                                            onClick={() => setExpanded(value => !value)}
                                        >
                                            {expanded
                                                ? 'Show fewer'
                                                : `Show all ${games.length} fixtures this week`}
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    </Card>

                    {upsets.length > 0 && (
                        <Card
                            title={`Biggest upsets of ${season}`}
                            note="Ranked by how little chance the model gave the result"
                        >
                            <div className="grid grid-2">
                                {upsets.map(game => (
                                    <MatchCard key={`upset-${game.id}`} game={game} />
                                ))}
                            </div>
                        </Card>
                    )}

                    <div className="grid grid-2">
                        <Card
                            title="How wrong the model is, by season"
                            note="Log loss against a base-rate forecast"
                            bodyless
                        >
                            <div className="card-body">
                                <div className="chart-frame is-short">
                                    <Bar data={lossChart} options={lossOptions} />
                                </div>
                            </div>
                            <Legend
                                items={[
                                    { label: 'Model', color: '--series-1' },
                                    { label: 'Base rate only', color: '--series-2' }
                                ]}
                            />
                        </Card>

                        <Card
                            title="Calibration"
                            note={`${ANALYTICS.model.held_out.join(' and ')}, held out`}
                            bodyless
                        >
                            <div className="card-body">
                                <div className="chart-frame is-short">
                                    <Line data={calibrationChart} options={calibrationOptions} />
                                </div>
                            </div>
                            <Legend
                                items={[
                                    { label: 'Observed', color: '--series-1' },
                                    { label: 'Perfect calibration', color: '--chart-axis' }
                                ]}
                            />
                        </Card>
                    </div>
                </div>
            )}

            <p className="footnote">
                <strong>Reading the calibration chart.</strong> Every forecast is bucketed by the probability it
                gave, and plotted against how often that thing then happened. A point on the dashed line means
                that when the model says 70%, it happens 70% of the time. Points below the line are
                overconfidence, above it is the opposite. It is the check a single accuracy figure cannot
                make: a model can pick more winners than anyone and still be badly wrong about how sure it is.
                <br />
                <br />
                <strong>Draws.</strong> The NCAA stopped playing regular-season overtime in 2022 and the draw
                rate went from 12% of games to 22% overnight, so the draw band is fitted separately either side
                of that rule change rather than averaged across it.
            </p>
        </>
    );
}
