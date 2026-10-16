import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GameCsvRow, PlayerStatCsvRow } from '@ncaa/storage';
import { SchoolIndex } from '../../scraper/src/utils/school_names';
import type { TeamConfig } from '../../scraper/src/utils/teams';
import {
    IssueLog,
    TeamResolver,
    attributeToFixtures,
    buildSeasonBatch,
    count,
    displayName,
    normalizeGames,
    normalizeStats,
    playerLetters,
    teamSlug
} from '../src/normalize';
import type { Inventory } from '../src/normalize';

function inventory(): Inventory {
    const teams: TeamConfig[] = [
        { team_id: 'OAKLAND', name_canonical: 'Oakland', conference: 'Horizon', schedule_url: 'https://goldengrizzlies.com/sports/mens-soccer/schedule', platform_guess: 'sidearm' },
        { team_id: 'LOYOLA_CHICAGO', name_canonical: 'Loyola Chicago', conference: 'Atlantic 10', schedule_url: 'https://loyolaramblers.com/sports/mens-soccer/schedule', platform_guess: 'sidearm' },
        { team_id: 'NC_STATE', name_canonical: 'NC State', conference: 'ACC', schedule_url: 'https://gopack.com/sports/mens-soccer/schedule', platform_guess: 'sidearm', aliases: ['North Carolina State'] }
    ];
    const index = new SchoolIndex<TeamConfig>();
    teams.forEach(t => index.add(t));
    return { teams, index, unscraped: [], ambiguous: new Map() };
}

const gameRow = (overrides: Partial<GameCsvRow> = {}): GameCsvRow => ({
    game_id: 'g1',
    date: '2025-09-05',
    home_team_name: 'Oakland',
    away_team_name: 'Loyola Chicago',
    home_team_ranked: 'false',
    away_team_ranked: 'false',
    home_score: '1',
    away_score: '0',
    location_type: 'home',
    status: 'final',
    schedule_url: '',
    boxscore_url: 'https://goldengrizzlies.com/boxscore/1',
    boxscore_url_alt: '',
    dedupe_key: '2025-09-05-Loyola-Chicago-Oakland',
    game_type: 'regular',
    ...overrides
});

const statRow = (overrides: Partial<PlayerStatCsvRow> = {}): PlayerStatCsvRow => ({
    game_id: 'g1',
    team_id: 'Oakland',
    player_name: 'Smith, Alex',
    player_key: 'oakland:smithalex',
    jersey_number: '9',
    minutes: '90',
    goals: '1',
    assists: '0',
    shots: '3',
    shots_on_goal: '2',
    saves: '',
    ...overrides
});

test('team slugs are stable and URL-safe', () => {
    assert.equal(teamSlug('NC State'), 'nc-state');
    assert.equal(teamSlug('William & Mary'), 'william-and-mary');
    assert.equal(teamSlug('São Paulo'), 'sao-paulo');
});

test('player identity ignores "Last, First" vs "First Last" formatting', () => {
    assert.equal(displayName('Skinner, Luke'), 'Luke Skinner');
    assert.equal(playerLetters('Skinner, Luke'), playerLetters('Luke Skinner'));
    assert.equal(displayName('Luke Skinner Jr.'), 'Luke Skinner Jr.');
});

test('an empty stat cell is null, never zero', () => {
    assert.equal(count(''), null);
    assert.equal(count(undefined), null);
    assert.equal(count('0'), 0);
    const issues = new IssueLog();
    assert.equal(count('1.5', issues, 'goals'), null);
    assert.equal(issues.list()[0].code, 'non_numeric_stat');
});

test('schedule rows: bracket placeholders, bad dates and unscored finals are handled, not stored blindly', () => {
    const resolver = new TeamResolver(inventory());
    const issues = new IssueLog();
    const games = normalizeGames(
        [
            gameRow(),
            gameRow({ game_id: 'g2', dedupe_key: 'k2', away_team_name: 'CAA Quarterfinals', status: 'scheduled', home_score: '', away_score: '' }),
            gameRow({ game_id: 'g3', dedupe_key: 'k3', date: '2025-01-01', status: 'scheduled', home_score: '', away_score: '' }),
            gameRow({ game_id: 'g4', dedupe_key: 'k4', date: '2025-10-01', home_score: '' }),
            gameRow({ game_id: 'g5', dedupe_key: 'k5', date: '2024-10-01' }),
            gameRow({ game_id: 'g6', dedupe_key: 'k6', date: 'TBA' })
        ],
        2025,
        resolver,
        issues
    );
    assert.deepEqual(games.map(g => g.sourceGameId), ['g1', 'g4']);
    assert.equal(games[1].status, 'unknown'); // "final" with no score
    assert.equal(games[1].homeScore, null);
    const codes = issues.list().map(i => i.code).sort();
    assert.deepEqual(codes, ['date_outside_season', 'final_without_score', 'invalid_date', 'not_a_team', 'placeholder_date']);
});

