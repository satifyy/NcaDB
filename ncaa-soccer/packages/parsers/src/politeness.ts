/**
 * How the scrapers behave towards the sites they read, in one place.
 *
 * Every knob is an environment variable so a scheduled server run can be gentler than a
 * laptop backfill without a code change. Defaults keep the scrapers' existing behaviour,
 * except for two things a server run must do: identify itself, and honour the
 * `Crawl-delay: 30` that Sidearm sites publish in robots.txt for every user agent.
 */

const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

/**
 * The User-Agent every request sends.
 *
 * A browser string, because several schools serve a different page to anything that
 * does not look like one, followed by a product token and a contact URL so a site
 * operator can tell who we are and how to reach us.
 */
export const SCRAPER_USER_AGENT: string =
    process.env.SCRAPER_USER_AGENT || `${BROWSER_UA} NcaDB/1.0 (+https://github.com/satifyy/NcaDB)`;

export function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function hostOf(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

/**
 * JSON endpoints that publish no crawl delay and are built to be polled: WMT's stats
 * feed and its sites' own `/website-api`. They get the ordinary request delay rather
 * than the page crawl delay.
 */
const API_URL = /(^|\.)api\.wmt\.games$|\/website-api\//;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Spaces out requests to the same host.
 *
 * Slots are reserved synchronously, so any number of concurrent callers for one host
 * queue behind each other rather than all seeing the host as idle at once.
 */
export class HostThrottle {
    private nextSlot = new Map<string, number>();

    constructor(
        private readonly pageDelayMs: number = envNumber('SCRAPER_HOST_DELAY_MS', 30_000),
        private readonly apiDelayMs: number = envNumber('SCRAPER_REQUEST_DELAY_MS', 1_500)
    ) {}

    delayFor(url: string): number {
        const host = hostOf(url);
        return API_URL.test(host) || API_URL.test(url) ? this.apiDelayMs : this.pageDelayMs;
    }

    async wait(url: string): Promise<void> {
        const host = hostOf(url);
        const delay = this.delayFor(url);
        if (!host || delay <= 0) return;
        const now = Date.now();
        const at = Math.max(now, this.nextSlot.get(host) ?? 0);
        this.nextSlot.set(host, at + delay);
        if (at > now) await sleep(at - now);
    }
}

/**
 * Reorders work so consecutive items hit different hosts.
 *
 * A season's box scores sorted by date put a school's home games side by side; fetched
 * in parallel chunks that is several requests to one site at once. Round-robin by host
 * spreads them out so the throttle above rarely has to wait.
 */
export function interleaveByHost<T>(items: T[], urlOf: (item: T) => string): T[] {
    const byHost = new Map<string, T[]>();
    for (const item of items) {
        const host = hostOf(urlOf(item));
        byHost.set(host, [...(byHost.get(host) ?? []), item]);
    }
    const queues = [...byHost.values()];
    const out: T[] = [];
    for (let round = 0; out.length < items.length; round++) {
        for (const queue of queues) if (round < queue.length) out.push(queue[round]);
    }
    return out;
}
