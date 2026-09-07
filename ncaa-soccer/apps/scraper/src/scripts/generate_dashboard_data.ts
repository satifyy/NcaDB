/**
 * Builds the JSON the dashboard reads: one file per season, an all-time file, and a
 * manifest.
 *
 * Three things the CSVs do not carry have to be added here.
 *
 * **Conference.** `player_stats.csv` keys a row by the team's display name, not by an id
 * that joins anywhere, so the conference has to be looked up by name against the team
 * inventory — through the same identity rules discovery uses, since the stats spell
 * schools every way their sites do ("LMU", "Boston U.", "Connecticut").
 *
 * **Season.** Each season's totals live in their own directory and are otherwise
 * indistinguishable once loaded, so the season is written into the file that holds them.
 *
 * **A player.** `player_key` is `team:name`, with the team as that box score spelled it,
 * so one player is several keys whenever their school was written more than one way:
 * Aidan Davock's 2023 arrives as `colgate:...`, `colgateuniversity:...` and
 * `colgateplsemifinals:...`, three rows splitting one 13-game season. Rows are therefore
 * re-keyed onto the canonical team and summed, which is also what makes a career total
 * possible.
 *
 * Output is split per season rather than concatenated: a season is ~2 MB of JSON, and a
 * dashboard that loads five of them to show one is four seasons of parsing the reader
 * never asked for. The manifest carries what the filter controls need — which seasons
 * exist, which conferences and teams are in each — so the page can render its controls
 * before any season has loaded.
 *
 * Usage:
 *   npx tsx apps/scraper/src/scripts/generate_dashboard_data.ts [default-season]
 *
 * Every season found is written; the argument only sets which one the page opens on.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    AggregatedPlayerCsvRow,
    aggregatedStatsCsv,
    COVERAGE_PATH,
    GameCsvRow,
    gamesCsv,
    int,
    PlayerStatCsvRow,
    playerStatsCsv,
    readAll,
    STATS_DIR,
    readAllIfExists,
    streamRowsIfExists
} from '@ncaa/storage';
import { cleanTeamName } from '@ncaa/parsers';
import { SchoolIndex } from '../utils/school_names';
import { TeamConfig } from '../utils/teams';
import { careerSegments } from '../analytics/careers';
import {
    REPO_ROOT,
    UNAFFILIATED,
    buildTeamIndex,
    canonicalTeamNames,
    normalisePlayer,
    seasonsOnDisk
} from '../utils/canonical_teams';

const OUT_DIR = path.join(REPO_ROOT, 'apps/dashboard/src/data');
const SEASON_DIR = path.join(OUT_DIR, 'seasons');

interface SeasonVerdict {
    season: string;
    usable: boolean;
    note: string | null;
    roster_share: number;
}

/**
 * Seasons the coverage check passed, and the ones it did not.
 *
 * A season missing more than a fifth of Division I is excluded from every total on the
 * page rather than shown smaller than it should be: a scoring leaderboard drawn from
 * two thirds of the league is not a leaderboard, and nothing on the page would say so.
 * The excluded years are still named in the manifest, so the dashboard can tell the
 * reader which years are missing and why instead of quietly skipping them.
 *
 * With no coverage file — a checkout that has not run `build_ratings.ts` — every season
 * is kept, because refusing to build the dashboard over a missing verdict would be worse
 * than building it unfiltered.
 */
function readCoverage(): { usable: Set<string> | null; excluded: SeasonVerdict[] } {
    try {
        const file = JSON.parse(fs.readFileSync(COVERAGE_PATH, 'utf8')) as { seasons: SeasonVerdict[] };
        return {
            usable: new Set(file.seasons.filter(season => season.usable).map(season => season.season)),
            excluded: file.seasons.filter(season => !season.usable)
        };
    } catch {
        return { usable: null, excluded: [] };
    }
}

interface DashboardPlayer {
    player_key: string;
    player_name: string;
    team_id: string;
    conference: string;
    season: string;
    /**
     * Every team and conference this row covers, present only on career rows. A career
     * spans the schools a player transferred between, and the filters match any of them —
     * three years at Indiana still belong to Indiana after a transfer out.
     */
    teams?: string[];
    conferences?: string[];
    jersey_number: string;
    games_played: number;
    minutes: number;
    goals: number;
    assists: number;
    shots: number;
    shots_on_goal: number;
    saves: number;
    /**
     * Goal contributions now and in the comparison window, or null when the player has
     * too little history to compare. What the window is depends on {@link MoversMode}.
     *
     * Shipped per player rather than as a precomputed leaderboard so the dashboard can
     * rank whatever the filters leave: a top ten of the whole country tells you nothing
     * about the conference you just selected.
     */
    movement_current?: number | null;
    movement_previous?: number | null;
}


