/**
 * The rating and impact models, pinned at the points where they fail silently.
 *
 * None of these throw when they go wrong. A rating that is not zero-sum leaks points into
 * the league forever; a duplicate fixture moves both teams twice for one result; a draw
 * band fitted across the 2022 overtime rule change is wrong on both sides of it; a
 * per-90 rate without shrinkage puts a twenty-minute substitute top of the country. Each
 * of those produces a plausible-looking number, which is why they are tested rather than
 * eyeballed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, dedupeFixtures, learnAliases, weekOf, outcomeOf } from '../analytics/matches';
import { EloEngine, DEFAULT_ELO, BASELINE, rateHistory } from '../analytics/elo';
import { probabilities, eraOf, fitOutcome, scorelines, Observation } from '../analytics/outcome';
import { assessSeason } from '../analytics/coverage';
import { opponentFactor, summariseSeason, GameImpact, valueGame, returningProduction } from '../analytics/impact';
import { careerSegments } from '../analytics/careers';

function game(overrides: Partial<Match> = {}): Match {
    const date = overrides.date ?? '2024-09-06';
    return {
        game_id: 'g1',
        season: '2024',
        date,
        week: weekOf(date),
        home: 'Home',
        away: 'Away',
        home_score: 2,
        away_score: 1,
        neutral: false,
        status: 'final',
        played: true,
        game_type: 'regular',
        exhibition: false,
        ...overrides
    };
}

test('a week runs Monday to Sunday, so a Friday and a Sunday fixture share one', () => {
    assert.equal(weekOf('2026-09-04'), '2026-08-31'); // Friday
    assert.equal(weekOf('2026-09-06'), '2026-08-31'); // Sunday
    assert.equal(weekOf('2026-08-31'), '2026-08-31'); // the Monday itself
    assert.equal(weekOf('2026-09-07'), '2026-09-07'); // the next Monday starts a new week
});

test('Elo is zero-sum: what one team gains the other loses', () => {
    const engine = new EloEngine(DEFAULT_ELO, new Set(['Home', 'Away']));
    const rated = engine.apply(game());
    assert.equal(
        Math.round((rated.home_elo_after - rated.home_elo_before) * 1e6),
        -Math.round((rated.away_elo_after - rated.away_elo_before) * 1e6)
    );
    assert.ok(rated.elo_change > 0, 'the winner should gain');
});

test('home advantage applies except at a neutral site', () => {
    const engine = new EloEngine(DEFAULT_ELO, new Set(['Home', 'Away']));
    assert.equal(engine.diff('Home', 'Away', false), DEFAULT_ELO.homeAdvantage);
    assert.equal(engine.diff('Home', 'Away', true), 0);
});

test('a draw between equals moves nobody, and an away draw moves the underdog up', () => {
    const level = new EloEngine({ ...DEFAULT_ELO, homeAdvantage: 0 }, new Set(['Home', 'Away']));
    const drawn = level.apply(game({ home_score: 1, away_score: 1 }));
    assert.equal(Math.round(drawn.elo_change * 1e6), 0);

    // With home advantage the home side is the favourite, so a draw costs them.
    const withHome = new EloEngine(DEFAULT_ELO, new Set(['Home', 'Away']));
    assert.ok(withHome.apply(game({ home_score: 0, away_score: 0 })).elo_change < 0);
});

test('a bigger margin moves the rating further, but sub-linearly', () => {
    const move = (home: number, away: number) =>
        new EloEngine(DEFAULT_ELO, new Set(['Home', 'Away'])).apply(game({ home_score: home, away_score: away }))
            .elo_change;
    const one = move(1, 0);
    const five = move(5, 0);
    assert.ok(five > one, 'five goals should count for more than one');
    assert.ok(five < one * 5, 'and for less than five times as much');
});

test('an opponent outside the inventory starts below a rated team', () => {
    const engine = new EloEngine(DEFAULT_ELO, new Set(['Home']));
    assert.equal(engine.rating('Home'), DEFAULT_ELO.initial);
    assert.equal(engine.rating('Some D3 College'), DEFAULT_ELO.initialUnrated);
});

test('ratings regress between seasons, and further across a season that was skipped', () => {
    const params = { ...DEFAULT_ELO, carryover: 0.5, homeAdvantage: 0 };
    const climb = (seasons: string[]) => {
        const engine = new EloEngine(params, new Set(['Home', 'Away']));
        engine.apply(game({ season: seasons[0], date: `${seasons[0]}-09-06`, home_score: 9, away_score: 0 }));
        const before = engine.rating('Home');
        engine.apply(game({ season: seasons[1], date: `${seasons[1]}-09-06`, home_score: 0, away_score: 0 }));
        return { before, after: engine.rating('Home') };
    };

    const consecutive = climb(['2018', '2019']);
    const gapped = climb(['2018', '2020']);
    assert.ok(consecutive.after < consecutive.before, 'a rating above the mean should fall back toward it');
    assert.ok(
        gapped.after < consecutive.after,
        'two years of graduations should regress further than one'
    );
});

test('a stray row from an earlier season does not trigger a second regression', () => {
    // Season files can hold dates in the next calendar year — most of the country played
    // its 2020 season in spring 2021 — so date order and season order can disagree.
    const params = { ...DEFAULT_ELO, carryover: 0.5, homeAdvantage: 0 };
    const engine = new EloEngine(params, new Set(['Home', 'Away']));
    engine.apply(game({ season: '2019', date: '2019-09-06', home_score: 9, away_score: 0 }));
    engine.apply(game({ season: '2020', date: '2020-09-06', home_score: 0, away_score: 0 }));
    const afterForward = engine.rating('Home');
    engine.apply(game({ season: '2019', date: '2020-09-07', home_score: 0, away_score: 0 }));
    // The second game is a draw between a favourite and an underdog, so it moves the
    // rating a little; what it must not do is regress it toward 1500 all over again.
    assert.ok(Math.abs(engine.rating('Home') - afterForward) < 20);
});

test('the three outcome probabilities are a distribution and respond to the rating gap', () => {
    const params = { beta: 0.005, drawBand: { overtime: 0.25, 'no-overtime': 0.45 } };
    for (const diff of [-400, -100, 0, 100, 400]) {
        const p = probabilities(diff, 'no-overtime', params);
        assert.ok(p.every(value => value > 0 && value < 1), `${diff} produced ${p}`);
        assert.ok(Math.abs(p[0] + p[1] + p[2] - 1) < 1e-9);
    }
    assert.ok(probabilities(200, 'no-overtime', params)[0] > probabilities(0, 'no-overtime', params)[0]);
    assert.ok(probabilities(-200, 'no-overtime', params)[2] > probabilities(0, 'no-overtime', params)[2]);
});

test('the draw band is per era, because the 2022 rule change nearly doubled draws', () => {
    assert.equal(eraOf('2021'), 'overtime');
    assert.equal(eraOf('2022'), 'no-overtime');

    const params = { beta: 0.005, drawBand: { overtime: 0.25, 'no-overtime': 0.45 } };
    const withOvertime = probabilities(0, 'overtime', params)[1];
    const without = probabilities(0, 'no-overtime', params)[1];
    assert.ok(without > withOvertime, 'no overtime should mean more draws');
});

test('the fitted draw band recovers the draw rate it was trained on', () => {
    // A synthetic league of evenly matched teams that draws a quarter of the time. The
    // fit has nothing else to explain, so it should put a quarter of the mass on the draw.
    const observations: Observation[] = [];
    for (let i = 0; i < 400; i++) {
        const outcome = i % 4 === 0 ? 1 : i % 2 === 0 ? 0 : 2;
        observations.push({
            elo_diff: 0,
            rating_diff: 0,
            neutral: true,
            era: 'no-overtime',
            outcome: outcome as 0 | 1 | 2,
            home_goals: 1,
            away_goals: outcome === 1 ? 1 : 0
        });
    }
    const fitted = fitOutcome(observations);
    assert.ok(Math.abs(probabilities(0, 'no-overtime', fitted)[1] - 0.25) < 0.03);
});

test('scoreline probabilities agree with the outcome model they were scaled to', () => {
    const outcome: [number, number, number] = [0.5, 0.2, 0.3];
    const lines = scorelines({ home: 1.6, away: 1.1 }, outcome, 49);
    const homeWins = lines.filter(l => l.home > l.away).reduce((sum, l) => sum + l.probability, 0);
    assert.ok(Math.abs(homeWins - 0.5) < 0.02, `home-win mass was ${homeWins}`);
});

test('duplicate fixtures collapse once both spellings resolve to the same schools', () => {
    // Two rows for one game: each school filed it under its own spelling, so the storage
    // layer's key never matched and both survived to here.
    const rows = [
        game({ game_id: 'a', home: 'California Baptist', away: 'Denver', played: false, home_score: null, away_score: null, status: 'scheduled' }),
        game({ game_id: 'b', home: 'California Baptist', away: 'Denver' })
    ];
    const deduped = dedupeFixtures(rows);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].game_id, 'b', 'the row with a result should win');
});

test('the same game filed on two dates is one game', () => {
    // Conference tournaments are where the two schools disagree about *when*: one files
    // the semi-final on the Friday and its opponent on the Saturday, so the same 2-0
    // moves both ratings twice.
    const merged = dedupeFixtures([
        game({ game_id: 'a', season: '2017', date: '2017-11-08', home: 'Old Dominion', away: 'South Carolina', home_score: 2, away_score: 0 }),
        game({ game_id: 'b', season: '2017', date: '2017-11-09', home: 'Old Dominion', away: 'South Carolina', home_score: 2, away_score: 0 })
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].date, '2017-11-08', 'the earlier date is kept, deterministically');

    // Two genuine meetings are two fixtures: same pair, different results.
    const twice = dedupeFixtures([
        game({ game_id: 'a', season: '2017', date: '2017-09-01', home: 'Duke', away: 'Wake Forest', home_score: 2, away_score: 0 }),
        game({ game_id: 'b', season: '2017', date: '2017-09-03', home: 'Duke', away: 'Wake Forest', home_score: 1, away_score: 1 })
    ]);
    assert.equal(twice.length, 2);

    // And a rematch later in the season is never touched, whatever the score.
    const rematch = dedupeFixtures([
        game({ game_id: 'a', season: '2017', date: '2017-09-01', home: 'Duke', away: 'Wake Forest', home_score: 2, away_score: 0 }),
        game({ game_id: 'b', season: '2017', date: '2017-11-01', home: 'Duke', away: 'Wake Forest', home_score: 2, away_score: 0 })
    ]);
    assert.equal(rematch.length, 2);
});

test('a fixture is one fixture whichever side is listed at home', () => {
    const deduped = dedupeFixtures([game({ game_id: 'a' }), game({ game_id: 'b', home: 'Away', away: 'Home' })]);
    assert.equal(deduped.length, 1);
});

test('a spelling only one school uses is named from the schedule it shadows', () => {
    // SMU's site calls them "HCU"; their own calls them "Houston Christian". Neither
    // string rule nor roster overlap can join the two — "HCU" never appears in a box
    // score — but a team plays one game a day, so the two rows are one fixture.
    const rated = new Set(['SMU', 'Houston Christian', 'Jacksonville']);
    const matches = [
        game({ game_id: 'a', date: '2026-08-31', home: 'SMU', away: 'HCU', played: false, home_score: null, away_score: null }),
        game({ game_id: 'b', date: '2026-08-31', home: 'Houston Christian', away: 'SMU', played: false, home_score: null, away_score: null }),
        game({ game_id: 'c', date: '2026-08-20', home: 'Jacksonville', away: 'Houston Christian' })
    ];
    assert.equal(learnAliases(matches, rated).get('HCU'), 'Houston Christian');
});

test('a school that merely shared a date is not renamed after the team it played beside', () => {
    // Colgate is a real school the inventory does not hold. It became "Drake" the moment
    // one of its fixtures landed on the same day as one of Drake's, until the rule was
    // made to check the rest of the season.
    const rated = new Set(['Cornell', 'Drake', 'Bradley']);
    const matches = [
        game({ game_id: 'a', date: '2023-09-01', home: 'Cornell', away: 'Colgate' }),
        game({ game_id: 'b', date: '2023-09-01', home: 'Cornell', away: 'Drake' }),
        // Colgate and Drake play different opponents on the same later date, which two
        // spellings of one school cannot do.
        game({ game_id: 'c', date: '2023-09-08', home: 'Colgate', away: 'Bradley' }),
        game({ game_id: 'd', date: '2023-09-08', home: 'Drake', away: 'Cornell' })
    ];
    assert.equal(learnAliases(matches, rated).has('Colgate'), false);
});

test('an exhibition is not evidence about a team\'s calendar', () => {
    // A friendly is the one thing a team really does play alongside a real fixture on the
    // same day. St. Thomas's against Western Iowa Tech made that opponent Houston
    // Christian.
    const rated = new Set(['St. Thomas', 'Houston Christian']);
    const matches = [
        game({ game_id: 'a', date: '2024-08-17', home: 'St. Thomas', away: 'Western Iowa Tech', exhibition: true, played: false, home_score: null, away_score: null }),
        game({ game_id: 'b', date: '2024-08-17', home: 'St. Thomas', away: 'Houston Christian', played: false, home_score: null, away_score: null })
    ];
    assert.equal(learnAliases(matches, rated).has('Western Iowa Tech'), false);
});

test('two schools claimed as the same opponent are not merged into one', () => {
    // Both are real. There is no unknown side to name after the known one, so the rule
    // must decline rather than pick a winner.
    const rated = new Set(['Lehigh', 'Boston College', 'Boston University']);
    const matches = [
        game({ game_id: 'a', date: '2017-09-30', home: 'Lehigh', away: 'Boston College', home_score: 0, away_score: 2 }),
        game({ game_id: 'b', date: '2017-09-30', home: 'Lehigh', away: 'Boston University', home_score: 0, away_score: 2 })
    ];
    assert.equal(learnAliases(matches, rated).size, 0);
});

test('a season missing more than a fifth of Division I is excluded', () => {
    const rated = new Set(Array.from({ length: 100 }, (_, i) => `Team ${i}`));
    const rosters = (n: number) =>
        new Map(Array.from({ length: n }, (_, i) => [`Team ${i}`, 25] as [string, number]));

    const good = assessSeason({ season: '2024', rosterSizes: rosters(85), matches: [], players: 0 }, rated);
    assert.equal(good.usable, true);
    assert.equal(good.note, null);

    const thin = assessSeason({ season: '2020', rosterSizes: rosters(60), matches: [], players: 0 }, rated);
    assert.equal(thin.usable, false);
    assert.ok(thin.note?.includes('40%'));

    // Exactly at the limit is still usable; the rule is "more than a fifth missing".
    const edge = assessSeason({ season: '2019', rosterSizes: rosters(80), matches: [], players: 0 }, rated);
    assert.equal(edge.usable, true);
});

test('a squad of fewer than eleven does not count as a roster', () => {
    const rated = new Set(['A', 'B']);
    const coverage = assessSeason(
        { season: '2024', rosterSizes: new Map([['A', 25], ['B', 4]]), matches: [], players: 29 },
        rated
    );
    assert.equal(coverage.teams_with_roster, 1);
});

test('production is worth more against a stronger opponent', () => {
    assert.ok(opponentFactor(1900) > opponentFactor(BASELINE));
    assert.ok(opponentFactor(1200) < opponentFactor(BASELINE));
    // Clamped at both ends, so one absurd rating cannot dominate a season.
    assert.ok(opponentFactor(3000) <= 1.5);
    assert.ok(opponentFactor(0) >= 0.65);
});

test('a keeper is not judged on a box score that never recorded saves', () => {
    // Half the team-games in this dataset have no saves column at all. Without this, a
    // keeper in one of them faces nothing but the goals that went in, and every one reads
    // as a goal they should have stopped.
    const rates = { chanceValue: 0.3, shotValue: 0.12, saveRate: 0.7 };
    const context = {
        game_id: 'g',
        season: '2024',
        date: '2024-09-06',
        week: '2024-09-02',
        opponentOf: () => 'Away',
        opponentElo: () => BASELINE,
        concededBy: () => 3,
        scoredBy: () => 0,
        savesRecorded: () => false
    };
    const row = {
        game_id: 'g',
        team: 'Home',
        player_name: 'Keeper',
        identity: 'Home::keeper',
        jersey_number: '1',
        minutes: 90,
        goals: 0,
        assists: 0,
        shots: 0,
        shots_on_goal: 0,
        saves: 0
    };
    const valued = valueGame(row, context, rates, true);
    assert.equal(valued.keeping, 0);
    assert.equal(valued.goals_against, 0, 'no goals may be charged against an unrecorded game');
});

test('a keeper is credited with the goals they prevented, not with saves alone', () => {
    const rates = { chanceValue: 0.3, shotValue: 0.12, saveRate: 0.7 };
    const context = {
        game_id: 'g',
        season: '2024',
        date: '2024-09-06',
        week: '2024-09-02',
        opponentOf: () => 'Away',
        opponentElo: () => BASELINE,
        concededBy: () => 1,
        scoredBy: () => 2,
        savesRecorded: () => true
    };
    const row = {
        game_id: 'g',
        team: 'Home',
        player_name: 'Keeper',
        identity: 'Home::keeper',
        jersey_number: '1',
        minutes: 90,
        goals: 0,
        assists: 0,
        shots: 0,
        shots_on_goal: 0,
        saves: 9
    };
    const busy = valueGame(row, context, rates, true);
    // Nine saves and one goal is ten shots faced. A league keeper saving 70% of them
    // concedes three; this one conceded one, so two goals were prevented. Crediting the
    // *saves* instead — ten at 70% is seven — would inflate every keeper in the dataset
    // by more than a striker's whole season.
    assert.ok(Math.abs(busy.keeping - (10 * 0.3 - 1)) < 1e-9, `keeping was ${busy.keeping}`);

    // The same player judged as an outfielder gets nothing for it, which is what stops a
    // keeper's saves being double counted anywhere else.
    assert.equal(valueGame(row, context, rates, false).keeping, 0);
});

test('a short sample is shrunk toward the league mean rather than topping the table', () => {
    const impact = (identity: string, minutes: number, value: number): GameImpact => ({
        identity,
        player_name: identity,
        team: 'Home',
        jersey_number: '9',
        game_id: `g-${identity}-${minutes}`,
        season: '2024',
        date: '2024-09-06',
        week: '2024-09-02',
        opponent: 'Away',
        opponent_elo: BASELINE,
        minutes,
        goals: 0,
        assists: 0,
        shots: 0,
        shots_on_goal: 0,
        saves: 0,
        goals_against: 0,
        attacking: value,
        keeping: 0,
        impact: value,
        result: 'W',
        scored: 1,
        conceded: 0
    });

    // A regular producing steadily over 1,500 minutes, against a substitute who scored
    // twice in twenty. The cameo's raw rate is nine goals per 90.
    const games: GameImpact[] = [];
    for (let i = 0; i < 17; i++) games.push(impact('regular', 90, 1));
    games.push(impact('cameo', 20, 2));
    for (let i = 0; i < 200; i++) games.push(impact(`filler-${i}`, 90, 0.2));

    const totals = summariseSeason(games, () => 'Test');
    const regular = totals.find(t => t.identity === 'regular')!;
    const cameo = totals.find(t => t.identity === 'cameo')!;

    assert.ok(cameo.impact_per90 < regular.impact_per90, 'twenty minutes is not evidence of a better player');
    assert.equal(cameo.qualified, false, 'and it is not enough minutes to be ranked');
    assert.equal(regular.qualified, true);
});

test('returning production is the share of last season kept, per team', () => {
    const player = (identity: string, team: string, season: string, impact: number) => ({
        identity,
        player_name: identity,
        team,
        conference: 'Test',
        season,
        jersey_number: '',
        games: 10,
        minutes: 900,
        goals: 0,
        assists: 0,
        shots: 0,
        shots_on_goal: 0,
        saves: 0,
        goals_against: 0,
        is_keeper: false,
        keeper_games: 0,
        impact,
        impact_per90: impact / 10,
        opponent_strength: BASELINE,
        rating: 50,
        qualified: true,
        division_one: true
    });

    const returning = returningProduction(
        new Map([
            ['2023', [player('a', 'Home', '2023', 30), player('b', 'Home', '2023', 10)]],
            ['2024', [player('a', 'Home', '2024', 25)]]
        ])
    );
    assert.equal(returning.get('2024:Home'), 0.75);

    // A gap in the dataset is not a graduating class: 2023 to 2025 is not traced at all.
    const gapped = returningProduction(
        new Map([
            ['2023', [player('a', 'Home', '2023', 30)]],
            ['2025', [player('a', 'Home', '2025', 30)]]
        ])
    );
    assert.equal(gapped.size, 0);
});

test('a name spanning more than an eligibility window is cut into separate careers', () => {
    // Non-overlapping stints were enough while the dataset held five seasons. Over eleven
    // they are not: a 2016 senior and a 2026 freshman with the same name never overlap
    // either, and joining them produced careers six schools long.
    const one = careerSegments(['2021', '2022', '2023', '2024']);
    assert.equal(new Set(one.values()).size, 1, 'four consecutive seasons are one career');

    const split = careerSegments(['2016', '2017', '2024', '2025', '2026']);
    assert.equal(split.get('2016'), 0);
    assert.equal(split.get('2017'), 0);
    assert.equal(split.get('2024'), 1, 'seven years later is a different person');
    assert.equal(split.get('2026'), 1);

    // A season missing from the dataset is a hole, not a departure: 2020 is excluded, and
    // a player either side of it is still one player.
    const across = careerSegments(['2018', '2019', '2021', '2022']);
    assert.equal(new Set(across.values()).size, 1);

    // Seven straight seasons outlast any eligibility, so the run is cut even with no gap.
    const long = careerSegments(['2016', '2017', '2018', '2019', '2021', '2022', '2023']);
    assert.ok(new Set(long.values()).size > 1);
    assert.equal(long.get('2016'), 0);
    assert.equal(long.get('2023'), 1);
});

test('only played games move a rating', () => {
    const matches = [game(), game({ game_id: 'g2', played: false, home_score: null, away_score: null })];
    const { rated_games } = rateHistory(matches, DEFAULT_ELO, new Set(['Home', 'Away']));
    assert.equal(rated_games.length, 1);
    assert.equal(outcomeOf(matches[1]), null);
});