test('a result dated in the future is kept but not counted as a result', () => {
    const season = new Date().getUTCFullYear() + 1;
    const issues = new IssueLog();
    const [g] = normalizeGames([gameRow({ date: `${season}-10-01` })], season, new TeamResolver(inventory()), issues);
    assert.equal(g.status, 'unknown');
    assert.equal(g.homeScore, 1);
    assert.deepEqual(issues.list().map(i => i.code), ['final_in_future']);
});

test('names resolve through the inventory: aliases and decorations land on one team', () => {
    const resolver = new TeamResolver(inventory());
    assert.equal(resolver.resolve('#12 NC State')?.slug, 'nc-state');
    assert.equal(resolver.resolve('North Carolina State')?.slug, 'nc-state');
    assert.equal(resolver.resolve('Mount Olive')?.slug, 'mount-olive'); // not D1, kept as itself
    assert.equal(resolver.resolve('First Round'), null);
});

test('placeholder players and unknown teams are rejected from box scores', () => {
    const resolver = new TeamResolver(inventory());
    const issues = new IssueLog();
    const stats = normalizeStats(
        [statRow(), statRow({ player_name: 'Player', jersey_number: '##' }), statRow({ team_id: 'Unknown' }), statRow({ player_name: 'TEAM' })],
        resolver,
        issues
    );
    assert.equal(stats.length, 1);
    assert.equal(stats[0].displayName, 'Alex Smith');
    assert.equal(stats[0].saves, null);
    assert.deepEqual(issues.list().map(i => [i.code, i.count]).sort(), [['placeholder_player', 2], ['stat_unknown_team', 1]]);
});

test('an abbreviated label is attributed to the only unclaimed side of its fixture', () => {
    const resolver = new TeamResolver(inventory());
    const issues = new IssueLog();
    const games = normalizeGames([gameRow()], 2025, resolver, issues);
    const stats = normalizeStats([statRow(), statRow({ team_id: 'LUC', player_name: 'Doe, Jo' })], resolver, issues);
    const fixed = attributeToFixtures(stats, games, issues);
    assert.equal(fixed[1].teamSlug, 'loyola-chicago');
    assert.equal(fixed[1].identityKey, 'loyola-chicago:jodoe');
});

test('two abbreviated labels are attributed by roster overlap, or not at all', () => {
    const resolver = new TeamResolver(inventory());
    const issues = new IssueLog();
    const games = normalizeGames(
        [gameRow(), gameRow({ game_id: 'g2', dedupe_key: 'k2', date: '2025-09-09' })],
        2025,
        resolver,
        issues
    );
    const roster = (team: string, game: string, names: string[]) =>
        names.map(n => statRow({ game_id: game, team_id: team, player_name: n }));
    const oakland = ['A One', 'B Two', 'C Three', 'D Four'];
    const loyola = ['E Five', 'F Six', 'G Seven', 'H Eight'];
    const stats = normalizeStats(
        [
            // Game 1 names both schools properly: that is where the rosters come from.
            ...roster('Oakland', 'g1', oakland),
            ...roster('Loyola Chicago', 'g1', loyola),
            // Game 2 labels both sides by abbreviation.
            ...roster('OU', 'g2', oakland),
            ...roster('LUC', 'g2', loyola)
        ],
        resolver,
        issues
    );
    const fixed = attributeToFixtures(stats, games, issues);
    const g2 = fixed.filter(s => s.sourceGameId === 'g2');
    assert.deepEqual([...new Set(g2.map(s => `${s.sourceTeamName}->${s.teamSlug}`))].sort(), ['LUC->loyola-chicago', 'OU->oakland']);
});

test('only teams a stored row uses are created', () => {
    const { batch } = buildSeasonBatch(
        2025,
        [gameRow()],
        [statRow({ team_id: 'OU' }), statRow({ team_id: 'Loyola Chicago', player_name: 'Doe, Jo' })],
        inventory(),
        true
    );
    assert.ok(!batch.teams.some(t => t.slug === 'ou'), 'the abbreviation must not become a team');
    assert.equal(batch.teams.filter(t => t.isDivisionOne).length, 3);
});

// ---------------------------------------------------------------------------------------
// Team identity against the real inventory files (issue #42).

import * as path from 'path';
import { loadInventory } from '../src/normalize';
import { NOT_A_TEAM } from '../../scraper/src/analytics/matches';

const realTeams = path.resolve(__dirname, '../../../data/teams');

