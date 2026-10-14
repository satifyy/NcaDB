/**
 * Scraper CSV rows -> validated, team-resolved records for the loader.
 *
 * Validation here is about what the database may hold, not about re-judging the
 * scraper. Rows are rejected only when they cannot be stored truthfully (no date, a
 * bracket placeholder where a school should be, a player called "Player"), and every
 * rejection is counted and sampled so a run reports what it refused and why. Nothing is
 * coerced: an empty stat cell is NULL, never zero.
 */

import * as fs from 'fs';
import * as path from 'path';
import { cleanTeamName } from '@ncaa/parsers';
import type { GameCsvRow, PlayerStatCsvRow } from '@ncaa/storage';
import type {
    GameSourceRecord,
    GameStatus,
    GameType,
    LocationType,
    PlayerStatRecord,
    QualityIssue,
    SeasonBatch,
    TeamRecord
} from '@ncaa/database';
import { SchoolIndex } from '../../scraper/src/utils/school_names';
import type { TeamConfig } from '../../scraper/src/utils/teams';
import { NOT_A_TEAM } from '../../scraper/src/analytics/matches';

/** `NC State` -> `nc-state`. Stable, URL-safe, and the teams table's natural key. */
export function teamSlug(name: string): string {
    return name
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** "Skinner, Luke" -> "Luke Skinner". Names without exactly one comma are left as written. */
export function displayName(raw: string): string {
    const name = raw.replace(/\s+/g, ' ').trim();
    const parts = name.split(',');
    if (parts.length !== 2) return name;
    const [last, first] = parts.map(p => p.trim());
    return first && last ? `${first} ${last}` : name;
}

/**
 * The letters of a player's name in display order, so "Skinner, Luke" and
 * "Luke Skinner" — the same person written by two sites — are one identity.
 */
export function playerLetters(raw: string): string {
    return displayName(raw)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z]/g, '');
}

