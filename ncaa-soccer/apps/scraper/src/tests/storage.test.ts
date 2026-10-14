/**
 * The reader, the writer and the four coercions.
 *
 * These cover the failures that would be silent. A CSV layer does not throw when it is
 * wrong: it returns `undefined` for a column that moved, `0` for a score that was never
 * played, or a row array that quietly disagrees with the one the streaming reader
 * produced — and every one of those reaches a rating table looking like data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    dec,
    flag,
    headerFrom,
    int,
    readAll,
    readAllIfExists,
    score,
    streamRows,
    writeRows
} from '@ncaa/storage';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ncaa-storage-'));

test('int is zero for the cells a box score leaves empty, and never NaN', () => {
    assert.equal(int('12'), 12);
    assert.equal(int('0'), 0);
    assert.equal(int(''), 0);
    assert.equal(int(undefined), 0);
    // A column that was renamed reaches here as undefined. It must not become NaN, which
    // propagates through every sum it touches and lands in the file as an empty cell.
    assert.equal(int('not a number'), 0);
    assert.ok(!Number.isNaN(int('not a number')));
});

test('dec keeps the fractional part int() would truncate', () => {
    // impact and impact_per90 are written with toFixed. Reading them with parseInt would
    // flatten the leaderboard to whole goal-equivalents without failing.
    assert.equal(dec('3.073'), 3.073);
    assert.equal(dec('0.9547'), 0.9547);
    assert.notEqual(dec('3.073'), int('3.073'));
});

test('score distinguishes an unplayed fixture from a goalless one', () => {
    // The distinction the Elo depends on: coercing an empty score to 0 turns every
    // scheduled game into a 0-0 draw, which is a result a rating system will happily eat.
    assert.equal(score(''), null);
    assert.equal(score(undefined), null);
    assert.equal(score('0'), 0);
    assert.notEqual(score(''), score('0'));
});

test('flag reads the words the writer emits, not csv-stringify defaults', () => {
    assert.equal(flag('true'), true);
    assert.equal(flag('false'), false);
    // `1` and `` are what csv-stringify produces for booleans, and are why the writer
    // stringifies them itself. Neither should read back as true.
    assert.equal(flag('1'), false);
    assert.equal(flag(''), false);
});

test('streamRows yields exactly what readAll returns', async () => {
    const dir = tmp();
    const file = path.join(dir, 'rows.csv');
    // A quoted comma, because school names contain them: "University of Maryland,
    // Baltimore County" once shifted every field after it by one.
    fs.writeFileSync(
        file,
        'game_id,home_team_name,home_score\n' +
            '1,"University of Maryland, Baltimore County",3\n' +
            '2,Clemson,\n' +
            '\n' +
            '3,"Say ""hello""",1\n'
    );

    const whole = readAll(file);
    const streamed = [];
    for await (const row of streamRows(file)) streamed.push(row);

    assert.deepEqual(streamed, whole);
    assert.equal(whole.length, 3, 'the blank line is skipped by both');
    assert.equal(whole[0].home_team_name, 'University of Maryland, Baltimore County');
    assert.equal(whole[2].home_team_name, 'Say "hello"');
    assert.equal(score(whole[1].home_score), null);
});

test('a read-then-write round trip keeps columns this codebase does not know about', () => {
    const dir = tmp();
    const file = path.join(dir, 'games.csv');
    const original = 'game_id,date,scouting_note,dedupe_key\n' + 'g1,2025-09-01,"windy, cold",k1\n';
    fs.writeFileSync(file, original);

    const rows = readAll(file);
    writeRows(file, rows, headerFrom(rows));

    assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('headerFrom appends a new column rather than inserting it', () => {
    // A reader that indexes by position has to find every existing column where it was.
    const rows = [{ game_id: 'g1', date: '2025-09-01' }];
    assert.deepEqual(headerFrom(rows, ['game_type']), ['game_id', 'date', 'game_type']);
    // Already present: not duplicated, not moved.
    const withType = [{ game_id: 'g1', game_type: 'regular', date: '2025-09-01' }];
    assert.deepEqual(headerFrom(withType, ['game_type']), ['game_id', 'game_type', 'date']);
});

test('a missing season reads as no rows rather than throwing', () => {
    assert.deepEqual(readAllIfExists(path.join(tmp(), 'nothing.csv')), []);
});

test('writeRows creates the directory a season needs', () => {
    const file = path.join(tmp(), '2027', 'games.csv');
    writeRows(file, [{ game_id: 'g1' }]);
    assert.equal(readAll(file).length, 1);
});
