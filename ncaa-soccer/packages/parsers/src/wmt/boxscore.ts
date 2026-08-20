import { PlayerStat } from '@ncaa/shared';
import { ParseResult, ParserOptions } from '../types';
import { TeamNameResolver } from '../names';

/**
 * Box scores on WMT Digital sites are an iframe onto `wmt.games`, whose own DOM is
 * a React app that renders scoring plays and player tables into the same markup —
 * scraping it yields rows like "Goal by X, assisted by Y" mixed in with players.
 * The iframe is backed by a public JSON stats feed, so we read that instead.
 */

const STATS_API_ORIGIN = 'https://api.wmt.games';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

export interface WmtStatsCompetitor {
    teamId?: number;
    score?: number | null;
    homeTeam?: boolean | null;
    nameTabular?: string | null;
}

export interface WmtStatsPlayer {
    team_id?: number;
    xml_name?: string | null;
    xml_short_name?: string | null;
    xml_uni?: string | null;
    xml_position?: string | null;
    games_started?: number | null;
    statistic?: Array<{ period?: number; statistic?: Record<string, number> }>;
}

export interface WmtStatsGame {
    id?: number;
    game_date?: string | null;
    game_date_utc?: string | null;
    local_time_zone?: string | null;
    competitors?: WmtStatsCompetitor[];
    /** Empty games return a bare array here instead of the usual wrapper. */
    players?: { data?: WmtStatsPlayer[] } | WmtStatsPlayer[];
}

/**
 * Pulls the `wmt.games` match id out of a school box-score page.
 * Nuxt escapes slashes as `/`, so both forms are matched.
 */
export function extractStatsGameId(html: string): number | null {
    const normalized = html.replace(/\\u002[fF]/g, '/');
    const match = normalized.match(/wmt\.games\/[a-z0-9-]+\/stats\/match\/(?:full\/)?(\d+)/i);
    return match ? Number(match[1]) : null;
}

export function statsApiUrl(gameId: number): string {
    return `${STATS_API_ORIGIN}/api/statistics/games/${gameId}?with%5B0%5D=players`;
}

/** Total across all periods, which the feed stores as period 0. */
function totals(player: WmtStatsPlayer): Record<string, number> {
    const entry = (player.statistic || []).find(item => item.period === 0);
    return entry?.statistic || {};
}

/** The feed reports playing time in seconds; the dataset stores whole minutes. */
function toMinutes(seconds: number | undefined): number {
    if (!seconds || !Number.isFinite(seconds)) return 0;
    return Math.round(seconds / 60);
}

/** "Rogers,Quin" -> "Rogers, Quin", matching the Sidearm box-score format. */
function displayName(player: WmtStatsPlayer): string {
    const short = (player.xml_short_name || '').trim();
    if (short) return short.replace(/\s*,\s*/, ', ');
    return (player.xml_name || '').trim();
}

function slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface WmtBoxScoreOptions extends ParserOptions {
    nameResolver?: TeamNameResolver;
}

export class WmtBoxScoreParser {
    /** Builds player rows from a `api.wmt.games` statistics payload. */
    parseStats(payload: unknown, options?: WmtBoxScoreOptions): ParseResult {
        const data: WmtStatsGame =
            (payload as { data?: WmtStatsGame })?.data ?? (payload as WmtStatsGame) ?? {};
        const resolver = options?.nameResolver || new TeamNameResolver();

        const teamNames = new Map<number, string>();
        for (const competitor of data.competitors || []) {
            if (competitor.teamId !== undefined && competitor.nameTabular) {
                teamNames.set(competitor.teamId, resolver.canonical(competitor.nameTabular.trim()));
            }
        }

        const home = (data.competitors || []).find(competitor => competitor.homeTeam);
        const away = (data.competitors || []).find(competitor => !competitor.homeTeam);

        const playerStats: PlayerStat[] = [];
        const players = Array.isArray(data.players) ? data.players : data.players?.data || [];
        for (const player of players) {
            const name = displayName(player);
            if (!name) continue;

            const teamName =
                (player.team_id !== undefined ? teamNames.get(player.team_id) : undefined) || 'Unknown';
            const stats = totals(player);

            // Field minutes are absent for keepers, who get a goalkeeper-specific counter.
            const minutes = toMinutes(stats.sMinutes ?? stats.sGoalkeeperMinutesPlayed);

            playerStats.push({
                game_id: `wmt-${data.id ?? 'unknown'}`,
                team_id: teamName,
                player_name: name,
                player_key: `${slug(teamName)}:${slug(name)}`,
                jersey_number: player.xml_uni ? String(player.xml_uni) : null,
                minutes,
                goals: stats.sGoals ?? 0,
                assists: stats.sAssists ?? 0,
                shots: stats.sShotAttempts ?? 0,
                stats: {
                    shots_on_goal: stats.sShotsOnGoal ?? 0,
                    saves: stats.sSaves ?? 0,
                    goals_allowed: stats.sGoalsAllowed ?? 0,
                    fouls: stats.sFouls ?? 0,
                    yellow_cards: stats.sYellowCards ?? 0,
                    red_cards: stats.sRedCards ?? 0,
                    position: player.xml_position || '',
                    started: player.games_started ? 1 : 0
                }
            });
        }

        return {
            game: {
                home_team_name: home?.nameTabular ? resolver.canonical(home.nameTabular) : undefined,
                away_team_name: away?.nameTabular ? resolver.canonical(away.nameTabular) : undefined,
                home_score: home?.score ?? null,
                away_score: away?.score ?? null
            },
            playerStats
        };
    }

    /**
     * Fetches and parses a box score.
     *
     * @param boxScoreUrl either a school `/boxscore/<id>` page or a `wmt.games` match URL
     */
    async fetchBoxScore(
        boxScoreUrl: string,
        options?: WmtBoxScoreOptions & { fetchImpl?: typeof fetch; timeoutMs?: number }
    ): Promise<ParseResult> {
        const fetchImpl = options?.fetchImpl || fetch;
        const timeoutMs = options?.timeoutMs ?? 30000;

        const get = async (url: string): Promise<Response> => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await fetchImpl(url, {
                    headers: { 'User-Agent': USER_AGENT },
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timer);
            }
        };

        let gameId = extractStatsGameId(boxScoreUrl);
        if (gameId === null) {
            const page = await get(boxScoreUrl);
            if (!page.ok) throw new Error(`HTTP ${page.status} for ${boxScoreUrl}`);
            gameId = extractStatsGameId(await page.text());
        }
        if (gameId === null) {
            // Nothing to parse: unplayed games and PDF-only box scores land here.
            return { game: {}, playerStats: [] };
        }

        const stats = await get(statsApiUrl(gameId));
        if (!stats.ok) throw new Error(`HTTP ${stats.status} for stats game ${gameId}`);
        return this.parseStats(await stats.json(), options);
    }
}
