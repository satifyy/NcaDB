/**
 * The Team of the Week model, rule by rule. No database: these run in `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PlayerGameInput,
    WEIGHTS,
    explain,
    keeperGoalsAllowed,
    rateGame,
    rateWeek,
    selectTeam,
    weekStartOf,
    weekStatus
} from '../src';

let nextId = 1;
function row(overrides: Partial<PlayerGameInput> = {}): PlayerGameInput {
    const id = overrides.playerId ?? nextId++;
    return {
        playerId: id,
        playerName: `Player ${id}`,
        teamId: 1,
        teamName: 'Duke',
        gameId: 100,
        gameDate: '2026-10-07',
        opponentName: 'Elon',
        positionGroup: 'MID',
        position: 'mid',
        minutes: 90,
        goals: 0,
        assists: 0,
        shotsOnGoal: 0,
        saves: null,
        goalsAllowed: null,
        teamScore: 1,
        opponentScore: 1,
        teamKeepersUsed: 1,
        gameMinutes: 90,
        ...overrides
    };
}

/** A full week: enough players in every group, distinct scores. */
function fullWeek(): PlayerGameInput[] {
    const rows: PlayerGameInput[] = [];
    const groups = [['GK', 3], ['DEF', 8], ['MID', 6], ['FWD', 6]] as const;
    for (const [group, n] of groups) {
        for (let i = 0; i < n; i++) {
            rows.push(row({
                positionGroup: group,
                goals: group === 'GK' ? 0 : i % 3,
                assists: i % 2,
                goalsAllowed: group === 'GK' ? i : null,
                saves: group === 'GK' ? 3 + i : null,
                gameId: 200 + rows.length
            }));
        }
    }
    return rows;
}

