import { useEffect, useMemo, useState } from 'react';
import { Bar } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { ANALYTICS, loadPredictions, loadRatings, loadStandouts } from '../../analytics';
import type { PredictedWeek, SeasonPredictions, Standout, TeamRating } from '../../analytics';
import { BAR_GEOMETRY, baseOptions, token } from '../../charts';
import { count, percent, shortDate, signed, weekLabel } from '../../format';
import { Card, MatchCard, Notice, Stat } from '../ui';
import type { ViewId } from '../../views';

/** Conferences with fewer than this many rated teams are too small to average. */
const MIN_CONFERENCE_TEAMS = 4;

interface Props {
    onView: (view: ViewId) => void;
}

/**
 * The front page: what is true right now, with a way into each of the other views.
 *
 * Deliberately narrow. Everything here is either a single number that needs no chart, or
 * the top of a list that the view behind it holds in full — an overview that reproduces
 * every table is not an overview.
 */
export function OverviewView({ onView }: Props) {
    const [ratings, setRatings] = useState<TeamRating[] | null>(null);
    const [predictions, setPredictions] = useState<SeasonPredictions | null>(null);
    const [standouts, setStandouts] = useState<Standout[]>([]);

    useEffect(() => {
        loadRatings().then(setRatings);
        loadPredictions(ANALYTICS.current_season).then(setPredictions);
        loadStandouts().then(setStandouts);
    }, []);

    const divisionOne = useMemo(() => (ratings ?? []).filter(team => team.rated), [ratings]);
    const excluded = ANALYTICS.coverage.filter(season => !season.usable);
    const record = ANALYTICS.prediction_record;

    const week: PredictedWeek | undefined = useMemo(() => {
        const weeks = predictions?.weeks ?? [];
        return weeks.find(entry => entry.week === ANALYTICS.current_week) ?? weeks[weeks.length - 1];
    }, [predictions]);

    // The marquee fixtures of the week: the ones between the best pairs of teams, which is
    // what "the games to watch" means when nothing else about a fixture is known.
    const marquee = useMemo(
        () =>
            [...(week?.games ?? [])]
                .sort((a, b) => b.home_elo + b.away_elo - (a.home_elo + a.away_elo))
                .slice(0, 6),
        [week]
    );

    const latestStandouts = useMemo(() => {
        const inSeason = standouts.filter(entry => entry.season === ANALYTICS.current_season);
        if (inSeason.length === 0) return { week: null as string | null, players: [] as Standout[] };
        const latest = inSeason.reduce((best, entry) => (entry.week > best ? entry.week : best), '');
        return {
            week: latest,
            players: inSeason.filter(entry => entry.week === latest).sort((a, b) => b.impact - a.impact)
        };
    }, [standouts]);

    const conferenceChart = useMemo(() => {
        const byConference = new Map<string, number[]>();
        for (const team of divisionOne) {
            const list = byConference.get(team.conference) ?? [];
            list.push(team.elo);
            byConference.set(team.conference, list);
        }
        const rows = [...byConference]
            .filter(([, elos]) => elos.length >= MIN_CONFERENCE_TEAMS)
            .map(([conference, elos]) => ({
                conference,
                mean: elos.reduce((sum, elo) => sum + elo, 0) / elos.length
            }))
            // Strongest first: with a category y-axis the first label sits at the top.
            .sort((a, b) => b.mean - a.mean);

        return {
            labels: rows.map(row => row.conference),
            // Floor to the 25 below the weakest conference, so the shortest bar is still a
            // bar. A fixed floor renders whichever conference falls under it as nothing.
            floor: rows.length > 0 ? Math.floor(Math.min(...rows.map(r => r.mean)) / 25) * 25 - 25 : 1300,
            datasets: [
                {
                    label: 'Mean Elo',
                    data: rows.map(row => row.mean),
                    backgroundColor: token('--series-1'),
                    ...BAR_GEOMETRY
                }
            ]
        };
    }, [divisionOne]);

    const conferenceOptions = useMemo<ChartOptions<'bar'>>(() => {
        const base = baseOptions<'bar'>();
        return {
            ...base,
            indexAxis: 'y',
            plugins: {
                ...base.plugins,
                tooltip: {
                    ...base.plugins?.tooltip,
                    callbacks: { label: item => `${Math.round(Number(item.parsed.x))} mean Elo` }
                }
            },
            scales: {
                x: {
                    // Not from zero: every conference is somewhere near 1500 and a
                    // zero-based axis would compress the whole range into one stripe.
                    min: conferenceChart.floor,
                    grid: { color: token('--chart-grid') },
                    border: { display: false },
                    ticks: { color: token('--chart-axis'), font: { size: 11 } }
                },
                y: {
                    grid: { display: false },
                    border: { display: false },
                    // Every conference is named: skipping labels on a category axis
                    // leaves bars nobody can identify.
                    ticks: { color: token('--color-text-secondary'), font: { size: 11 }, autoSkip: false }
                }
            }
        };
    }, [conferenceChart.floor]);

    const leader = divisionOne[0];
    const test = ANALYTICS.model.performance.test;

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">
                        {ANALYTICS.current_season} Division I men’s soccer
                    </h1>
                    <p className="page-lede">
                        Ratings, forecasts and player valuations built from{' '}
                        {ANALYTICS.seasons.length} scraped seasons of schedules and box scores. Every number on
                        this site comes from the results themselves — no polls, no votes, no rankings borrowed
                        from anyone.
                    </p>
                </div>
            </div>

            {excluded.length > 0 && (
                <div style={{ marginBottom: 'var(--space-4)' }}>
                    <Notice>
                        <strong>
                            {excluded.map(season => season.season).join(', ')} excluded from every total on this
                            site.
                        </strong>{' '}
                        {excluded
                            .map(
                                season =>
                                    `${season.season}: only ${season.teams_with_roster} of ${season.rated_teams} programs have a roster in the data (${percent(
                                        season.roster_share
                                    )}).`
                            )
                            .join(' ')}{' '}
                        A season missing more than a fifth of the league cannot be compared with one that is
                        complete, so it is named here rather than quietly averaged in.
                    </Notice>
                </div>
            )}

            <div className="grid grid-4" style={{ marginBottom: 'var(--space-4)' }}>
                <Stat
                    label="Top rated team"
                    value={leader?.team ?? '—'}
                    small
                    foot={leader && `${leader.elo} Elo · ${signed(leader.trend)} in four weeks`}
                />
                <Stat
                    label="Prediction accuracy"
                    value={percent(record.overall.accuracy, 1)}
                    foot={`${count(record.overall.games)} completed fixtures, all seasons`}
                />
                <Stat
                    label="Held-out log loss"
                    value={test.log_loss.toFixed(3)}
                    foot={`beats a base-rate forecast at ${test.baseline_log_loss.toFixed(3)}`}
                />
                <Stat
                    label="Seasons rated"
                    value={ANALYTICS.seasons.length}
                    foot={`${ANALYTICS.seasons[0]}–${ANALYTICS.seasons[ANALYTICS.seasons.length - 1]}${
                        excluded.length > 0 ? `, ${excluded.length} excluded` : ''
                    }`}
                />
            </div>

            <div className="stack">
                {marquee.length > 0 && (
                    <Card
                        title={week ? `Games to watch — week of ${weekLabel(week.week)}` : 'This week'}
                        note={
                            <button type="button" className="link-button" onClick={() => onView('predictions')}>
                                every fixture and the model’s record →
                            </button>
                        }
                    >
                        <div className="grid grid-2">
                            {marquee.map(game => (
                                <MatchCard key={game.id} game={game} />
                            ))}
                        </div>
                    </Card>
                )}

                <div className="grid grid-2">
                    <Card
                        title="Top of the table"
                        note={
                            <button type="button" className="link-button" onClick={() => onView('rankings')}>
                                full ratings →
                            </button>
                        }
                        bodyless
                    >
                        <div className="table-scroll">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th className="rank-cell">#</th>
                                        <th>Team</th>
                                        <th>Conference</th>
                                        <th className="numeric">Elo</th>
                                        <th className="numeric">4wk</th>
                                        <th className="numeric">W-D-L</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {divisionOne.slice(0, 10).map(team => (
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
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Card>

                    <Card
                        title="Players of the week"
                        note={
                            latestStandouts.week ? (
                                <button type="button" className="link-button" onClick={() => onView('impact')}>
                                    {weekLabel(latestStandouts.week)} · impact leaderboard →
                                </button>
                            ) : (
                                'No games yet'
                            )
                        }
                        bodyless
                    >
                        <div>
                            {latestStandouts.players.slice(0, 6).map((entry, index) => (
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
                                                ? `${entry.saves} saves`
                                                : `${entry.goals}G ${entry.assists}A`}
                                        </div>
                                    </span>
                                    <span className="standout-value">
                                        <div className="standout-impact">{entry.impact.toFixed(1)}</div>
                                        <div className="standout-meta">impact</div>
                                    </span>
                                </div>
                            ))}
                            {latestStandouts.players.length === 0 && (
                                <div className="card-body">
                                    <Notice kind="info">
                                        No box scores yet for the {ANALYTICS.current_season} season.
                                    </Notice>
                                </div>
                            )}
                        </div>
                    </Card>
                </div>

                <Card title="Conference strength" note="Mean Elo of each conference’s programs">
                    <div className="chart-frame is-list">
                        <Bar data={conferenceChart} options={conferenceOptions} />
                    </div>
                </Card>
            </div>

            <p className="footnote">
                <strong>Where the numbers come from.</strong> Schedules and box scores are scraped from every
                Division I program’s own athletics site, merged on a shared fixture key so the two schools’
                versions of a game become one row, and checked season by season for roster coverage before
                anything is computed from them. Elo is fitted by running the whole history under candidate
                parameters and scoring the ratings each game was played at — never the ratings that game
                produced.
            </p>
        </>
    );
}