/**
 * A player within a season: their canonical team and their name.
 *
 * The team belongs in the key. Two players of the same name at different schools are two
 * people, and merging them would be a worse error than the duplicate rows this replaces.
 */
function identity(team: string, playerName: string): string {
    return `${team}::${normalisePlayer(playerName)}`;
}

interface Totals {
    games_played: number;
    minutes: number;
    goals: number;
    assists: number;
    shots: number;
    shots_on_goal: number;
    saves: number;
}

const ZERO: Totals = {
    games_played: 0,
    minutes: 0,
    goals: 0,
    assists: 0,
    shots: 0,
    shots_on_goal: 0,
    saves: 0
};

function addTotals(a: Totals, b: Totals): Totals {
    return {
        games_played: a.games_played + b.games_played,
        minutes: a.minutes + b.minutes,
        goals: a.goals + b.goals,
        assists: a.assists + b.assists,
        shots: a.shots + b.shots,
        shots_on_goal: a.shots_on_goal + b.shots_on_goal,
        saves: a.saves + b.saves
    };
}

function rowTotals(row: AggregatedPlayerCsvRow): Totals {
    return {
        games_played: int(row.games_played),
        minutes: int(row.minutes),
        goals: int(row.goals),
        assists: int(row.assists),
        shots: int(row.shots),
        shots_on_goal: int(row.shots_on_goal),
        saves: int(row.saves)
    };
}

interface SeasonPlayer {
    key: string;
    name: string;
    team: string;
    conference: string;
    jersey: string;
    totals: Totals;
}

/** One row per player per season, with the duplicate spellings of their team folded in. */
function readSeasonPlayers(
    season: string,
    teams: SchoolIndex<TeamConfig>,
    canonicalTeam: Map<string, string>
): Map<string, SeasonPlayer> {
    const rows = readAll<AggregatedPlayerCsvRow>(aggregatedStatsCsv(season));

    const players = new Map<string, SeasonPlayer>();
    for (const row of rows) {
        // Stored names still carry decoration from rows scraped before the parser
        // stripped it, so they are cleaned again here rather than shown as-is.
        const spelling = cleanTeamName(row.team_id).name || row.team_id;
        const team = canonicalTeam.get(spelling) || spelling;
        if (!row.player_name) continue;

        const key = identity(team, row.player_name);
        const existing = players.get(key);
        if (existing) {
            existing.totals = addTotals(existing.totals, rowTotals(row));
            existing.jersey = existing.jersey || row.jersey_number;
            continue;
        }
        players.set(key, {
            key,
            name: row.player_name,
            team,
            conference: teams.find(team)?.conference || UNAFFILIATED,
            jersey: row.jersey_number,
            totals: rowTotals(row)
        });
    }
    return players;
}

/**
 * What "moved" means for a season.
 *
 * `season` compares a player's goal contributions against their own previous season, and
 * is the more meaningful of the two — but it needs the season before to have been
 * scraped. `form` is the fallback within a single season: the last three games against
 * the three before them, which is who finished strong.
 */
type MoversMode = 'season' | 'form' | 'pace';

/** Games each side of the comparison needs before a change means anything. */
const FORM_WINDOW = 3;
const MIN_SEASON_GAMES = 5;
const MIN_PACE_GAMES = 3;

/**
 * Games a player has by the end of a finished season, roughly.
 *
 * Used only to tell a completed season from one still being played, which changes what
 * the comparison can fairly be.
 */
const COMPLETE_SEASON_GAMES = 12;

function seasonIsComplete(players: Map<string, SeasonPlayer>): boolean {
    const games = [...players.values()].map(p => p.totals.games_played).sort((a, b) => b - a);
    if (games.length === 0) return false;
    // The busiest tenth of players, so a squad of substitutes does not make a finished
    // season look unplayed.
    return games[Math.floor(games.length / 10)] >= COMPLETE_SEASON_GAMES;
}