test('ranked spellings resolve to the school, not to a team of their own', () => {
    const resolver = new TeamResolver(loadInventory(realTeams));
    for (const [raw, slug] of [
        ['19 Cornell', 'cornell'],
        ['22 Cornell', 'cornell'],
        ['24 Michigan State', 'michigan-state'],
        ['#21/#15 UNC Greensboro', 'unc-greensboro'],
        ['(#8/No. 13 seed) Marshall (Sweet 16)', 'marshall']
    ] as const) {
        assert.equal(resolver.resolve(raw)?.slug, slug, raw);
    }
});

test('bracket placeholders, intrasquad games and conference names are not teams', () => {
    const resolver = new TeamResolver(loadInventory(realTeams));
    for (const raw of ['ELITE 8', 'SWEET 16', 'COLLEGE CUP', 'Round of 16', 'Final Four', 'No. 1', 'Blue & Gold Game',
        'Black & Gold Match', 'Coastal Athletic Association', '2020 Fall Season Cancelled']) {
        assert.equal(resolver.resolve(raw), null, raw);
        assert.ok(NOT_A_TEAM.test(raw), raw);
    }
    // ...and the words that make them placeholders are in no school's name.
    for (const raw of ['Cornell', 'Elon', 'Holy Cross', 'Boston College', 'Texas A&M']) assert.ok(!NOT_A_TEAM.test(raw), raw);
});

test('Division I programs the scraper does not cover are Division I, under one name each', () => {
    const inventory = loadInventory(realTeams);
    const resolver = new TeamResolver(inventory);
    for (const [raw, slug] of [
        ['Elon University', 'elon'], ['Elon (Alumni Day)', 'elon'], ['Albany', 'ualbany'], ['University at Albany', 'ualbany'],
        ['Cal State Bakersfield', 'csu-bakersfield'], ['CSU Bakersfield (Big West Crossover)', 'csu-bakersfield'],
        ['CCSU', 'central-connecticut-state'], ['Fairleigh Dickinson', 'fdu'], ['College of the Holy Cross', 'holy-cross'],
        ['NIU', 'northern-illinois'], ['UWF', 'west-florida']
    ] as const) {
        assert.equal(resolver.resolve(raw)?.slug, slug, raw);
    }
    const used = new Set(['elon', 'central-connecticut-state']);
    const records = resolver.teams(used);
    assert.equal(records.find(t => t.slug === 'elon')?.isDivisionOne, true);
    assert.equal(records.find(t => t.slug === 'elon')?.scheduleUrl, null, 'never scraped');
    assert.equal(records.filter(t => t.isDivisionOne).length, inventory.teams.length + inventory.unscraped.length);
    assert.ok(!inventory.teams.some(t => t.team_id === 'ELON'), 'kept out of the scrape list');
});

test('a disambiguated name is a different school, not the Division I one it resembles', () => {
    const resolver = new TeamResolver(loadInventory(realTeams));
    for (const [raw, slug] of [
        ['Holy Cross College (Ind.)', 'holy-cross-college-ind'],
        ['Georgetown College (Ky.)', 'georgetown-college-ky'],
        ['Notre Dame College (Ohio)', 'notre-dame-college-ohio'],
        ['Washington College (Md.)', 'washington-college-md'],
        ['LIU Post', 'liu-post'],
        // An inventory spelling that carries the same disambiguator still matches.
        ['University of Saint Thomas (Minn.)', 'st-thomas']
    ] as const) {
        assert.equal(resolver.resolve(raw)?.slug, slug, raw);
    }
});

test('ambiguous short forms stay unresolved rather than picking a school', () => {
    const resolver = new TeamResolver(loadInventory(realTeams));
    assert.equal(resolver.resolve('Loyola')?.slug, 'loyola', 'Chicago or Maryland: unknowable from the name');
    assert.equal(resolver.resolve('Loyola Maryland')?.slug, 'loyola-university-maryland');
    assert.equal(resolver.resolve('USF')?.slug, 'usf', 'South Florida or San Francisco');
});

test('two inventory entries answering to the same spellings are refused, not merged', () => {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-'));
    fs.writeFileSync(path.join(dir, 'd1_msoc_teams.json'), JSON.stringify([
        { team_id: 'LOYOLA_CHICAGO', name_canonical: 'Loyola Chicago', schedule_url: 'https://a.com', aliases: ['Loyola (Ill.)'] },
        { team_id: 'LOYOLA_MD', name_canonical: 'Loyola Maryland', schedule_url: 'https://b.com', aliases: ['Loyola (Md.)'] }
    ]));
    assert.throws(() => loadInventory(dir), /LOYOLA_CHICAGO and LOYOLA_MD answer to the same spellings/);
});

// ---------------------------------------------------------------------------------------
// UTRGV's spellings, and ambiguous short names placed by their fixture.

import { resolveByFixtureTwin } from '../src/normalize';

