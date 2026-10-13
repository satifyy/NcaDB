import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMonths } from '../src/config';
import { localTime, nightlyGate, seasonFor } from '../src/schedule';

const gate = (iso: string, lastSuccess: string | null = null, force = false) =>
    nightlyGate({
        now: new Date(iso),
        timezone: 'America/Chicago',
        hour: 3,
        lastSuccessAt: lastSuccess ? new Date(lastSuccess) : null,
        recoveryAfterHours: 26,
        force
    });

test('summer (CDT): the 08:00 UTC firing runs, the 09:00 UTC one does not', () => {
    const yesterday = '2026-07-14T08:05:00Z';
    assert.equal(gate('2026-07-15T08:00:00Z', yesterday).run, true);
    assert.equal(gate('2026-07-15T09:00:00Z', '2026-07-15T08:20:00Z').run, false);
});

test('winter (CST): the 09:00 UTC firing runs, the 08:00 UTC one does not', () => {
    assert.equal(gate('2026-01-15T08:00:00Z', '2026-01-14T09:05:00Z').run, false);
    assert.equal(gate('2026-01-15T09:00:00Z', '2026-01-14T09:05:00Z').run, true);
});

test('both DST transition days still get exactly one 3 AM run', () => {
    // Spring forward: 2026-03-08. 3 AM CDT = 08:00 UTC.
    assert.equal(localTime('America/Chicago', new Date('2026-03-08T08:00:00Z')).hour, 3);
    assert.equal(localTime('America/Chicago', new Date('2026-03-08T09:00:00Z')).hour, 4);
    // Fall back: 2026-11-01. 3 AM CST = 09:00 UTC.
    assert.equal(localTime('America/Chicago', new Date('2026-11-01T08:00:00Z')).hour, 2);
    assert.equal(localTime('America/Chicago', new Date('2026-11-01T09:00:00Z')).hour, 3);
});

test('a missed night is recovered at the next firing', () => {
    const decision = gate('2026-10-14T09:00:00Z', '2026-10-12T08:10:00Z'); // 4 AM CDT, 49h overdue
    assert.equal(decision.run, true);
    assert.match(decision.reason, /recovery/);
});

test('force always runs; no history always runs', () => {
    assert.equal(gate('2026-10-14T15:00:00Z', '2026-10-14T08:10:00Z', true).run, true);
    assert.equal(gate('2026-10-14T15:00:00Z', null).run, true);
});

test('seasons are calendar years played August to December', () => {
    assert.equal(seasonFor({ year: 2026, month: 10, day: 13, hour: 3 }), 2026);
    assert.equal(seasonFor({ year: 2027, month: 2, day: 1, hour: 3 }), 2026);
});

test('active months parse from ranges and lists', () => {
    assert.deepEqual(parseMonths('8-12'), [8, 9, 10, 11, 12]);
    assert.deepEqual(parseMonths('1,8-9'), [1, 8, 9]);
    assert.throws(() => parseMonths('13'));
});
