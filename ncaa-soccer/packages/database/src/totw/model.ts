/**
 * Team of the Week: the rating model.
 *
 * Pure functions over box-score rows; nothing here touches the database, so every rule
 * below is unit-tested directly (`test/totw.test.ts`). The store (`store.ts`) feeds it
 * one week of rows and persists what it returns.
 *
 * The model only uses what the box scores actually publish: minutes, goals, assists,
 * shots on goal, the result, and — for keepers — saves and goals allowed. There are no
 * tackles, passes or interceptions in the source, so defenders are rated on what their
 * team conceded while they played and on what they contributed going forward, and the
 * explanation says so.
 *
 * MODEL_VERSION is stored with every computed week. Change a weight and the version
 * changes with it, so a historical week always names the rules it was ranked by.
 */

import type { PositionGroup } from '@ncaa/shared';

export const MODEL_VERSION = 'totw-1';

/** Every weight, in one place, persisted with the version. Units are "game points". */
export const WEIGHTS = {
    /** A goal is worth more the further from goal the scorer usually plays. */
    goal: { GK: 2.0, DEF: 1.5, MID: 1.2, FWD: 1.0 } as Record<PositionGroup, number>,
    assist: 0.7,
    /** Each shot on target that was not a goal; the goal itself is already counted. */
    shotOnTargetNotScored: 0.1,
    /** Result bonus, only for a player on the field for most of the game. */
    win: 0.3,
    draw: 0.1,
    /** Team conceded nothing, for a player on the field for most of the game. */
    cleanSheet: { GK: 1.5, DEF: 1.0, MID: 0.3, FWD: 0 } as Record<PositionGroup, number>,
    /** Per goal conceded by the team, shared out by the share of the game played. */
    goalConceded: { GK: 0, DEF: -0.25, MID: 0, FWD: 0 } as Record<PositionGroup, number>,
    /** Keepers: per save (only where saves were reported) and per goal allowed. */
    save: 0.25,
    keeperGoalAllowed: -0.5,
    /** Weekly score = best × this + mean × (1 − this). */
    bestGameShare: 0.75,
    /**
     * A game against a team outside Division I counts at this share of its positive
     * score. Those opponents (D2, NAIA) are where most lopsided scorelines come from;
     * this is a deliberately blunt correction, not an opponent-strength model.
     */
    nonDivisionOneOpponent: 0.75
} as const;

export const RULES = {
    /** A game is rated only with at least this many minutes played. */
    minMinutes: { GK: 80, DEF: 60, MID: 60, FWD: 60 } as Record<PositionGroup, number>,
    /** Result and clean-sheet bonuses need this many minutes. */
    bonusMinutes: 60,
    /** A regulation game; a longer one (overtime) uses its own length. */
    regulationMinutes: 90,
    formation: { GK: 1, DEF: 4, MID: 3, FWD: 3 } as Record<PositionGroup, number>,
    honorableMentions: 2,
    /** A week with fewer games captured (box scores with positions) gets no XI. */
    minCapturedGames: 20
} as const;

/** One player's row from one game, joined with what the game and their team did. */
export interface PlayerGameInput {
    playerId: number;
    playerName: string;
    teamId: number;
    teamName: string;
    gameId: number;
    gameDate: string;
    opponentName: string;
    /** Whether the opponent is a Division I program. */
    opponentDivisionOne: boolean;
    positionGroup: PositionGroup;
    /** The label the box score printed, for display. */
    position: string;
    minutes: number;
    goals: number | null;
    assists: number | null;
    shotsOnGoal: number | null;
    /** NULL where the box score did not report saves. */
    saves: number | null;
    /** The keeper's goals allowed as published; NULL where not published. */
    goalsAllowed: number | null;
    teamScore: number;
    opponentScore: number;
    /** How many of this team's players kept goal with minutes > 0 in this game. */
    teamKeepersUsed: number;
    /** The most minutes any player on this team recorded: the game's length. */
    gameMinutes: number;
}

export type GoalsAllowedSource = 'official' | 'inferred' | 'unknown';

export interface RatedGame {
    gameId: number;
    gameDate: string;
    opponentName: string;
    opponentDivisionOne: boolean;
    teamScore: number;
    opponentScore: number;
    minutes: number;
    goals: number | null;
    assists: number | null;
    shotsOnGoal: number | null;
    saves: number | null;
    goalsAllowed: number | null;
    goalsAllowedSource: GoalsAllowedSource | null;
    /** The game's score and how it was made up, component by component. */
    score: number;
    components: Record<string, number>;
}

export interface PlayerWeek {
    playerId: number;
    playerName: string;
    teamId: number;
    teamName: string;
    positionGroup: PositionGroup;
    position: string;
    games: RatedGame[];
    totalMinutes: number;
    bestGame: number;
    meanGame: number;
    raw: number;
    /** 0–10, against the week's position group: see {@link ratingOf}. */
    rating: number;
    rank: number;
    /** Statistics that were not reported for at least one rated game. */
    missing: string[];
}

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * Goals a keeper allowed in a game, and where the number came from.
 *
 * Official where the box score's goalkeeping table printed it. Otherwise it is inferred
 * from the score only when that is unambiguous: this keeper was the team's only keeper
 * and played the whole game, so every goal the opponent scored was scored on them.
 * Anything else is unknown, and the game is not rated.
 */
