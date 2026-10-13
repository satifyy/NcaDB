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
    return { teams, index };
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
