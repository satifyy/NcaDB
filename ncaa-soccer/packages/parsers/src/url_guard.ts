/**
 * What the scrapers are allowed to request.
 *
 * Box-score links come out of third-party pages, and the worker that follows them runs
 * inside Railway's private network next to Postgres and the API. A page that links to
 * `http://postgres.railway.internal:5432`, `http://169.254.169.254/` or a hostname that
 * resolves to a private address must not turn the scraper into a proxy into that
 * network (SSRF). Every scraper request goes through these checks:
 *
 *  - http(s) only, default ports, no credentials in the URL;
 *  - never an IP literal, `localhost`, or a `.internal` / `.local` / `.localhost` name;
 *  - for links taken from scraped pages, a host on the allowlist (the schools'
 *    own domains plus a few known stats hosts);
 *  - every address the name resolves to is public (defeats DNS rebinding);
 *  - redirects re-checked hop by hop; response bodies capped.
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { SCRAPER_USER_AGENT } from './politeness';

/** Hosts that serve stats for many schools rather than belonging to one. */
export const SHARED_SOURCE_DOMAINS = [
    'wmt.games',
    'sidearmsports.com',
    'sidearmstats.com',
    'statbroadcast.com',
    'storage.googleapis.com'
];

const INTERNAL_NAME = /(^|\.)(localhost|internal|local|localdomain|home\.arpa)$/i;

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

function privateV4(ip: string): boolean {
    const [a, b] = ip.split('.').map(Number);
    return (
        a === 0 || a === 10 || a === 127 ||
        (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
        (a === 169 && b === 254) || // link-local, cloud metadata
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224 // multicast and reserved
    );
}

/** Whether an IP address is anything other than a public unicast address. */
export function isPrivateAddress(ip: string): boolean {
    const bare = ip.replace(/^\[|\]$/g, '').toLowerCase();
    if (isIP(bare) === 4) return privateV4(bare);
    if (isIP(bare) !== 6) return true; // unparseable: refuse
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
    if (mapped) return privateV4(mapped[1]);
    return (
        bare === '::' || bare === '::1' ||
        /^f[cd]/.test(bare) || // unique local (Railway's private network is fd12::/16)
        /^fe[89ab]/.test(bare) || // link-local
        /^ff/.test(bare) // multicast
    );
}

/** The registrable part of a host, roughly: `static.virginiasports.com` -> `virginiasports.com`. */
export function baseDomain(host: string): string {
    return host.toLowerCase().replace(/^www\./, '').split('.').slice(-2).join('.');
}

/** Builds an allowlist from the schools' own schedule URLs plus the shared stats hosts. */
export function sourceAllowlist(urls: (string | undefined | null)[]): Set<string> {
    const allowed = new Set(SHARED_SOURCE_DOMAINS);
    for (const url of urls) {
        try {
            if (url) allowed.add(baseDomain(new URL(url).hostname));
        } catch {
            /* not a URL */
        }
    }
    return allowed;
}

/**
 * Synchronous policy check. With `allowlist`, the host must be on it (exact base domain
 * or a subdomain of one); without, any public-looking name is accepted.
 */
export function checkSourceUrl(raw: string, allowlist?: Set<string>): UrlVerdict {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, reason: 'not a URL' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: `scheme ${url.protocol}` };
    if (url.username || url.password) return { ok: false, reason: 'credentials in URL' };
    if (url.port && url.port !== '443' && url.port !== '80') return { ok: false, reason: `port ${url.port}` };
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (isIP(host.replace(/^\[|\]$/g, ''))) return { ok: false, reason: 'IP literal host' };
    if (!host.includes('.') || INTERNAL_NAME.test(host)) return { ok: false, reason: 'internal host name' };
    if (allowlist && !allowlist.has(baseDomain(host)) && !allowlist.has(host)) {
        return { ok: false, reason: `host ${host} not on the source allowlist` };
    }
    return { ok: true, url };
}

