"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WmtBoxScoreParser = void 0;
exports.extractStatsGameId = extractStatsGameId;
exports.statsApiUrl = statsApiUrl;
const names_1 = require("../names");
/**
 * Box scores on WMT Digital sites are an iframe onto `wmt.games`, whose own DOM is
 * a React app that renders scoring plays and player tables into the same markup —
 * scraping it yields rows like "Goal by X, assisted by Y" mixed in with players.
 * The iframe is backed by a public JSON stats feed, so we read that instead.
 */
const STATS_API_ORIGIN = 'https://api.wmt.games';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
/**
 * Pulls the `wmt.games` match id out of a school box-score page.
 * Nuxt escapes slashes as `/`, so both forms are matched.
 */
function extractStatsGameId(html) {
    const normalized = html.replace(/\\u002[fF]/g, '/');
    const match = normalized.match(/wmt\.games\/[a-z0-9-]+\/stats\/match\/(?:full\/)?(\d+)/i);
    return match ? Number(match[1]) : null;
}
function statsApiUrl(gameId) {
    return `${STATS_API_ORIGIN}/api/statistics/games/${gameId}?with%5B0%5D=players`;
}
/** Total across all periods, which the feed stores as period 0. */
function totals(player) {
    const entry = (player.statistic || []).find(item => item.period === 0);
    return entry?.statistic || {};
}
/** The feed reports playing time in seconds; the dataset stores whole minutes. */
function toMinutes(seconds) {
    if (!seconds || !Number.isFinite(seconds))
        return 0;
    return Math.round(seconds / 60);
}
/** "Rogers,Quin" -> "Rogers, Quin", matching the Sidearm box-score format. */
function displayName(player) {
    const short = (player.xml_short_name || '').trim();
    if (short)
        return short.replace(/\s*,\s*/, ', ');
    return (player.xml_name || '').trim();
}
function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
class WmtBoxScoreParser {
    /** Builds player rows from a `api.wmt.games` statistics payload. */
    parseStats(payload, options) {
        const data = payload?.data ?? payload ?? {};
        const resolver = options?.nameResolver || new names_1.TeamNameResolver();
        const teamNames = new Map();
        for (const competitor of data.competitors || []) {
            if (competitor.teamId !== undefined && competitor.nameTabular) {
                teamNames.set(competitor.teamId, resolver.canonical(competitor.nameTabular.trim()));
            }
        }
        const home = (data.competitors || []).find(competitor => competitor.homeTeam);
        const away = (data.competitors || []).find(competitor => !competitor.homeTeam);
        const playerStats = [];
        const players = Array.isArray(data.players) ? data.players : data.players?.data || [];
        for (const player of players) {
            const name = displayName(player);
            if (!name)
                continue;
            const teamName = (player.team_id !== undefined ? teamNames.get(player.team_id) : undefined) || 'Unknown';
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
    async fetchBoxScore(boxScoreUrl, options) {
        const fetchImpl = options?.fetchImpl || fetch;
        const timeoutMs = options?.timeoutMs ?? 30000;
        const get = async (url) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await fetchImpl(url, {
                    headers: { 'User-Agent': USER_AGENT },
                    signal: controller.signal
                });
            }
            finally {
                clearTimeout(timer);
            }
        };
        let gameId = extractStatsGameId(boxScoreUrl);
        if (gameId === null) {
            const page = await get(boxScoreUrl);
            if (!page.ok)
                throw new Error(`HTTP ${page.status} for ${boxScoreUrl}`);
            gameId = extractStatsGameId(await page.text());
        }
        if (gameId === null) {
            // Nothing to parse: unplayed games and PDF-only box scores land here.
            return { game: {}, playerStats: [] };
        }
        const stats = await get(statsApiUrl(gameId));
        if (!stats.ok)
            throw new Error(`HTTP ${stats.status} for stats game ${gameId}`);
        return this.parseStats(await stats.json(), options);
    }
}
exports.WmtBoxScoreParser = WmtBoxScoreParser;
//# sourceMappingURL=boxscore.js.map