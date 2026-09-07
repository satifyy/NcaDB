/**
 * Counting how many fixtures a school publishes for a given season, per platform.
 *
 * Used two ways: discovery counts events to confirm a schedule URL is real before
 * writing it into an inventory, and the season preflight counts them to confirm a school
 * still serves a season before a five-season backfill is started against it. Both need
 * the same per-platform reading of a page, so it lives here rather than in either.
 */

import { WmtClient, seasonNameCandidates, sportSlugFromScheduleUrl } from '@ncaa/parsers';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

export interface Fetched {
    ok: boolean;
    status: number;
    body: string;
}

export async function fetchPage(url: string, timeoutMs = 20000): Promise<Fetched> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
            redirect: 'follow'
        });
        return { ok: response.ok, status: response.status, body: await response.text() };
    } catch {
        return { ok: false, status: 0, body: '' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A class name ends here, rather than continuing into a modifier.
 *
 * `\b` is not enough: a hyphen is a word boundary, so `schedule-item\b` also matches
 * `schedule-item-date` and every other child element in the row. Counting those turned
 * American's 25-game season into 108 and made a healthy season look like an anomaly.
 */
const CLASS_END = '(?![\\w-])';

/**
 * Rows in WMT's WordPress product, in either theme schools use for it.
 *
 * Kentucky renders `.schedule-item`, South Carolina `.schedule-table_row`.
 */
const WORDPRESS_ROW_RE = new RegExp(
    `class="[^"]*\\bschedule-item${CLASS_END}[^"]*"|class="[^"]*\\bschedule-table_row${CLASS_END}[^"]*"`,
    'g'
);

export function countWordpressRows(html: string): number {
    return (html.match(WORDPRESS_ROW_RE) || []).length;
}

/** Rendered Sidearm game cards — not their child elements, nor stylesheet class names. */
const SIDEARM_CARD_RE = new RegExp(
    `data-test-id="s-game-card-standard__root"|<li[^>]+class="[^"]*sidearm-schedule-game${CLASS_END}`,
    'g'
);

export function countSidearmCards(html: string): number {
    return (html.match(SIDEARM_CARD_RE) || []).length;
}

/**
 * Events WMT's season API returns, or null if the season is not published.
 *
 * Season naming is a per-site choice — `2025-26` at Clemson, `2025` at Stanford — so both
 * spellings are tried, which is what `seasonNameCandidates` enumerates.
 */
export async function countWmtEvents(scheduleUrl: string, season: number): Promise<number | null> {
    const sportSlug = sportSlugFromScheduleUrl(scheduleUrl);
    if (!sportSlug) return null;
    try {
        const events = await new WmtClient(scheduleUrl).fetchSeasonEvents(
            sportSlug,
            seasonNameCandidates(season)
        );
        return events.length;
    } catch {
        return null;
    }
}

/**
 * How many fixtures a school publishes for a season, by whichever route its platform uses.
 *
 * Sidearm and WMT's WordPress product both render the season server-side at
 * `/schedule/<year>`; the Nuxt product has no usable DOM and is read through its API.
 */
export async function countSeasonEvents(
    scheduleUrl: string,
    platform: string | undefined,
    season: number
): Promise<number> {
    if (platform === 'wmt') return (await countWmtEvents(scheduleUrl, season)) ?? 0;

    const page = await fetchPage(`${scheduleUrl.replace(/\/$/, '')}/${season}`);
    if (!page.ok || !page.body) return 0;
    return platform === 'wmt_wp' ? countWordpressRows(page.body) : countSidearmCards(page.body);
}