/** Goal contributions per player per game, in date order, keyed by season identity. */
async function contributionsByGame(
    season: string,
    canonicalTeam: Map<string, string>
): Promise<Map<string, number[]>> {
    const dates = new Map<string, string>();
    for (const row of readAllIfExists<GameCsvRow>(gamesCsv(season))) {
        dates.set(row.game_id, row.date);
    }
    // Every id seen so far also carries its date, which covers a box score whose fixture
    // is missing from games.csv.
    const dateOf = (gameId: string) =>
        dates.get(gameId) || (gameId.match(/\d{4}-\d{2}-\d{2}/) || [''])[0];

    const byPlayer = new Map<string, { date: string; contributions: number }[]>();
    for await (const row of streamRowsIfExists<PlayerStatCsvRow>(playerStatsCsv(season))) {
        if (!row.player_name) continue;
        const spelling = cleanTeamName(row.team_id).name || row.team_id;
        const key = identity(canonicalTeam.get(spelling) || spelling, row.player_name);
        const list = byPlayer.get(key) || [];
        list.push({
            date: dateOf(row.game_id),
            contributions: int(row.goals) + int(row.assists)
        });
        byPlayer.set(key, list);
    }

    const ordered = new Map<string, number[]>();
    for (const [key, games] of byPlayer) {
        ordered.set(key, games.sort((a, b) => a.date.localeCompare(b.date)).map(g => g.contributions));
    }
    return ordered;
}

/**
 * How each player's output changed, by whichever comparison this season supports.
 *
 * Season-over-season only counts players who appear in both: someone arriving with 15
 * contributions after a season of none has not moved, they have shown up, and letting
 * them in fills the list with freshmen instead of players who changed.
 */
async function movement(
    season: string,
    previousSeason: string | undefined,
    previous: Map<string, SeasonPlayer> | undefined,
    current: Map<string, SeasonPlayer>,
    canonicalTeam: Map<string, string>
): Promise<{ mode: MoversMode; of: (player: SeasonPlayer) => [number, number] | null }> {
    if (previous && previousSeason) {
        if (seasonIsComplete(current)) {
            return {
                mode: 'season',
                of: player => {
                    if (player.totals.games_played < MIN_SEASON_GAMES) return null;
                    const before = previous.get(player.key);
                    if (!before) return null;
                    return [
                        player.totals.goals + player.totals.assists,
                        before.totals.goals + before.totals.assists
                    ];
                }
            };
        }

        // The season is still being played, so its totals are not comparable with a full
        // one: six games into 2026 every player who scored 12 last year is a "faller".
        // Comparing the same stretch of each season keeps it honest — what they have
        // through six games now, against what they had through six games then.
        const nowByGame = await contributionsByGame(season, canonicalTeam);
        const thenByGame = await contributionsByGame(previousSeason, canonicalTeam);
        return {
            mode: 'pace',
            of: player => {
                const now = nowByGame.get(player.key);
                const then = thenByGame.get(player.key);
                if (!now || !then || now.length < MIN_PACE_GAMES) return null;
                const games = Math.min(now.length, then.length);
                if (games < MIN_PACE_GAMES) return null;
                const sum = (xs: number[]) => xs.slice(0, games).reduce((total, x) => total + x, 0);
                return [sum(now), sum(then)];
            }
        };
    }

    const perGame = await contributionsByGame(season, canonicalTeam);
    return {
        mode: 'form',
        of: player => {
            const games = perGame.get(player.key);
            if (!games || games.length < FORM_WINDOW * 2) return null;
            const sum = (xs: number[]) => xs.reduce((total, x) => total + x, 0);
            return [sum(games.slice(-FORM_WINDOW)), sum(games.slice(-FORM_WINDOW * 2, -FORM_WINDOW))];
        }
    };
}

function toDashboard(player: SeasonPlayer, season: string, moved: [number, number] | null): DashboardPlayer {
    return {
        player_key: player.key,
        player_name: player.name,
        team_id: player.team,
        conference: player.conference,
        season,
        jersey_number: player.jersey,
        ...player.totals,
        movement_current: moved ? moved[0] : null,
        movement_previous: moved ? moved[1] : null
    };
}

/**
 * Career totals, with a player followed across the schools they played for.
 *
 * Linking stints at different schools is the hard half. All we have to go on is a name,
 * and names are not unique — 5,679 of them appear at two schools in the *same* season,
 * which is proof of two different people. So a name is only followed across schools when
 * its stints never overlap: one player cannot be on two rosters at once. Where a name
 * does overlap anywhere, none of its stints are joined, because the data cannot say which
 * of the several people any one stint belongs to. That is deliberately cautious — it
 * leaves some genuine transfers split rather than risk welding two strangers into one
 * career.
 *
 * The second half is **when**. Non-overlapping stints were enough while the dataset held
 * five seasons; over eleven they are not, because a 2016 senior and a 2026 freshman with
 * the same name never overlap either. Left unchecked that produced 225 "careers" longer
 * than any college career can be — including three different names each showing the same
 * six schools from 2016 to 2026, which is the giveaway: the rule was chaining strangers
 * who merely never coincided. So a name's seasons are cut into careers at any gap longer
 * than a redshirt year, and again wherever one would outlast eligibility.
 */

