import { useEffect, useMemo, useState } from 'react';
import { FilterBar } from '../Layout/FilterBar';
import { KPIGrid } from '../Dashboard/KPIGrid';
import { ChartsGrid } from '../Dashboard/ChartsGrid';
import { PlayerTable } from '../Dashboard/PlayerTable';
import { MoversPanel } from '../Dashboard/MoversPanel';
import manifest from '../../data/manifest.json';
import type { Manifest, PlayerStat, SeasonFile } from '../../types';
import { Notice } from '../ui';
import { percent } from '../../format';

/**
 * One module per season, resolved but not fetched.
 *
 * A season is around 2 MB of JSON. Importing them all to display one would make every
 * reader wait on seasons they did not ask for, so Vite is asked for lazy loaders and
 * splits each season into its own chunk.
 */
const seasonModules = import.meta.glob<{ default: SeasonFile }>('../../data/seasons/*.json');

const INDEX = manifest as Manifest;

/**
 * The schools and conferences a row belongs to.
 *
 * A season row has exactly one of each. An all-time row can have several, because a
 * career follows the player through transfers, and filtering by any school they played
 * for is what a reader means by "Indiana players".
 */
/** One empty array, so "no season loaded" is the same value every render. */
const NO_PLAYERS: PlayerStat[] = [];

const teamsOf = (p: PlayerStat) => p.teams ?? [p.team_id];
const conferencesOf = (p: PlayerStat) => p.conferences ?? [p.conference];

interface Props {
    searchTerm: string;
    onSearch: (term: string) => void;
}

/** Raw season totals: the counting stats, unadjusted, as the box scores recorded them. */
export function PlayersView({ searchTerm, onSearch }: Props) {
    const [season, setSeason] = useState(INDEX.default_season);
    const [conference, setConference] = useState('all');
    const [team, setTeam] = useState('all');

    /**
     * The season on screen, with the season it belongs to.
     *
     * Fetch the selected season's players. The season being switched away from is ignored
     * when its request resolves late, so a quick series of clicks cannot leave the page
     * showing a season other than the one selected — and because the loaded season is part
     * of the value, "still loading" is something to read rather than a flag to reset.
     */
    const [loaded, setLoaded] = useState<{
        season: string;
        players: PlayerStat[];
        meta: Pick<SeasonFile, 'movers_mode' | 'compared_to'> | null;
        error: string | null;
    } | null>(null);

    useEffect(() => {
        let current = true;
        const settle = (value: { players: PlayerStat[]; meta: Pick<SeasonFile, 'movers_mode' | 'compared_to'> | null; error: string | null }) => {
            if (current) setLoaded({ season, ...value });
        };

        const loader = seasonModules[`../../data/seasons/${season}.json`];
        if (!loader) {
            // Resolved rather than reported straight away: writing state from an effect
            // body renders twice for no gain.
            Promise.resolve().then(() =>
                settle({ players: [], meta: null, error: `No data file for the ${season} season.` })
            );
            return () => {
                current = false;
            };
        }

        loader()
            .then(module =>
                settle({
                    players: module.default.players,
                    meta: {
                        movers_mode: module.default.movers_mode,
                        compared_to: module.default.compared_to
                    },
                    error: null
                })
            )
            .catch(() => settle({ players: [], meta: null, error: `Could not load the ${season} season.` }));

        return () => {
            current = false;
        };
    }, [season]);

    const current = loaded?.season === season ? loaded : null;
    const players = current?.players ?? NO_PLAYERS;
    const seasonFile = current?.meta ?? null;
    const loadError = current?.error ?? null;
    const loading = current === null;

    const conferences = useMemo(
        () => [...new Set(players.flatMap(conferencesOf))].sort(),
        [players]
    );

    // Teams follow the chosen conference, so the two controls cannot be combined into an
    // empty result.
    const teams = useMemo(() => {
        const inScope =
            conference === 'all' ? players : players.filter(p => conferencesOf(p).includes(conference));
        return [...new Set(inScope.flatMap(teamsOf))].sort();
    }, [players, conference]);

    const filteredData = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        return players.filter(p => {
            if (conference !== 'all' && !conferencesOf(p).includes(conference)) return false;
            if (team !== 'all' && !teamsOf(p).includes(team)) return false;
            if (!term) return true;
            return (
                p.player_name.toLowerCase().includes(term) ||
                teamsOf(p).some(t => t.toLowerCase().includes(term)) ||
                conferencesOf(p).some(c => c.toLowerCase().includes(term))
            );
        });
    }, [players, searchTerm, conference, team]);

    const handleConferenceChange = (next: string) => {
        setConference(next);
        // The selected team may not play in the newly chosen conference.
        if (next !== 'all' && team !== 'all') {
            const stillValid = players.some(
                p => conferencesOf(p).includes(next) && teamsOf(p).includes(team)
            );
            if (!stillValid) setTeam('all');
        }
    };

    const resetFilters = () => {
        setConference('all');
        setTeam('all');
        onSearch('');
    };

    const filtered = conference !== 'all' || team !== 'all' || searchTerm.trim() !== '';
    const isAllTime = season === 'all-time';
    const excluded = INDEX.excluded_seasons ?? [];

    return (
        <>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Season stats</h1>
                    <p className="page-lede">
                        The counting stats exactly as the box scores recorded them — no opponent adjustment and
                        no shrinkage. This is the raw material the impact model is built from, and the place to
                        look up what a player actually did.
                    </p>
                </div>
            </div>

            {excluded.length > 0 && (
                <div style={{ marginBottom: 'var(--space-4)' }}>
                    <Notice>
                        <strong>
                            {excluded.map(season => season.season).join(', ')} not shown.
                        </strong>{' '}
                        {excluded
                            .map(
                                season =>
                                    `${season.season} has a roster for only ${percent(season.roster_share)} of Division I.`
                            )
                            .join(' ')}{' '}
                        Totals from a season that thin would not be comparable with the others.
                    </Notice>
                </div>
            )}

            <FilterBar
                seasons={INDEX.seasons}
                season={season}
                onSeasonChange={setSeason}
                conferences={conferences}
                conference={conference}
                onConferenceChange={handleConferenceChange}
                teams={teams}
                team={team}
                onTeamChange={setTeam}
                shown={filteredData.length}
                total={players.length}
                onReset={resetFilters}
                filtered={filtered}
            />

            {loadError ? (
                <div className="empty-state">{loadError}</div>
            ) : loading ? (
                <div className="empty-state">Loading {season}…</div>
            ) : filteredData.length === 0 ? (
                <div className="empty-state">
                    <p style={{ marginBottom: '0.75rem' }}>No players match these filters.</p>
                    <button type="button" className="link-button" onClick={resetFilters}>
                        Clear filters
                    </button>
                </div>
            ) : (
                <>
                    <KPIGrid stats={filteredData} />
                    {/* A career has no season behind it to move against, so the panel is not
                        shown for the all-time view rather than shown empty. */}
                    {seasonFile && !isAllTime && (
                        <MoversPanel
                            data={filteredData}
                            mode={seasonFile.movers_mode}
                            comparedTo={seasonFile.compared_to}
                        />
                    )}
                    <ChartsGrid data={filteredData} />
                    <PlayerTable data={filteredData} />
                </>
            )}
        </>
    );
}