export function keeperGoalsAllowed(row: PlayerGameInput): { value: number | null; source: GoalsAllowedSource } {
    if (row.goalsAllowed !== null) return { value: row.goalsAllowed, source: 'official' };
    if (row.teamKeepersUsed === 1 && row.minutes >= row.gameMinutes) return { value: row.opponentScore, source: 'inferred' };
    return { value: null, source: 'unknown' };
}

/** The score for one game, or null when the game cannot be rated for this player. */
export function rateGame(row: PlayerGameInput): RatedGame | null {
    const group = row.positionGroup;
    if (row.minutes < RULES.minMinutes[group]) return null;

    const components: Record<string, number> = {};
    const add = (name: string, value: number) => {
        if (value !== 0) components[name] = round(value);
    };
    const goals = row.goals ?? 0;
    add('goals', goals * WEIGHTS.goal[group]);
    add('assists', (row.assists ?? 0) * WEIGHTS.assist);
    if (row.shotsOnGoal !== null) {
        add('shots_on_target', Math.max(0, row.shotsOnGoal - goals) * WEIGHTS.shotOnTargetNotScored);
    }

    const fullShare = row.minutes >= RULES.bonusMinutes;
    if (fullShare) {
        if (row.teamScore > row.opponentScore) add('result', WEIGHTS.win);
        else if (row.teamScore === row.opponentScore) add('result', WEIGHTS.draw);
        if (row.opponentScore === 0) add('clean_sheet', WEIGHTS.cleanSheet[group]);
    }
    const share = Math.min(1, row.minutes / Math.max(row.gameMinutes, RULES.regulationMinutes));
    add('goals_conceded', row.opponentScore * share * WEIGHTS.goalConceded[group]);

    let goalsAllowed: number | null = null;
    let goalsAllowedSource: GoalsAllowedSource | null = null;
    if (group === 'GK') {
        const allowed = keeperGoalsAllowed(row);
        if (allowed.value === null) return null;
        goalsAllowed = allowed.value;
        goalsAllowedSource = allowed.source;
        add('goals_allowed', allowed.value * WEIGHTS.keeperGoalAllowed);
        if (row.saves !== null) add('saves', row.saves * WEIGHTS.save);
    }

    const subtotal = Object.values(components).reduce((sum, value) => sum + value, 0);
    if (!row.opponentDivisionOne && subtotal > 0) {
        add('opponent_outside_division_one', -subtotal * (1 - WEIGHTS.nonDivisionOneOpponent));
    }
    const score = round(Object.values(components).reduce((sum, value) => sum + value, 0));
    return {
        gameId: row.gameId,
        gameDate: row.gameDate,
        opponentName: row.opponentName,
        opponentDivisionOne: row.opponentDivisionOne,
        teamScore: row.teamScore,
        opponentScore: row.opponentScore,
        minutes: row.minutes,
        goals: row.goals,
        assists: row.assists,
        shotsOnGoal: row.shotsOnGoal,
        saves: row.saves,
        goalsAllowed,
        goalsAllowedSource,
        score,
        components
    };
}

/**
 * Which group a player is ranked in for the week: the one they played most minutes in,
 * across their rated games, with the latest game breaking a tie. A player is ranked in
 * exactly one group, so they can never take two places in the XI.
 */
function weekGroup(rows: PlayerGameInput[]): PlayerGameInput[] {
    const minutes = new Map<PositionGroup, number>();
    for (const row of rows) minutes.set(row.positionGroup, (minutes.get(row.positionGroup) ?? 0) + row.minutes);
    const latest = [...rows].sort((a, b) => b.gameDate.localeCompare(a.gameDate) || b.gameId - a.gameId)[0];
    let best: PositionGroup = latest.positionGroup;
    for (const [group, total] of minutes) {
        if (total > (minutes.get(best) ?? 0)) best = group;
    }
    return rows.filter(row => row.positionGroup === best);
}

/** The `q` quantile of `values` (linear interpolation), or 0 for none. */
function percentile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const at = (sorted.length - 1) * q;
    const lo = Math.floor(at);
    return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo);
}

/**
 * The 0–10 rating: `10 × (1 − e^(−score / scale))`, where `scale` is the 90th-percentile
 * week score in the player's group that week.
 *
 * Week scores are heavily right-skewed — most players score a few tenths, a hat trick
 * scores four — so a z-score puts the whole XI at the ceiling. This curve keeps them
 * apart: the group's 90th percentile rates 6.3, twice it 8.6, three times 9.5, and 10 is
 * never quite reached. A score at or below zero rates 0. Ratings compare players within a
 * group and week; they are not comparable across groups.
 */
export function ratingOf(score: number, scale: number): number {
    if (score <= 0 || scale <= 0) return score > 0 ? 10 : 0;
    return Math.round(10 * (1 - Math.exp(-score / scale)) * 10) / 10;
}