function careerPlayers(bySeason: Map<string, Map<string, SeasonPlayer>>): DashboardPlayer[] {
    const seasons = [...bySeason.keys()].sort();

    // name -> team -> the seasons that name played there
    const stints = new Map<string, Map<string, Set<string>>>();
    for (const season of seasons) {
        for (const player of bySeason.get(season)!.values()) {
            const name = normalisePlayer(player.name);
            if (!stints.has(name)) stints.set(name, new Map());
            const byTeam = stints.get(name)!;
            if (!byTeam.has(player.team)) byTeam.set(player.team, new Set());
            byTeam.get(player.team)!.add(season);
        }
    }

    /** Names safe to follow between schools: no two of their stints share a season. */
    const followable = new Set<string>();
    for (const [name, byTeam] of stints) {
        if (byTeam.size < 2) continue;
        const spans = [...byTeam.values()];
        const overlaps = spans.some((a, i) => spans.some((b, j) => j > i && [...a].some(s => b.has(s))));
        if (!overlaps) followable.add(name);
    }

    interface Career {
        name: string;
        teams: string[];
        conferences: string[];
        seasons: string[];
        jersey: string;
        totals: Totals;
    }

    // Where each of a name's seasons falls, computed once: across all their schools when
    // the name can be followed, and within each school when it cannot.
    const segments = new Map<string, Map<string, number>>();
    for (const [name, byTeam] of stints) {
        if (followable.has(name)) {
            segments.set(name, careerSegments([...byTeam.values()].flatMap(set => [...set])));
            continue;
        }
        for (const [team, played] of byTeam) {
            segments.set(`${name}::${team}`, careerSegments([...played]));
        }
    }

    const careers = new Map<string, Career>();
    for (const season of seasons) {
        for (const player of bySeason.get(season)!.values()) {
            const name = normalisePlayer(player.name);
            // One career per name where the name can be followed; otherwise one per team,
            // which is exactly the season key and keeps unrelated namesakes apart. Either
            // way it is cut again wherever the seasons are too far apart to be one person.
            const scope = followable.has(name) ? name : `${name}::${player.team}`;
            const segment = segments.get(scope)?.get(season) ?? 0;
            const base = followable.has(name) ? `career::${name}` : `career::${player.key}`;
            const key = segment === 0 ? base : `${base}::${segment}`;
            const career = careers.get(key);
            if (!career) {
                careers.set(key, {
                    name: player.name,
                    teams: [player.team],
                    conferences: [player.conference],
                    seasons: [season],
                    jersey: player.jersey,
                    totals: player.totals
                });
                continue;
            }
            career.totals = addTotals(career.totals, player.totals);
            if (!career.teams.includes(player.team)) career.teams.push(player.team);
            if (!career.conferences.includes(player.conference)) career.conferences.push(player.conference);
            career.seasons.push(season);
            career.jersey = career.jersey || player.jersey;
        }
    }

    // The all-time file is the largest thing the site ships — 56,000 careers — and at this
    // size the JSON is mostly repeated key names. Two fields are therefore omitted rather
    // than written empty, both of which the dashboard already has a fallback for: the
    // team and conference *lists*, which only say something when a career spans more than
    // one school, and the movement pair, which is always null here because a career has no
    // season behind it to move against. No figure is dropped; 8,589 careers show no
    // minutes but still hold 676 goals between them, so filtering on playing time would
    // quietly change every all-time total.
    return [...careers.entries()].map(([key, career]) => {
        const transferred = career.teams.length > 1;
        return {
            player_key: key,
            player_name: career.name,
            // The most recent school leads, since that is who the player is now.
            team_id: career.teams[career.teams.length - 1],
            conference: career.conferences[career.conferences.length - 1],
            season: `${career.seasons[0]}–${career.seasons[career.seasons.length - 1]}`,
            ...(transferred ? { teams: career.teams, conferences: career.conferences } : {}),
            jersey_number: career.jersey,
            ...career.totals
        };
    });
}

const ALL_TIME = 'all-time';