const resolved = new Map<string, Promise<boolean>>();

/** Whether every address `host` resolves to is public. Cached per process. */
export function resolvesPublic(host: string): Promise<boolean> {
    let pending = resolved.get(host);
    if (!pending) {
        pending = lookup(host, { all: true, verbatim: true })
            .then(addresses => addresses.length > 0 && addresses.every(a => !isPrivateAddress(a.address)))
            .catch(() => false);
        resolved.set(host, pending);
    }
    return pending;
}

/** Policy check plus DNS check. */
export async function vetSourceUrl(raw: string, allowlist?: Set<string>): Promise<UrlVerdict> {
    const verdict = checkSourceUrl(raw, allowlist);
    if (!verdict.ok) return verdict;
    if (!(await resolvesPublic(verdict.url.hostname))) {
        return { ok: false, reason: `host ${verdict.url.hostname} resolves to a non-public address` };
    }
    return verdict;
}

export class BlockedUrlError extends Error {}

/** 15 MB: several times the largest schedule page or stats feed seen. */
export const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

/**
 * `fetch` for scraper requests: vets the URL and every redirect hop, sends the project
 * User-Agent, and refuses bodies larger than `maxBytes` (counted after decompression,
 * which is what defeats a decompression bomb).
 */
export async function safeFetch(
    raw: string,
    init: RequestInit & {
        allowlist?: Set<string>;
        maxBytes?: number;
        fetchImpl?: typeof fetch;
        /** Tests that inject `fetchImpl` against fixtures skip the DNS check. */
        skipDnsCheck?: boolean;
    } = {}
): Promise<{ status: number; ok: boolean; url: string; headers: Headers; text: string }> {
    const { allowlist, maxBytes = DEFAULT_MAX_BYTES, fetchImpl = fetch, skipDnsCheck = false, ...rest } = init;
    let current = raw;
    for (let hop = 0; hop <= 3; hop++) {
        const verdict = skipDnsCheck ? checkSourceUrl(current, allowlist) : await vetSourceUrl(current, allowlist);
        if (!verdict.ok) throw new BlockedUrlError(`Blocked ${current}: ${verdict.reason}`);
        const response = await fetchImpl(current, {
            ...rest,
            redirect: 'manual',
            headers: { 'User-Agent': SCRAPER_USER_AGENT, ...(rest.headers as Record<string, string>) }
        });
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            current = new URL(response.headers.get('location')!, current).toString();
            continue;
        }
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > maxBytes) throw new BlockedUrlError(`Response from ${current} is ${declared} bytes (limit ${maxBytes})`);
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel();
                    throw new BlockedUrlError(`Response from ${current} exceeded ${maxBytes} bytes`);
                }
                chunks.push(value);
            }
        }
        return {
            status: response.status,
            ok: response.ok,
            url: current,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8')
        };
    }
    throw new BlockedUrlError(`Too many redirects from ${raw}`);
}

/**
 * Chromium flags that make internal names unresolvable from inside the browser, so a
 * page's own sub-requests (images, scripts, iframes) cannot reach the private network
 * either. Complements the per-request check in each page's route handler.
 */
export const CHROMIUM_NETWORK_GUARD_ARGS = [
    '--host-resolver-rules=MAP *.railway.internal ~NOTFOUND, MAP *.internal ~NOTFOUND, MAP *.local ~NOTFOUND, MAP localhost ~NOTFOUND, MAP *.localhost ~NOTFOUND'
];

/** For a page route handler: whether a sub-request must be aborted. */
export function isInternalRequest(raw: string): boolean {
    try {
        const url = new URL(raw);
        if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return false;
        const host = url.hostname.toLowerCase();
        if (isIP(host.replace(/^\[|\]$/g, ''))) return isPrivateAddress(host);
        return !host.includes('.') || INTERNAL_NAME.test(host);
    } catch {
        return true;
    }
}