const PLACEHOLDER_PLAYER = /^(?:player|team|totals?|tm|unknown|n\/?a|-+|#+)$/i;
const UNKNOWN_TEAM = /^(?:unknown|tbd|tba)?$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: GameStatus[] = ['scheduled', 'live', 'final', 'postponed', 'canceled', 'unknown'];
const LOCATIONS: LocationType[] = ['home', 'away', 'neutral', 'unknown'];
const GAME_TYPES: GameType[] = ['exhibition', 'ncaa_tournament', 'conference_tournament', 'regular'];

/** Tomorrow's date (UTC), so a game finished late tonight in the Pacific still counts. */
function tomorrow(): string {
    return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

export interface Inventory {
    teams: TeamConfig[];
    index: SchoolIndex<TeamConfig>;
}

/** The Division I inventory and its alias file, from an explicit teams directory. */
export function loadInventory(teamsDir: string): Inventory {
    const teams: TeamConfig[] = JSON.parse(fs.readFileSync(path.join(teamsDir, 'd1_msoc_teams.json'), 'utf8'));
    let aliases: Record<string, string[]> = {};
    const aliasPath = path.join(teamsDir, 'team_aliases.json');
    if (fs.existsSync(aliasPath)) aliases = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
    const index = new SchoolIndex<TeamConfig>();
    for (const team of teams) {
        index.add({ ...team, aliases: [...(team.aliases || []), ...(aliases[team.team_id] || [])] });
    }
    return { teams, index };
}

/**
 * Resolves raw spellings to teams.
 *
 * Only teams a stored row ends up using are reported by {@link teams}: a box score's
 * abbreviation ("OU") resolves to a placeholder first and is then re-attributed from the
 * fixture, and must not leave a team called "OU" behind.
 */
export class TeamResolver {
    private readonly seen = new Map<string, string>();
    private readonly rawBySlug = new Map<string, Set<string>>();
    private readonly cache = new Map<string, { slug: string; name: string } | null>();

    constructor(private readonly inventory: Inventory) {}

    /** The team a raw name means, or null when it names no school. */
    resolve(raw: string): { slug: string; name: string } | null {
        if (this.cache.has(raw)) return this.cache.get(raw)!;
        const cleaned = cleanTeamName(raw).name.trim();
        let result: { slug: string; name: string } | null = null;
        if (cleaned && !NOT_A_TEAM.test(cleaned)) {
            const known = this.inventory.index.findUnique(cleaned);
            const name = known?.name_canonical ?? cleaned;
            const slug = teamSlug(name);
            if (slug) {
                result = { slug, name };
                if (!this.seen.has(slug)) this.seen.set(slug, name);
                if (!this.rawBySlug.has(slug)) this.rawBySlug.set(slug, new Set());
                this.rawBySlug.get(slug)!.add(raw);
            }
        }
        this.cache.set(raw, result);
        return result;
    }

    /** Every inventory team, plus every other team in `used`. */
    teams(used: Set<string>): TeamRecord[] {
        const inventory: TeamRecord[] = this.inventory.teams.map(t => ({
            slug: teamSlug(t.name_canonical),
            name: t.name_canonical,
            inventoryId: t.team_id,
            isDivisionOne: true,
            conference: t.conference ?? null,
            scheduleUrl: t.schedule_url ?? null,
            platform: t.platform_guess ?? null,
            timezone: t.timezone ?? null,
            aliases: t.aliases ?? []
        }));
        const known = new Set(inventory.map(t => t.slug));
        const others = [...used]
            .filter(slug => !known.has(slug) && this.seen.has(slug))
            .map(slug => ({ slug, name: this.seen.get(slug)!, isDivisionOne: false }));
        return [...inventory, ...others];
    }

    /** Raw spelling -> slug, for every spelling of a team in `used`. */
    spellings(used: Set<string>): Map<string, string> {
        const out = new Map<string, string>();
        for (const slug of used) for (const raw of this.rawBySlug.get(slug) ?? []) out.set(raw, slug);
        return out;
    }
}

/** Collects rejections by code, keeping a count and a few samples of each. */
export class IssueLog {
    private byCode = new Map<string, QualityIssue>();

    add(code: string, message: string, sample: unknown, severity: QualityIssue['severity'] = 'warning'): void {
        const existing = this.byCode.get(code);
        if (existing) {
            existing.count++;
            if (existing.samples.length < 10) existing.samples.push(sample);
            return;
        }
        this.byCode.set(code, { category: 'validation', severity, code, message, count: 1, samples: [sample] });
    }

    list(): QualityIssue[] {
        return [...this.byCode.values()];
    }
}

/** A whole, non-negative number, or null for an empty or unreadable cell. */
export function count(value: string | undefined, issues?: IssueLog, field?: string): number | null {
    const text = (value ?? '').trim();
    if (text === '') return null;
    if (!/^\d+$/.test(text)) {
        issues?.add('non_numeric_stat', 'Stat cells that were not a whole number (stored as NULL)', { field, value: text });
        return null;
    }
    return Number(text);
}

function flag(value: string | undefined): boolean | null {
    return value === 'true' ? true : value === 'false' ? false : null;
}

const blank = (value: string | undefined): string | null => {
    const text = (value ?? '').trim();
    return text === '' ? null : text;
};

export function normalizeGames(
    rows: GameCsvRow[],
    season: number,
    resolver: TeamResolver,
    issues: IssueLog
): GameSourceRecord[] {
    const out: GameSourceRecord[] = [];
    const seenKeys = new Set<string>();
    for (const row of rows) {
        const sample = { game_id: row.game_id, date: row.date, home: row.home_team_name, away: row.away_team_name };
        if (!row.dedupe_key || !row.game_id) {
            issues.add('missing_game_key', 'Schedule rows without a game id or dedupe key', sample, 'error');
            continue;
        }
        if (seenKeys.has(row.dedupe_key)) {
            issues.add('duplicate_dedupe_key', 'Schedule rows repeating a dedupe key (first kept)', sample);
            continue;
        }
        if (!ISO_DATE.test(row.date) || Number.isNaN(Date.parse(row.date))) {
            issues.add('invalid_date', 'Schedule rows with no usable date', sample, 'error');
            continue;
        }
        if (Number(row.date.slice(0, 4)) !== season) {
            issues.add('date_outside_season', 'Schedule rows dated outside their season file', sample);
            continue;
        }
        let status = (row.status || 'unknown') as GameStatus;
        if (!STATUSES.includes(status)) {
            issues.add('unknown_status', 'Schedule rows with an unrecognised status (stored as unknown)', { ...sample, status: row.status });
            status = 'unknown';
        }
        // Where a site prints no date, some emit January 1 of the season: a schedule of
        // placeholder rows, not games. Played spring games are real (2020 moved to spring).
        if (status !== 'final' && row.date < `${season}-08-01`) {
            issues.add('placeholder_date', 'Unplayed fixtures dated before the season starts (unparsed dates)', sample);
            continue;
        }
        const home = resolver.resolve(row.home_team_name);
        const away = resolver.resolve(row.away_team_name);
        if (!home || !away) {
            issues.add('not_a_team', 'Fixtures naming a bracket placeholder or nothing at all instead of a school', sample);
            continue;
        }
        if (home.slug === away.slug) {
            issues.add('same_team_both_sides', 'Fixtures whose two sides resolve to the same school', sample, 'error');
            continue;
        }
        let homeScore = count(row.home_score);
        let awayScore = count(row.away_score);
        // A result for a game that has not happened yet is a site error (usually a
        // mis-parsed date). It is kept, but not as a result anyone should count.
        if (status === 'final' && row.date > tomorrow()) {
            issues.add('final_in_future', 'Fixtures marked final but dated in the future (stored as unknown)', sample);
            status = 'unknown';
        }
        if (status === 'final' && (homeScore === null || awayScore === null)) {
            issues.add('final_without_score', 'Fixtures marked final without both scores (stored as unknown)', sample);
            status = 'unknown';
            homeScore = awayScore = null;
        }
        const location = (LOCATIONS.includes(row.location_type as LocationType) ? row.location_type : 'unknown') as LocationType;
        const gameType = GAME_TYPES.includes(row.game_type as GameType) ? (row.game_type as GameType) : null;

        seenKeys.add(row.dedupe_key);
        out.push({
            dedupeKey: row.dedupe_key,
            sourceGameId: row.game_id,
            date: row.date,
            homeSlug: home.slug,
            awaySlug: away.slug,
            homeName: row.home_team_name,
            awayName: row.away_team_name,
            homeRanked: flag(row.home_team_ranked),
            awayRanked: flag(row.away_team_ranked),
            homeScore,
            awayScore,
            status,
            locationType: location,
            gameType,
            scheduleUrl: blank(row.schedule_url),
            boxscoreUrl: blank(row.boxscore_url),
            boxscoreUrlAlt: blank(row.boxscore_url_alt),
            payload: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? '']))
        });
    }
    return out;
}

