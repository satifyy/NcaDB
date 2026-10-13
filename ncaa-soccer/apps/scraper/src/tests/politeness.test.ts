import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostThrottle, SCRAPER_USER_AGENT, interleaveByHost } from '@ncaa/parsers';

test('requests identify the project', () => {
    assert.match(SCRAPER_USER_AGENT, /NcaDB\/1\.0 \(\+https:\/\/github\.com\/satifyy\/NcaDB\)/);
});

test('concurrent requests to one host are spaced by the crawl delay', async () => {
    const throttle = new HostThrottle(60, 0);
    const started = Date.now();
    const times: number[] = [];
    await Promise.all(
        [1, 2, 3].map(async () => {
            await throttle.wait('https://goduke.com/boxscore/1');
            times.push(Date.now() - started);
        })
    );
    times.sort((a, b) => a - b);
    assert.ok(times[1] >= 55 && times[2] >= 115, `expected ~0/60/120ms, got ${times.join('/')}`);
});

test('different hosts do not wait on each other, and APIs use the shorter delay', async () => {
    const throttle = new HostThrottle(10_000, 0);
    const started = Date.now();
    await throttle.wait('https://goduke.com/a');
    await throttle.wait('https://clemsontigers.com/a');
    await throttle.wait('https://api.wmt.games/api/statistics/games/1');
    await throttle.wait('https://api.wmt.games/api/statistics/games/2');
    assert.ok(Date.now() - started < 1000);
    assert.equal(throttle.delayFor('https://clemsontigers.com/website-api/schedule-events'), 0);
    assert.equal(throttle.delayFor('https://goduke.com/sports/mens-soccer/schedule'), 10_000);
});

test('work is reordered so neighbours hit different hosts', () => {
    const urls = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://b.com/1', 'https://c.com/1'];
    const ordered = interleaveByHost(urls, u => u);
    assert.deepEqual(ordered, ['https://a.com/1', 'https://b.com/1', 'https://c.com/1', 'https://a.com/2', 'https://a.com/3']);
});
