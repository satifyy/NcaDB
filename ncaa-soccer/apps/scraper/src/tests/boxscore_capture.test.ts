/**
 * What a box score says about positions, starters and goalkeeping, on every reader.
 *
 * The golden fixtures cover the Nuxt, captioned and WMT readers with real pages. The
 * advanced-table and positional (legacy) readers have no live school left to capture, so
 * they are exercised here with the smallest markup each recognises, built to the column
 * layouts their comments document. What matters on all of them is the same: the
 * published position survives, the Starters/Substitutes split becomes a flag, a keeper's
 * goals allowed and saves are read off the goalkeeping table, and nobody else is given a
 * 0 they never recorded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SidearmBoxScoreParser, WmtBoxScoreParser } from '@ncaa/parsers';
import { PlayerStat, positionGroup } from '@ncaa/shared';

const parse = (html: string) => new SidearmBoxScoreParser().parse(html, { sourceUrl: 'https://x.edu/boxscore/77' }).playerStats;
const byName = (rows: PlayerStat[], name: string) => {
    const row = rows.find(r => r.player_name === name);
    assert.ok(row, `${name} should be parsed`);
    return row;
};

const fieldRow = (pos: string, no: string, name: string, min: string, g = '0') =>
    `<tr><td>${pos}</td><td>${no}</td><td>${name}</td><td>1</td><td>0</td><td>${g}</td><td>0</td><td>${min}</td></tr>`;

test('advanced tables: one row per keeper, with the goalkeeping table folded in', () => {
    const html = `<html><body>
      <table class="advanced-table__table"><thead><tr><th>Elon - Players</th></tr></thead><tbody>
        <tr><td>Starters</td></tr>
        ${fieldRow('GK', '1', 'Keeper, Kate', '90')}
        ${fieldRow('DF', '4', 'Back, Ben', '90', '1')}
        <tr><td>Substitutes</td></tr>
        ${fieldRow('FW', '9', 'Sub, Sam', '20')}
      </tbody></table>
      <table class="advanced-table__table"><thead><tr><th>Elon - Goalkeeping</th></tr></thead><tbody>
        <tr><td>GK</td><td>1</td><td>Keeper, Kate</td><td>90:00</td><td>1</td><td>4</td></tr>
      </tbody></table>
    </body></html>`;
    const rows = parse(html);
    assert.equal(rows.length, 3, 'the keeper is one row, not one per table');
    const keeper = byName(rows, 'Keeper, Kate');
    assert.deepEqual([keeper.stats.position, keeper.stats.started, keeper.stats.goals_allowed, keeper.stats.saves], ['GK', 1, 1, 4]);
    assert.equal(keeper.minutes, 90);
    const back = byName(rows, 'Back, Ben');
    assert.deepEqual([back.stats.position, back.stats.started, back.goals, back.stats.saves, back.stats.goals_allowed], ['DF', 1, 1, null, null]);
    assert.deepEqual([byName(rows, 'Sub, Sam').stats.started], [0]);
});

test('positional tables: position, starters and a separate goalkeeping table', () => {
    const html = `<html><body>
      <table class="sidearm-table overall-stats"><caption>Furman - Box</caption><tbody>
        <tr><td colspan="8">Starters</td></tr>
        ${fieldRow('gk', '0', 'Glove, Gus', '90')}
        ${fieldRow('mf', '8', 'Mid, Max', '75')}
        <tr><td colspan="8">Substitutes</td></tr>
        ${fieldRow('fw', '11', 'Late, Leo', '15', '1')}
      </tbody></table>
      <table class="sidearm-table overall-stats"><caption>Furman - Goalkeeping</caption>
        <thead><tr><th>#</th><th>Player</th><th>MIN</th><th>GA</th><th>Saves</th></tr></thead>
        <tbody><tr><td>0</td><td>Glove, Gus</td><td>90</td><td>2</td><td>0</td></tr></tbody>
      </table>
    </body></html>`;
    const rows = parse(html);
    assert.equal(rows.length, 3);
    const keeper = byName(rows, 'Glove, Gus');
    // Zero saves is a real zero here: the goalkeeping table printed it.
    assert.deepEqual([keeper.stats.position, keeper.stats.started, keeper.stats.goals_allowed, keeper.stats.saves], ['gk', 1, 2, 0]);
    assert.deepEqual([byName(rows, 'Late, Leo').stats.started, byName(rows, 'Late, Leo').stats.saves], [0, null]);
});

test('without a goalkeeping table, nobody has saves — not even the keeper', () => {
    const html = `<html><body>
      <table class="sidearm-table overall-stats"><caption>Furman - Box</caption><tbody>
        ${fieldRow('gk', '0', 'Glove, Gus', '90')}
        ${fieldRow('mf', '8', 'Mid, Max', '90')}
      </tbody></table></body></html>`;
    const rows = parse(html);
    for (const row of rows) {
        assert.equal(row.stats.saves, null, `${row.player_name}: unreported saves are blank`);
        assert.equal(row.stats.goals_allowed, null);
        // No Starters/Substitutes labels: the table says nothing about who started.
        assert.equal(row.stats.started, null);
    }
    assert.equal(byName(rows, 'Glove, Gus').stats.position, 'gk');
});

test('a keeper missing from the player table becomes a row of their own', () => {
    const html = `<html><body>
      <table class="sidearm-table overall-stats"><caption>Elon - Player Stats</caption>
        <thead><tr><th>Pos</th><th>#</th><th>Player</th><th>SH</th><th>SOG</th><th>G</th><th>A</th><th>MIN</th></tr></thead>
        <tbody>${fieldRow('DEF', '4', 'Back, Ben', '90')}</tbody></table>
      <table class="sidearm-table overall-stats"><caption>Elon Phoenix - Goalie Statistics</caption>
        <thead><tr><th>Position</th><th>#</th><th>Goalie</th><th>Minutes</th><th>GA</th><th>Saves</th></tr></thead>
        <tbody><tr><td>GK</td><td>30</td><td>Late, Larry</td><td>45:00</td><td>1</td><td></td></tr></tbody></table>
    </body></html>`;
    const rows = parse(html);
    const keeper = byName(rows, 'Late, Larry');
    assert.equal(keeper.team_id, 'Elon', 'filed under the squad whose player table it follows');
    assert.equal(keeper.minutes, 45);
    // An empty Saves cell is unreported; goals allowed was printed.
    assert.deepEqual([keeper.stats.position, keeper.stats.goals_allowed, keeper.stats.saves], ['GK', 1, null]);
});

test('WMT: keeper counters only for a player who kept goal; started is blank when the feed is silent', () => {
    const payload = {
        data: {
            id: 5,
            competitors: [{ teamId: 1, nameTabular: 'Clemson', homeTeam: true }, { teamId: 2, nameTabular: 'Duke', homeTeam: false }],
            players: { data: [
                { team_id: 1, xml_short_name: 'Glove,Gus', xml_position: 'GK', games_started: 1,
                  statistic: [{ period: 0, statistic: { sGoalkeeperMinutesPlayed: 5400 } }] },
                { team_id: 1, xml_short_name: 'Field,Fay', xml_position: 'D', games_started: null,
                  statistic: [{ period: 0, statistic: { sMinutes: 5400 } }] }
            ] }
        }
    };
    const rows = new WmtBoxScoreParser().parseStats(payload).playerStats;
    assert.deepEqual([rows[0].stats.saves, rows[0].stats.goals_allowed, rows[0].stats.started], [0, 0, 1]);
    assert.deepEqual([rows[1].stats.saves, rows[1].stats.goals_allowed, rows[1].stats.started], [null, null, null]);
});

test('positions map onto four groups; a combined or unknown label maps onto none', () => {
    const cases: [string | null, string | null][] = [
        ['gk', 'GK'], ['GK', 'GK'], ['G', 'GK'], ['Goalkeeper', 'GK'],
        ['def', 'DEF'], ['D', 'DEF'], ['DF', 'DEF'], ['CB', 'DEF'],
        ['mid', 'MID'], ['M', 'MID'], ['MF', 'MID'],
        ['fwd', 'FWD'], ['fw', 'FWD'], ['F', 'FWD'], ['FWD', 'FWD'],
        ['D/M', null], ['MF/FW', null], ['', null], [null, null], ['coach', null]
    ];
    for (const [raw, group] of cases) assert.equal(positionGroup(raw), group, String(raw));
});