async function main(): Promise<void> {
    const coverage = readCoverage();
    const seasons = seasonsOnDisk().filter(season => !coverage.usable || coverage.usable.has(season));
    for (const verdict of coverage.excluded) {
        console.log(`${verdict.season}: excluded — ${verdict.note}`);
    }
    if (seasons.length === 0) {
        console.error(`No aggregated stats under ${STATS_DIR}.`);
        console.error('Run: npx tsx apps/scraper/src/scripts/aggregate_player_stats.ts <season>');
        process.exit(1);
    }

    const teams = buildTeamIndex();
    const canonicalTeam = canonicalTeamNames(seasons, teams);
    fs.mkdirSync(SEASON_DIR, { recursive: true });

    const bySeason = new Map<string, Map<string, SeasonPlayer>>();
    for (const season of seasons) bySeason.set(season, readSeasonPlayers(season, teams, canonicalTeam));

    const summarise = (season: string, label: string | undefined, players: DashboardPlayer[]) => ({
        season,
        ...(label ? { label } : {}),
        players: players.length,
        teams: [...new Set(players.flatMap(p => p.teams ?? [p.team_id]))].sort(),
        conferences: [...new Set(players.flatMap(p => p.conferences ?? [p.conference]))].sort(),
        goals: players.reduce((sum, p) => sum + p.goals, 0)
    });

    // A sequential loop rather than `seasons.map`, because each season's movers are read
    // off a streamed box-score file: running eleven of them concurrently would hold every
    // season at once, which is the cost this stage was changed to avoid.
    const summaries: ReturnType<typeof summarise>[] = [];
    for (const [i, season] of seasons.entries()) {
        // The season before this one, only when it was actually scraped — the comparison
        // has to be against real data, not against a gap in the backfill.
        const previousSeason =
            i > 0 && Number(seasons[i - 1]) === Number(season) - 1 ? seasons[i - 1] : undefined;
        const change = await movement(
            season,
            previousSeason,
            previousSeason ? bySeason.get(previousSeason) : undefined,
            bySeason.get(season)!,
            canonicalTeam
        );

        const players = [...bySeason.get(season)!.values()].map(player =>
            toDashboard(player, season, change.of(player))
        );
        const comparable = players.filter(p => p.movement_current !== null).length;
        const unaffiliated = players.filter(p => p.conference === UNAFFILIATED).length;

        fs.writeFileSync(
            path.join(SEASON_DIR, `${season}.json`),
            JSON.stringify({
                season,
                movers_mode: change.mode,
                compared_to: previousSeason ?? null,
                players
            })
        );
        console.log(
            `${season}: ${players.length} players, ${new Set(players.map(p => p.team_id)).size} teams, ` +
                `${new Set(players.map(p => p.conference)).size} conferences (${unaffiliated} unmatched); ` +
                `movers by ${
                    change.mode === 'season'
                        ? `change from ${previousSeason}`
                        : change.mode === 'pace'
                          ? `pace against the same games of ${previousSeason}`
                          : 'late-season form'
                }, ` +
                `${comparable} comparable`
        );
        summaries.push(summarise(season, undefined, players));
    }

    const career = careerPlayers(bySeason);
    const transferred = career.filter(p => (p.teams?.length ?? 1) > 1).length;
    fs.writeFileSync(
        path.join(SEASON_DIR, `${ALL_TIME}.json`),
        JSON.stringify({ season: ALL_TIME, movers_mode: 'form', compared_to: null, players: career })
    );
    console.log(
        `\nall-time: ${career.length} careers over ${seasons[0]}-${seasons[seasons.length - 1]}, ` +
            `${transferred} spanning more than one school`
    );
    summaries.push(summarise(ALL_TIME, 'All-time', career));

    const requested = process.argv[2];
    const defaultSeason = seasons.includes(requested) ? requested : seasons[seasons.length - 1];

    fs.writeFileSync(
        path.join(OUT_DIR, 'manifest.json'),
        `${JSON.stringify(
            {
                generated_at: new Date().toISOString(),
                default_season: defaultSeason,
                seasons: summaries,
                excluded_seasons: coverage.excluded.map(verdict => ({
                    season: verdict.season,
                    note: verdict.note,
                    roster_share: verdict.roster_share
                }))
            },
            null,
            2
        )}\n`
    );

    console.log(`\nWrote ${seasons.length + 1} file(s) to ${SEASON_DIR}`);
    console.log(`Manifest -> ${path.join(OUT_DIR, 'manifest.json')} (opens on ${defaultSeason})`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