/** Deterministic order: score, then best game, then fewer minutes (efficiency), then id. */
function compare(a: PlayerWeek, b: PlayerWeek): number {
    return b.raw - a.raw || b.bestGame - a.bestGame || a.totalMinutes - b.totalMinutes || a.playerId - b.playerId;
}

/** Rates every eligible player of one week. Returned by group, best first. */
export function rateWeek(rows: PlayerGameInput[]): Record<PositionGroup, PlayerWeek[]> {
    const byPlayer = new Map<number, PlayerGameInput[]>();
    for (const row of rows) byPlayer.set(row.playerId, [...(byPlayer.get(row.playerId) ?? []), row]);

    const groups: Record<PositionGroup, PlayerWeek[]> = { GK: [], DEF: [], MID: [], FWD: [] };
    for (const playerRows of byPlayer.values()) {
        const rated = weekGroup(playerRows)
            .map(row => ({ row, game: rateGame(row) }))
            .filter((r): r is { row: PlayerGameInput; game: RatedGame } => r.game !== null);
        if (rated.length === 0) continue;
        const games = rated.map(r => r.game).sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.gameId - b.gameId);
        const scores = games.map(g => g.score);
        const bestGame = Math.max(...scores);
        const meanGame = scores.reduce((s, v) => s + v, 0) / scores.length;
        const first = rated[rated.length - 1].row;
        const missing = new Set<string>();
        for (const { row } of rated) {
            if (row.shotsOnGoal === null) missing.add('shots_on_goal');
            if (row.positionGroup === 'GK' && row.saves === null) missing.add('saves');
            if (row.positionGroup === 'GK' && row.goalsAllowed === null) missing.add('goals_allowed_official');
        }
        groups[first.positionGroup].push({
            playerId: first.playerId,
            playerName: first.playerName,
            teamId: first.teamId,
            teamName: first.teamName,
            positionGroup: first.positionGroup,
            position: first.position,
            games,
            totalMinutes: games.reduce((s, g) => s + g.minutes, 0),
            bestGame: round(bestGame),
            meanGame: round(meanGame),
            raw: round(WEIGHTS.bestGameShare * bestGame + (1 - WEIGHTS.bestGameShare) * meanGame),
            rating: 0,
            rank: 0,
            missing: [...missing].sort()
        });
    }

    for (const group of Object.keys(groups) as PositionGroup[]) {
        const list = groups[group].sort(compare);
        const scale = percentile(list.map(p => p.raw), 0.9);
        list.forEach((player, index) => {
            player.rank = index + 1;
            player.rating = ratingOf(player.raw, scale);
        });
    }
    return groups;
}

export interface Selection {
    slot: number;
    positionGroup: PositionGroup;
    player: PlayerWeek | null;
}

/**
 * The XI in 4-3-3 order — GK, four defenders, three midfielders, three forwards — with
 * an empty slot wherever a group had too few eligible players. Nothing is filled from
 * another group to make the numbers up.
 */
export function selectTeam(groups: Record<PositionGroup, PlayerWeek[]>): Selection[] {
    const slots: Selection[] = [];
    for (const group of ['GK', 'DEF', 'MID', 'FWD'] as PositionGroup[]) {
        for (let i = 0; i < RULES.formation[group]; i++) {
            slots.push({ slot: slots.length + 1, positionGroup: group, player: groups[group][i] ?? null });
        }
    }
    return slots;
}

/** A sentence a reader can check against the box scores, built from the components. */
export function explain(player: PlayerWeek): string {
    const parts: string[] = [];
    const total = (key: keyof RatedGame) => player.games.reduce((s, g) => s + (Number(g[key]) || 0), 0);
    const goals = total('goals');
    const assists = total('assists');
    if (goals) parts.push(`${goals} goal${goals === 1 ? '' : 's'}`);
    if (assists) parts.push(`${assists} assist${assists === 1 ? '' : 's'}`);
    const cleanSheets = player.games.filter(g => g.components.clean_sheet).length;
    if (cleanSheets && player.positionGroup !== 'FWD') parts.push(`${cleanSheets} clean sheet${cleanSheets === 1 ? '' : 's'}`);
    if (player.positionGroup === 'GK') {
        const saves = player.games.filter(g => g.saves !== null);
        if (saves.length) parts.push(`${saves.reduce((s, g) => s + (g.saves ?? 0), 0)} saves`);
        const inferred = player.games.some(g => g.goalsAllowedSource === 'inferred');
        parts.push(`${total('goalsAllowed')} goals allowed${inferred ? ' (from the score; no goalkeeping table)' : ''}`);
    }
    const wins = player.games.filter(g => g.components.result === WEIGHTS.win).length;
    if (wins) parts.push(`${wins} win${wins === 1 ? '' : 's'}`);
    const gamesText = `${player.games.length} game${player.games.length === 1 ? '' : 's'}, ${player.totalMinutes} min`;
    const lead = parts.length ? parts.join(', ') : 'no goal involvements';
    return `${lead} (${gamesText}). Best game ${player.bestGame.toFixed(2)} pts; ranked #${player.rank} of ${player.positionGroup}s this week.`;
}