export function normalizeStats(rows: PlayerStatCsvRow[], resolver: TeamResolver, issues: IssueLog): PlayerStatRecord[] {
    const out: PlayerStatRecord[] = [];
    for (const row of rows) {
        const sample = { game_id: row.game_id, team: row.team_id, player: row.player_name };
        const name = (row.player_name || '').trim();
        if (!row.game_id) {
            issues.add('stat_missing_game', 'Box-score rows with no game id', sample, 'error');
            continue;
        }
        if (UNKNOWN_TEAM.test((row.team_id || '').trim())) {
            issues.add('stat_unknown_team', 'Box-score rows whose team the parser could not name', sample);
            continue;
        }
        if (!name || PLACEHOLDER_PLAYER.test(name)) {
            issues.add('placeholder_player', 'Box-score rows with a placeholder instead of a player name', sample);
            continue;
        }
        const team = resolver.resolve(row.team_id);
        if (!team) {
            issues.add('stat_team_unresolved', 'Box-score rows whose team is not a school', sample);
            continue;
        }
        const letters = playerLetters(name);
        if (!letters) {
            issues.add('player_name_unusable', 'Box-score rows whose player name has no letters', sample);
            continue;
        }
        const jersey = blank(row.jersey_number);
        out.push({
            sourceGameId: row.game_id,
            teamSlug: team.slug,
            identityKey: `${team.slug}:${letters}`,
            playerName: name,
            displayName: displayName(name),
            jerseyNumber: jersey && /^[#?]+$/.test(jersey) ? null : jersey,
            minutes: count(row.minutes, issues, 'minutes'),
            goals: count(row.goals, issues, 'goals'),
            assists: count(row.assists, issues, 'assists'),
            shots: count(row.shots, issues, 'shots'),
            shotsOnGoal: count(row.shots_on_goal, issues, 'shots_on_goal'),
            saves: count(row.saves, issues, 'saves'),
            sourceTeamName: row.team_id,
            sourcePlayerName: row.player_name,
            sourcePlayerKey: row.player_key || ''
        });
    }
    return out;
}

/**
 * Re-attributes box-score rows whose team label names neither side of their fixture.
 *
 * Older box scores label a side by abbreviation ("OU" for Oakland) or mascot ("Tribe"),
 * which no name rule resolves. The fixture is known, though, so two kinds of evidence
 * are used, strongest first:
 *
 *   1. Elimination: one label fails to match and exactly one side is unclaimed.
 *   2. Rosters: the label's players appear, elsewhere in the season, under exactly one
 *      of the open sides' proper names. At least three shared players and a strict
 *      winner are required, and two labels may not claim the same side.
 *
 * Anything less clear-cut is left as it was and flagged downstream rather than guessed.
 */
export function attributeToFixtures(
    stats: PlayerStatRecord[],
    games: GameSourceRecord[],
    issues: IssueLog
): PlayerStatRecord[] {
    const sides = new Map<string, [string, string] | null>();
    for (const g of games) {
        const pair: [string, string] = [g.homeSlug, g.awaySlug];
        const existing = sides.get(g.sourceGameId);
        // A game id shared by two different fixtures cannot vouch for either.
        sides.set(g.sourceGameId, existing === undefined || (existing && existing.join() === pair.join()) ? pair : null);
    }

    const letters = (s: PlayerStatRecord) => s.identityKey.slice(s.identityKey.indexOf(':') + 1);
    const labelsByGame = new Map<string, Map<string, { slug: string; players: Set<string> }>>();
    for (const s of stats) {
        if (!labelsByGame.has(s.sourceGameId)) labelsByGame.set(s.sourceGameId, new Map());
        const labels = labelsByGame.get(s.sourceGameId)!;
        if (!labels.has(s.sourceTeamName)) labels.set(s.sourceTeamName, { slug: s.teamSlug, players: new Set() });
        labels.get(s.sourceTeamName)!.players.add(letters(s));
    }

    // Who each team fields this season, from rows already attributed to a fixture side.
    const rosters = new Map<string, Set<string>>();
    for (const s of stats) {
        if (!sides.get(s.sourceGameId)?.includes(s.teamSlug)) continue;
        if (!rosters.has(s.teamSlug)) rosters.set(s.teamSlug, new Set());
        rosters.get(s.teamSlug)!.add(letters(s));
    }

    const remap = new Map<string, string>(); // `${game}|${label}` -> slug
    for (const [gameId, labels] of labelsByGame) {
        const pair = sides.get(gameId);
        if (!pair) continue;
        const claimed = new Set([...labels.values()].map(l => l.slug).filter(slug => pair.includes(slug)));
        const strays = [...labels.entries()].filter(([, l]) => !pair.includes(l.slug));
        const open = pair.filter(slug => !claimed.has(slug));
        if (strays.length === 0 || open.length === 0) continue;

        if (strays.length === 1 && open.length === 1) {
            remap.set(`${gameId}|${strays[0][0]}`, open[0]);
            issues.add('team_label_from_fixture', 'Box-score team labels attributed to the only unclaimed side of their fixture',
                { game: gameId, label: strays[0][0], team: open[0] });
            continue;
        }

        const picks = new Map<string, string>();
        for (const [label, { players }] of strays) {
            const scores = open.map(slug => {
                const roster = rosters.get(slug);
                let shared = 0;
                if (roster) for (const p of players) if (roster.has(p)) shared++;
                return { slug, shared };
            }).sort((a, b) => b.shared - a.shared);
            const [best, next] = scores;
            if (best.shared >= 3 && best.shared > (next?.shared ?? 0)) picks.set(label, best.slug);
        }
        const targets = [...picks.values()];
        if (new Set(targets).size !== targets.length) continue;
        for (const [label, slug] of picks) {
            remap.set(`${gameId}|${label}`, slug);
            issues.add('team_label_from_roster', 'Box-score team labels attributed by roster overlap with a fixture side',
                { game: gameId, label, team: slug });
        }
    }
    if (remap.size === 0) return stats;
    return stats.map(s => {
        const slug = remap.get(`${s.sourceGameId}|${s.sourceTeamName}`);
        return slug ? { ...s, teamSlug: slug, identityKey: `${slug}:${letters(s)}` } : s;
    });
}

/** Builds the loader's batch for one season from its two CSVs' rows. */
export function buildSeasonBatch(
    season: number,
    gameRows: GameCsvRow[],
    statRows: PlayerStatCsvRow[],
    inventory: Inventory,
    complete: boolean
): { batch: SeasonBatch; issues: QualityIssue[] } {
    const resolver = new TeamResolver(inventory);
    const issues = new IssueLog();
    const games = normalizeGames(gameRows, season, resolver, issues);
    const stats = attributeToFixtures(normalizeStats(statRows, resolver, issues), games, issues);
    const used = new Set([...games.flatMap(g => [g.homeSlug, g.awaySlug]), ...stats.map(s => s.teamSlug)]);
    return {
        batch: { season, teams: resolver.teams(used), teamSpellings: resolver.spellings(used), games, stats, complete },
        issues: issues.list()
    };
}