test('UTRGV’s spellings resolve to UTRGV; the University of Rio Grande stays a different school', () => {
    const resolver = new TeamResolver(loadInventory(realTeams));
    for (const raw of ['The University of Texas Rio Grande Valley', 'UT Rio Grande Valley', 'Texas Rio Grande Valley', 'UTRGV']) {
        assert.equal(resolver.resolve(raw)?.slug, 'utrgv', raw);
    }
    assert.equal(resolver.resolve('Rio Grande')?.slug, 'rio-grande');
});

const twinRow = (id: string, date: string, home: string, away: string, homeScore = '', awayScore = ''): GameCsvRow => ({
    game_id: id, date, home_team_name: home, away_team_name: away, home_team_ranked: 'false', away_team_ranked: 'false',
    home_score: homeScore, away_score: awayScore, status: homeScore ? 'final' : 'scheduled', location_type: 'home',
    game_type: 'regular', schedule_url: '', boxscore_url: '', boxscore_url_alt: '', dedupe_key: id
} as GameCsvRow);

test('an ambiguous short name takes the one candidate whose own schedule lists the same match', () => {
    const inventory = loadInventory(realTeams);
    const rows = [
        // Syracuse's schedule says "Loyola"; Loyola Maryland's lists Syracuse the same day.
        twinRow('cuse-1', '2026-08-28', 'Syracuse', 'Loyola', '2', '0'),
        twinRow('lmd-1', '2026-08-28', 'Loyola University Maryland', 'Syracuse', '0', '2'),
        // UIC's "Loyola" is Chicago's game.
        twinRow('uic-1', '2026-09-13', 'UIC', 'Loyola', '1', '0'),
        twinRow('luc-1', '2026-09-13', 'UIC', 'Loyola Chicago', '1', '0'),
        // No twin: stays unresolved.
        twinRow('x-1', '2026-09-20', 'Navy', 'Loyola'),
        // Twins for both candidates on the same day (not real, but it must not guess).
        twinRow('y-1', '2026-09-27', 'Drake', 'Loyola'),
        twinRow('y-2', '2026-09-27', 'Drake', 'Loyola Chicago'),
        twinRow('y-3', '2026-09-27', 'Drake', 'Loyola University Maryland'),
        // USF works the same way.
        twinRow('ucf-1', '2026-10-03', 'UCF', 'USF', '1', '1'),
        twinRow('usf-1', '2026-10-03', 'South Florida', 'UCF', '1', '1')
    ];
    const issues = new IssueLog();
    const games = resolveByFixtureTwin(normalizeGames(rows, 2026, new TeamResolver(inventory), issues), inventory, issues);
    const side = (id: string) => { const g = games.find(x => x.sourceGameId === id)!; return [g.homeSlug, g.awaySlug]; };
    assert.deepEqual(side('cuse-1'), ['syracuse', 'loyola-university-maryland']);
    assert.deepEqual(side('uic-1'), ['uic', 'loyola-chicago']);
    assert.deepEqual(side('x-1'), ['navy', 'loyola'], 'no twin: left unresolved');
    assert.deepEqual(side('y-1'), ['drake', 'loyola'], 'two candidates: left unresolved');
    assert.deepEqual(side('ucf-1'), ['ucf', 'south-florida']);
    const codes = Object.fromEntries(issues.list().map(i => [i.code, i.count]));
    assert.equal(codes.team_from_fixture_twin, 3);
    assert.equal(codes.ambiguous_team_unresolved, 2);
});

test('box-score rows labelled with the short name follow the placed fixture side', () => {
    const inventory = loadInventory(realTeams);
    const games = [twinRow('cuse-1', '2026-08-28', 'Syracuse', 'Loyola', '2', '0'), twinRow('lmd-1', '2026-08-28', 'Loyola University Maryland', 'Syracuse', '0', '2')];
    const stats = [
        { game_id: 'cuse-1', team_id: 'Loyola', player_name: 'Ann Ace', player_key: '', jersey_number: '9', minutes: '90', goals: '0', assists: '0', shots: '1', shots_on_goal: '0', saves: '', position: 'F', started: '1', goals_allowed: '', capture_version: '2' },
        { game_id: 'cuse-1', team_id: 'Syracuse', player_name: 'Sy Cuse', player_key: '', jersey_number: '10', minutes: '90', goals: '2', assists: '0', shots: '3', shots_on_goal: '2', saves: '', position: 'F', started: '1', goals_allowed: '', capture_version: '2' }
    ] as PlayerStatCsvRow[];
    const { batch } = buildSeasonBatch(2026, games, stats, inventory, true);
    assert.equal(batch.stats.find(s => s.playerName === 'Ann Ace')?.teamSlug, 'loyola-university-maryland');
    assert.ok(!batch.teams.some(t => t.slug === 'loyola'), 'no team left behind under the short name');
});
