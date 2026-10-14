/**
 * SSRF and untrusted-content defences in the scrapers. No network: DNS is exercised only
 * through names that cannot resolve, and fetches go to an injected fake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BlockedUrlError,
    checkSourceUrl,
    isInternalRequest,
    isPrivateAddress,
    parseJsLiteral,
    safeFetch,
    sourceAllowlist,
    vetSourceUrl
} from '@ncaa/parsers';

const allow = sourceAllowlist(['https://goduke.com/sports/mens-soccer/schedule', 'https://virginiasports.com/x']);

test('private, loopback, link-local, metadata and Railway-internal addresses are private', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0',
        '::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '[::1]', 'not-an-ip']) {
        assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '104.16.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('box-score links must be http(s) on a school or known stats domain', () => {
    assert.equal(checkSourceUrl('https://goduke.com/boxscore.aspx?id=1', allow).ok, true);
    assert.equal(checkSourceUrl('https://static.virginiasports.com/a.pdf', allow).ok, true, 'subdomain of a school');
    assert.equal(checkSourceUrl('https://api.wmt.games/api/statistics/games/1', allow).ok, true, 'shared stats host');
    const refused: [string, RegExp][] = [
        ['http://postgres.railway.internal:5432/', /port|internal/],
        ['http://169.254.169.254/latest/meta-data/', /IP literal/],
        ['http://[::1]/', /IP literal/],
        ['http://localhost/', /internal/],
        ['http://api.railway.internal/', /internal/],
        ['file:///etc/passwd', /scheme/],
        ['javascript:alert(1)', /scheme/],
        ['https://user:pass@goduke.com/', /credentials/],
        ['https://goduke.com:8443/', /port/],
        ['https://evil.example.com/boxscore', /allowlist/],
        ['not a url', /not a URL/]
    ];
    for (const [url, reason] of refused) {
        const verdict = checkSourceUrl(url, allow);
        assert.equal(verdict.ok, false, url);
        assert.match((verdict as { reason: string }).reason, reason, url);
    }
});

test('a name that does not resolve to a public address is refused', async () => {
    const verdict = await vetSourceUrl('https://does-not-exist.invalid/x');
    assert.equal(verdict.ok, false);
});

const fakeFetch = (responses: Record<string, { status: number; headers?: Record<string, string>; body?: string }>) =>
    (async (url: string) => {
        const r = responses[url];
        if (!r) throw new Error(`unexpected request to ${url}`);
        return new Response(r.body ?? '', { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;

test('a redirect into the private network is refused, hop by hop', async () => {
    const fetchImpl = fakeFetch({
        'https://goduke.com/boxscore/1': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }
    });
    await assert.rejects(safeFetch('https://goduke.com/boxscore/1', { fetchImpl, skipDnsCheck: true }), BlockedUrlError);
});

test('a redirect to an allowed host is followed', async () => {
    const fetchImpl = fakeFetch({
        'https://goduke.com/a': { status: 301, headers: { location: '/b' } },
        'https://goduke.com/b': { status: 200, body: 'ok' }
    });
    const res = await safeFetch('https://goduke.com/a', { fetchImpl, skipDnsCheck: true });
    assert.equal(res.text, 'ok');
    assert.equal(res.url, 'https://goduke.com/b');
});

test('oversized responses are refused, declared or streamed', async () => {
    const big = 'x'.repeat(2048);
    await assert.rejects(
        safeFetch('https://goduke.com/big', { fetchImpl: fakeFetch({ 'https://goduke.com/big': { status: 200, body: big } }), skipDnsCheck: true, maxBytes: 1024 }),
        /exceeded|bytes/
    );
    await assert.rejects(
        safeFetch('https://goduke.com/big', {
            fetchImpl: fakeFetch({ 'https://goduke.com/big': { status: 200, body: 'x', headers: { 'content-length': '999999999' } } }),
            skipDnsCheck: true,
            maxBytes: 1024
        }),
        /limit/
    );
});

test('page sub-requests to internal hosts are aborted, public ones are not', () => {
    assert.equal(isInternalRequest('http://postgres.railway.internal:5432/'), true);
    assert.equal(isInternalRequest('http://10.0.0.5/x'), true);
    assert.equal(isInternalRequest('http://localhost:3001/'), true);
    assert.equal(isInternalRequest('https://cdn.sidearmsports.com/app.js'), false);
    assert.equal(isInternalRequest('data:image/png;base64,AAAA'), false);
});

test('embedded page payloads are parsed as data, never executed', () => {
    let executed = false;
    (globalThis as Record<string, unknown>).__ncadbPwned = () => { executed = true; };
    assert.equal(parseJsLiteral('[(globalThis.__ncadbPwned(), 1)]'), null);
    assert.equal(parseJsLiteral('[1]; globalThis.__ncadbPwned()'), null);
    assert.equal(executed, false);
    assert.deepEqual(parseJsLiteral('[["ShallowReactive",1],{"a":undefined,"b":"NaN stays text","c":NaN}]'), [
        ['ShallowReactive', 1],
        { a: null, b: 'NaN stays text', c: null }
    ]);
});
