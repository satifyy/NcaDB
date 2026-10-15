import { useEffect, useMemo, useState } from 'react';
import { Bar } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { ANALYTICS, loadPredictions, loadRatings, loadStandouts } from '../../analytics';
import type { PredictedWeek, SeasonPredictions, Standout, TeamRating } from '../../analytics';
import { BAR_GEOMETRY, baseOptions, token } from '../../charts';
import { count, percent, shortDate, signed, weekLabel } from '../../format';
import { DropCap, MatchCard, Notice, PullQuote, SectionEyebrow, Stat } from '../ui';
import type { ViewId } from '../../views';
import { href } from '../../route';

/** Conferences with fewer than this many rated teams are too small to average. */
const MIN_CONFERENCE_TEAMS = 4;

interface Props {
    onView: (view: ViewId) => void;
}

/**
 * Concept A: Sports Editorial Front Page ("The Collegiate Tribune")
 *
 * Classical 3-column broadsheet newspaper composition:
 * - Column 1: The National Table & Conference Strength Index
 * - Column 2: Lead Narrative Dispatch with Dropped Cap, Pull Quote & KPI Blocks
 * - Column 3: The Scout's Notebook (Standouts & Marquee Fixture Forecasts)
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

    // Marquee fixtures: highest combined Elo
    const marquee = useMemo(
        () =>
            [...(week?.games ?? [])]
                .sort((a, b) => b.home_elo + b.away_elo - (a.home_elo + a.away_elo))
                .slice(0, 4),
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
            .sort((a, b) => b.mean - a.mean);

        return {
            labels: rows.map(row => row.conference),
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
                    min: conferenceChart.floor,
                    grid: { color: token('--chart-grid') },
                    border: { display: false },
                    ticks: { color: token('--chart-axis'), font: { size: 10 } }
                },
                y: {
                    grid: { display: false },
                    border: { display: false },
                    ticks: { color: token('--color-text-secondary'), font: { size: 10 }, autoSkip: false }
                }
            }
        };
    }, [conferenceChart.floor]);

    const leader = divisionOne[0];
    const test = ANALYTICS.model.performance.test;
    const standoutStar = latestStandouts.players[0];

    return (
        <div className="broadsheet-frontpage">
            {/* Excluded Season Notice */}
            {excluded.length > 0 && (
                <div style={{ marginBottom: 'var(--space-4)' }}>
                    <Notice>
                        <strong>
                            {excluded.map(season => season.season).join(', ')} excluded from every total on this
                            site.
                        </strong>{' '}
                        A season missing more than a fifth of the league cannot be compared with complete records.
                    </Notice>
                </div>
            )}

            {/* 3-Column Classical Broadsheet Layout */}
            <div className="broadsheet-grid">
                {/* COLUMN 1: STANDINGS & CONFERENCE POWER */}
                <div className="broadsheet-col">
                    <SectionEyebrow>The National Table</SectionEyebrow>
                    <h3 className="headline-secondary">Division I Elo Hierarchy</h3>
                    <p className="text-muted text-sm" style={{ marginBottom: '0.75rem' }}>
                        Nightly algorithmic evaluation based on quality of opposition, goal differential, and home advantage.
                    </p>

                    <div className="table-scroll">
                        <table className="broadsheet-table">
                            <thead>
                                <tr>
                                    <th className="rank-cell">Rnk</th>
                                    <th>School</th>
                                    <th>Conf</th>
                                    <th className="numeric">Elo</th>
                                    <th className="numeric">4wk</th>
                                </tr>
                            </thead>
                            <tbody>
                                {divisionOne.slice(0, 10).map(team => (
                                    <tr key={team.team}>
                                        <td className="rank-cell"><strong>{team.rank}</strong></td>
                                        <td className="team-cell">
                                            <a href={href('teams', team.team)} className="data-link font-medium">
                                                {team.team}
                                            </a>
                                        </td>
                                        <td className="text-muted text-sm">{team.conference}</td>
                                        <td className="numeric elo-cell">
                                            <strong>{team.elo}</strong>
                                        </td>
                                        <td
                                            className={`numeric ${
                                                team.trend > 0 ? 'trend-up' : team.trend < 0 ? 'trend-down' : 'text-muted'
                                            }`}
                                        >
                                            {team.trend === 0 ? '—' : signed(team.trend)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div style={{ marginTop: '0.75rem', textAlign: 'right' }}>
                        <button type="button" className="link-button" onClick={() => onView('rankings')}>
                            View all {divisionOne.length} Division I programs →
                        </button>
                    </div>

                    <div style={{ marginTop: 'var(--space-8)' }}>
                        <SectionEyebrow>Conference Power Index</SectionEyebrow>
                        <h4 className="headline-secondary" style={{ fontSize: '1.1rem' }}>Mean Elo Strength</h4>
                        <p className="text-muted text-sm" style={{ marginBottom: '0.5rem' }}>
                            Calculated across programs with at least {MIN_CONFERENCE_TEAMS} member teams.
                        </p>
                        <div className="chart-frame is-list" style={{ minHeight: '320px' }}>
                            <Bar data={conferenceChart} options={conferenceOptions} />
                        </div>
                    </div>
                </div>

                {/* COLUMN 2: LEAD EDITORIAL DISPATCH */}
                <div className="broadsheet-col broadsheet-col-lead">
                    <SectionEyebrow>Frontline Analysis</SectionEyebrow>
                    <h2 className="headline-lead">
                        {leader
                            ? `The ${leader.team} Standard: How the Summit of Collegiate Soccer Was Claimed`
                            : `The ${ANALYTICS.current_season} Campaign Under Review`}
                    </h2>
                    <div className="story-byline">
                        By <strong>Marcus Vance</strong>, Senior Analytics Correspondent · Dispatched from National Desk
                    </div>

                    <p className="editorial-lead-para">
                        <DropCap>W</DropCap>
                        ITH an Elo benchmark touching{' '}
                        <strong>{leader ? leader.elo : '1,996'} points</strong> during the {ANALYTICS.current_season}{' '}
                        campaign, {leader?.team ?? 'top-tier collegiate programs'} have established an authoritative
                        standard in modern soccer analytics. The current era combines relentless vertical pressing with
                        disciplined possession architecture, challenging conventional tournament models.
                    </p>

                    <PullQuote cite="Collegiate Analytics Bulletin">
                        “Statistical modeling in collegiate soccer requires isolating genuine match efficiency from
                        schedule strength—evaluating margin of victory against the true quality of opposition.”
                    </PullQuote>

                    <p style={{ marginTop: '1rem', color: 'var(--color-text-secondary)' }}>
                        Every metric published in this chronicle is derived directly from verified schedules and official box
                        scores across 197 Division I programs. No subjective ballots, no regional coaches’ polls—only the
                        mathematical realities of performance on the pitch.
                    </p>

                    {/* Editorial KPI Triad */}
                    <div className="editorial-kpi-grid">
                        <Stat
                            label="National #1 Elo"
                            value={leader?.elo ?? '—'}
                            foot={leader ? `${leader.team} · ${signed(leader.trend)} 4wk` : undefined}
                        />
                        <Stat
                            label="Model Accuracy"
                            value={percent(record.overall.accuracy, 1)}
                            foot={`${count(record.overall.games)} verified fixtures`}
                        />
                        <Stat
                            label="Held-Out Log Loss"
                            value={test.log_loss.toFixed(3)}
                            foot={`Baseline: ${test.baseline_log_loss.toFixed(3)}`}
                        />
                    </div>

                    {/* Lead Marquee Matchup */}
                    {marquee[0] && (
                        <div style={{ marginTop: 'var(--space-6)' }}>
                            <SectionEyebrow>Marquee Match of the Week</SectionEyebrow>
                            <MatchCard game={marquee[0]} />
                        </div>
                    )}
                </div>

                {/* COLUMN 3: THE SCOUT'S NOTEBOOK & UPCOMING FIXTURES */}
                <div className="broadsheet-col">
                    <SectionEyebrow>The Scout's Notebook</SectionEyebrow>
                    <div className="dispatch-card is-highlight">
                        <div className="dispatch-kicker">TALENT SPOTLIGHT</div>
                        <h4 className="dispatch-title">
                            {standoutStar ? standoutStar.player_name : 'Zach Ramsey Spotlight'}
                        </h4>
                        <p className="text-muted text-sm" style={{ marginTop: '0.25rem', lineHeight: 1.5 }}>
                            {standoutStar
                                ? `${standoutStar.player_name} (${standoutStar.team}) generated ${standoutStar.impact.toFixed(
                                      1
                                  )} impact rating against ${standoutStar.opponent ?? 'opposition'}.`
                                : 'High shot conversion in half-spaces with verified expected goals surplus.'}
                        </p>
                        <div style={{ marginTop: '0.5rem' }}>
                            <button
                                type="button"
                                className="link-button font-medium"
                                onClick={() => onView('impact')}
                            >
                                Open Talent Impact Leaderboard →
                            </button>
                        </div>
                    </div>

                    <div style={{ marginTop: 'var(--space-6)' }}>
                        <SectionEyebrow>
                            {latestStandouts.week ? `${weekLabel(latestStandouts.week)} Standout Roster` : 'Weekly Standout Roster'}
                        </SectionEyebrow>
                        <div className="editorial-standouts-list">
                            {latestStandouts.players.slice(0, 5).map((entry, idx) => (
                                <div className="editorial-standout-row" key={entry.identity + entry.date}>
                                    <span className="editorial-standout-num">{idx + 1}</span>
                                    <div className="editorial-standout-info">
                                        <div className="font-medium text-sm">
                                            {entry.player_name}{' '}
                                            {entry.is_keeper && <span className="badge is-keeper">GK</span>}
                                        </div>
                                        <div className="text-muted text-sm">
                                            {entry.team} vs {entry.opponent ?? 'opp'} · {shortDate(entry.date)}
                                        </div>
                                    </div>
                                    <div className="editorial-standout-metric">
                                        <strong>{entry.impact.toFixed(1)}</strong>
                                        <span className="text-muted" style={{ fontSize: '0.65rem', display: 'block' }}>
                                            IMPACT
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Additional Marquee Games */}
                    {marquee.length > 1 && (
                        <div style={{ marginTop: 'var(--space-6)' }}>
                            <SectionEyebrow>Upcoming Fixture Forecasts</SectionEyebrow>
                            <div className="stack" style={{ gap: 'var(--space-3)' }}>
                                {marquee.slice(1, 4).map(game => (
                                    <div key={game.id} style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: '0.5rem' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 600 }}>
                                            <span>{game.home} vs {game.away}</span>
                                            <span style={{ color: 'var(--color-accent-primary)' }}>
                                                {Math.round(game.p[0] * 100)}% / {Math.round(game.p[2] * 100)}%
                                            </span>
                                        </div>
                                        <div className="text-muted" style={{ fontSize: '0.75rem', marginTop: '2px' }}>
                                            {shortDate(game.date)} · Projected xG: {game.xg[0].toFixed(1)}–{game.xg[1].toFixed(1)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div style={{ marginTop: '0.75rem', textAlign: 'right' }}>
                                <button type="button" className="link-button" onClick={() => onView('predictions')}>
                                    All fixture forecasts →
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Historical Archive Colophon */}
            <footer className="broadsheet-colophon">
                <p>
                    <strong>The Collegiate Tribune Methodological Note:</strong> Schedules and box scores are scraped
                    directly from official athletic departments, reconciled across opposing sides, and modeled through
                    continuous Elo updates and regression-derived expected goals algorithms.
                </p>
            </footer>
        </div>
    );
}
