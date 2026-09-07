import type { SeasonSummary } from '../../types';

interface FilterBarProps {
    seasons: SeasonSummary[];
    season: string;
    onSeasonChange: (season: string) => void;

    conferences: string[];
    conference: string;
    onConferenceChange: (conference: string) => void;

    teams: string[];
    team: string;
    onTeamChange: (team: string) => void;

    /** Players matching the current filters, and the season's total, for context. */
    shown: number;
    total: number;
    onReset: () => void;
    filtered: boolean;
}

/**
 * Season, conference and team, in the order a reader narrows by.
 *
 * The three are dependent rather than independent: choosing a conference restricts the
 * team list to that conference, so the control cannot offer a combination that yields
 * nothing. Seasons are a row of years rather than a dropdown — at five or fewer, showing
 * them all is one click instead of two and makes the dataset's span visible.
 */
export function FilterBar({
    seasons,
    season,
    onSeasonChange,
    conferences,
    conference,
    onConferenceChange,
    teams,
    team,
    onTeamChange,
    shown,
    total,
    onReset,
    filtered
}: FilterBarProps) {
    return (
        <section className="filter-bar" aria-label="Filters">
            <div className="control">
                <label className="control-label" id="season-label">
                    Season
                </label>
                {seasons.length > 1 ? (
                    <div className="segmented" role="group" aria-labelledby="season-label">
                        {seasons.map(s => (
                            <button
                                key={s.season}
                                type="button"
                                aria-pressed={s.season === season}
                                onClick={() => onSeasonChange(s.season)}
                                title={
                                    s.label
                                        ? `${s.players.toLocaleString()} careers across every season`
                                        : `${s.players.toLocaleString()} players`
                                }
                            >
                                {s.label ?? s.season}
                            </button>
                        ))}
                    </div>
                ) : (
                    // One season is not a choice, so it is stated rather than offered —
                    // with why, since an inert control otherwise reads as broken.
                    <div className="segmented" role="group" aria-labelledby="season-label">
                        <button
                            type="button"
                            aria-pressed
                            disabled
                            title={`${season} is the only season scraped so far`}
                        >
                            {season}
                        </button>
                    </div>
                )}
            </div>

            <div className="control">
                <label className="control-label" htmlFor="conference-select">
                    Conference
                </label>
                <select
                    id="conference-select"
                    value={conference}
                    onChange={e => onConferenceChange(e.target.value)}
                >
                    <option value="all">All conferences</option>
                    {conferences.map(c => (
                        <option key={c} value={c}>
                            {c}
                        </option>
                    ))}
                </select>
            </div>

            <div className="control">
                <label className="control-label" htmlFor="team-select">
                    Team
                </label>
                <select id="team-select" value={team} onChange={e => onTeamChange(e.target.value)}>
                    <option value="all">
                        {conference === 'all' ? 'All teams' : `All ${conference} teams`}
                    </option>
                    {teams.map(t => (
                        <option key={t} value={t}>
                            {t}
                        </option>
                    ))}
                </select>
            </div>

            <div className="filter-summary">
                <span>
                    <strong style={{ color: 'var(--color-text-primary)' }}>{shown.toLocaleString()}</strong>
                    {shown === total ? ' players' : ` of ${total.toLocaleString()} players`}
                </span>
                {filtered && (
                    <button type="button" className="link-button" onClick={onReset}>
                        Clear filters
                    </button>
                )}
            </div>
        </section>
    );
}