test('selects exactly eleven, in 4-3-3 order, and nobody twice', () => {
    const xi = selectTeam(rateWeek(fullWeek()));
    assert.equal(xi.length, 11);
    assert.deepEqual(xi.map(s => s.positionGroup), ['GK', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD']);
    assert.ok(xi.every(s => s.player));
    assert.equal(new Set(xi.map(s => s.player!.playerId)).size, 11);
    assert.deepEqual(xi.map(s => s.slot), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('too few eligible players leaves slots empty rather than borrowing from another group', () => {
    const rows = fullWeek().filter(r => r.positionGroup !== 'FWD');
    rows.push(row({ positionGroup: 'FWD', goals: 3 }));
    const xi = selectTeam(rateWeek(rows));
    const forwards = xi.filter(s => s.positionGroup === 'FWD');
    assert.equal(forwards.filter(s => s.player).length, 1);
    assert.equal(forwards.filter(s => !s.player).length, 2);
    assert.equal(selectTeam(rateWeek([])).filter(s => s.player).length, 0);
});

test('a player is ranked in one group only: the one they played most minutes in', () => {
    const id = 9001;
    const groups = rateWeek([
        row({ playerId: id, positionGroup: 'DEF', gameId: 1, gameDate: '2026-10-06', minutes: 90 }),
        row({ playerId: id, positionGroup: 'MID', gameId: 2, gameDate: '2026-10-09', minutes: 70, goals: 2 })
    ]);
    assert.equal(groups.DEF.length, 1);
    assert.equal(groups.MID.length, 0, 'the midfield game is not counted toward a defender’s week');
    assert.equal(groups.DEF[0].games.length, 1);
});

test('position eligibility: a game needs 60 minutes (80 in goal) to be rated', () => {
    assert.equal(rateGame(row({ minutes: 59, goals: 2 })), null);
    assert.ok(rateGame(row({ minutes: 60 })));
    assert.equal(rateGame(row({ positionGroup: 'GK', minutes: 79, goalsAllowed: 0 })), null);
    assert.ok(rateGame(row({ positionGroup: 'GK', minutes: 90, goalsAllowed: 0 })));
});

test('a two-game week does not beat an excellent single game on accumulation alone', () => {
    const single = row({ playerId: 1, positionGroup: 'FWD', goals: 3, gameId: 1 });
    const twoGames = [
        row({ playerId: 2, positionGroup: 'FWD', goals: 1, gameId: 2, gameDate: '2026-10-06' }),
        row({ playerId: 2, positionGroup: 'FWD', goals: 1, gameId: 3, gameDate: '2026-10-09' })
    ];
    const fwd = rateWeek([single, ...twoGames]).FWD;
    assert.equal(fwd[0].playerId, 1, 'a hat trick outranks one goal in each of two games');
    // But a strong second game still counts for something.
    const better = rateWeek([
        row({ playerId: 3, positionGroup: 'FWD', goals: 2, gameId: 4 }),
        row({ playerId: 3, positionGroup: 'FWD', goals: 2, gameId: 5, gameDate: '2026-10-09' }),
        row({ playerId: 4, positionGroup: 'FWD', goals: 2, gameId: 6 }),
        row({ playerId: 4, positionGroup: 'FWD', goals: 0, gameId: 7, gameDate: '2026-10-09' })
    ]).FWD;
    assert.equal(better[0].playerId, 3);
});

test('weights are applied by position: a defender’s goal outweighs a forward’s', () => {
    const def = rateGame(row({ positionGroup: 'DEF', goals: 1, opponentScore: 1 }))!;
    const fwd = rateGame(row({ positionGroup: 'FWD', goals: 1, opponentScore: 1 }))!;
    assert.equal(def.components.goals, WEIGHTS.goal.DEF);
    assert.equal(fwd.components.goals, WEIGHTS.goal.FWD);
});

test('a goal is not counted twice through the shots-on-target credit', () => {
    const game = rateGame(row({ positionGroup: 'FWD', goals: 2, shotsOnGoal: 3 }))!;
    assert.equal(game.components.shots_on_target, WEIGHTS.shotOnTargetNotScored);
});

test('missing statistics are not zeros: they add nothing and are reported', () => {
    const keeper = row({ positionGroup: 'GK', saves: null, goalsAllowed: 0, opponentScore: 0 });
    const game = rateGame(keeper)!;
    assert.equal(game.components.saves, undefined);
    const week = rateWeek([keeper]).GK[0];
    assert.deepEqual(week.missing, ['saves']);
    const noShots = rateWeek([row({ positionGroup: 'FWD', shotsOnGoal: null, goals: 1 })]).FWD[0];
    assert.deepEqual(noShots.missing, ['shots_on_goal']);
});

test('keeper goals allowed: official when published, inferred only when unambiguous, otherwise unrated', () => {
    assert.deepEqual(keeperGoalsAllowed(row({ positionGroup: 'GK', goalsAllowed: 2, opponentScore: 3 })), { value: 2, source: 'official' });
    assert.deepEqual(keeperGoalsAllowed(row({ positionGroup: 'GK', goalsAllowed: null, opponentScore: 3 })), { value: 3, source: 'inferred' });
    // Two keepers shared the game: whose goals were whose is unknowable from the score.
    assert.deepEqual(keeperGoalsAllowed(row({ positionGroup: 'GK', goalsAllowed: null, teamKeepersUsed: 2 })), { value: null, source: 'unknown' });
    // Subbed off before the end.
    assert.deepEqual(keeperGoalsAllowed(row({ positionGroup: 'GK', goalsAllowed: null, minutes: 85, gameMinutes: 90 })).source, 'unknown');
    assert.equal(rateGame(row({ positionGroup: 'GK', goalsAllowed: null, teamKeepersUsed: 2 })), null);
    const inferred = rateWeek([row({ positionGroup: 'GK', goalsAllowed: null, opponentScore: 1, saves: 4 })]).GK[0];
    assert.equal(inferred.games[0].goalsAllowedSource, 'inferred');
    assert.match(explain(inferred), /from the score/);
});

test('defenders are charged only for goals conceded while on the field, pro rata', () => {
    const full = rateGame(row({ positionGroup: 'DEF', opponentScore: 2, minutes: 90 }))!;
    const part = rateGame(row({ positionGroup: 'DEF', opponentScore: 2, minutes: 60 }))!;
    assert.equal(full.components.goals_conceded, 2 * WEIGHTS.goalConceded.DEF);
    assert.ok(part.components.goals_conceded > full.components.goals_conceded);
});

test('ties break deterministically: best game, then fewer minutes, then player id', () => {
    const a = row({ playerId: 50, positionGroup: 'MID', goals: 1, minutes: 90 });
    const b = row({ playerId: 40, positionGroup: 'MID', goals: 1, minutes: 75 });
    const c = row({ playerId: 30, positionGroup: 'MID', goals: 1, minutes: 75 });
    for (const order of [[a, b, c], [c, b, a], [b, a, c]]) {
        assert.deepEqual(rateWeek(order).MID.map(p => p.playerId), [30, 40, 50]);
    }
});

test('the same inputs always produce the same ratings', () => {
    const rows = fullWeek();
    assert.deepEqual(rateWeek(rows), rateWeek([...rows].reverse()));
});

test('ratings sit on 0-10 and rank within their group', () => {
    const groups = rateWeek(fullWeek());
    for (const list of Object.values(groups)) {
        list.forEach((p, i) => {
            assert.equal(p.rank, i + 1);
            assert.ok(p.rating >= 0 && p.rating <= 10);
        });
        for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].rating >= list[i].rating);
    }
});

test('weeks run Monday to Sunday, and a week is final only after the correction window', () => {
    assert.equal(weekStartOf('2026-10-12'), '2026-10-12'); // Monday
    assert.equal(weekStartOf('2026-10-18'), '2026-10-12'); // Sunday
    assert.equal(weekStartOf('2026-10-19'), '2026-10-19');
    assert.equal(weekStatus('2026-10-12', '2026-10-15'), 'in_progress');
    assert.equal(weekStatus('2026-10-12', '2026-10-18'), 'in_progress');
    assert.equal(weekStatus('2026-10-12', '2026-10-19'), 'provisional');
    assert.equal(weekStatus('2026-10-12', '2026-10-26'), 'provisional');
    assert.equal(weekStatus('2026-10-12', '2026-10-27'), 'final');
});
