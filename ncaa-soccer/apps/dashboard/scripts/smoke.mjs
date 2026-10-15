/**
 * Browser smoke test: the site must never deploy as a blank page.
 *
 *   node scripts/smoke.mjs                 build in dist/ served under /ncadb/ with the
 *                                          production CSP, against a fixture API
 *   node scripts/smoke.mjs --url <site>    a deployed site (e.g. https://satifyy.com/ncadb/)
 *
 * Exits non-zero on the first failed check. Local mode needs `vite build` with
 * BASE_PATH=/ncadb and VITE_API_BASE_URL=http://127.0.0.1:4791 first (the CI step does it).
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../scraper/package.json'));
const { chromium } = require('playwright-chromium');

const args = process.argv.slice(2);
const remote = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const API_PORT = 4791;
const SITE_PORT = 4792;

const failures = [];
const check = (ok, what) => {
    console.log(`${ok ? '✔' : '✖'} ${what}`);
    if (!ok) failures.push(what);
};

// --- fixture API ------------------------------------------------------------------------

let apiMode = 'ok'; // 'ok' | 'down' | 'malformed' | 'analytics'
const fixtures = {
    '/api/v1/data-status': { freshness: { last_successful_sync: new Date().toISOString(), hours_since_sync: 1, last_final_game_date: '2026-10-12', latest_run: null }, coverage: [], recent_runs: [], latest_run_issues: [] },
    '/api/v1/conferences': { data: [{ id: 1, name: 'ACC', teams: 1 }] },
    '/api/v1/teams': { season: 2026, data: [{ id: 1, slug: 'duke', name: 'Smoke Test Duke', is_division_one: true, conference: 'ACC', played: 3, wins: 2, draws: 1, losses: 0, goals_for: 5, goals_against: 2 }], pagination: { page: 1, page_size: 50, total: 1, pages: 1 } },
    '/api/v1/seasons': { data: [{ season: 2026, games: 1, completed: 1 }] }
};

// Responsive fixtures: the longest names in the real data and tables of realistic length,
// so layout checks see the worst case rather than three short rows.
const LONG_TEAM = 'Loyola University Maryland Greyhounds';
const LONG_PLAYER = 'Alfonso Tenconi-Gradillas de la Fuente';
const line = i => ({ player_id: 100 + i, name: i === 0 ? LONG_PLAYER : `Player Number ${i}`, jersey_number: String(i), minutes: 90 - i, goals: i % 3, assists: i % 2, shots: i % 5, shots_on_goal: i % 4, saves: 0 });
const side = (id, name) => ({ team_id: id, team_slug: `t${id}`, team_name: name, totals: { players: 30, goals: 3, shots: 12, shots_on_goal: 6, saves: 4, reported_score: 3, goals_reconciliation: 'ok' }, players: Array.from({ length: 30 }, (_, i) => line(i)) });
const game = { id: 1, date: '2026-10-14', season: 2026, status: 'final', game_type: 'regular', location_type: 'home', home_score: 3, away_score: 0, boxscore_status: 'complete', quality_flags: [], home_team_slug: 'duke', home_team_name: LONG_TEAM, away_team_slug: 'mercer', away_team_name: 'Mercer' };
const page = (data, total = data.length) => ({ data, pagination: { page: 1, page_size: 50, total, pages: Math.ceil(total / 50) } });
Object.assign(fixtures, {
    '/api/v1/teams/duke': { data: { id: 1, slug: 'duke', name: LONG_TEAM, is_division_one: true, conference: 'Patriot', schedule_url: null, platform: null, seasons: [{ season: 2026, conference: 'Patriot', conference_source: 'inventory', played: 13, wins: 2, draws: 2, losses: 9, goals_for: 11, goals_against: 24 }] } },
    '/api/v1/teams/1/games': page(Array.from({ length: 18 }, (_, i) => ({ id: i + 1, date: `2026-09-${String(i + 1).padStart(2, '0')}`, status: 'final', game_type: 'regular', venue: 'home', opponent_slug: 'x', opponent_name: i ? `Opponent ${i}` : 'California State University Northridge', opponent_division_one: true, team_score: 1, opponent_score: 0, boxscore_status: 'complete', result: 'W' }))),
    '/api/v1/teams/1/players': { data: Array.from({ length: 30 }, (_, i) => ({ id: i, name: i ? `Player Number ${i}` : LONG_PLAYER, jersey_number: String(i), games_played: 13, minutes: 1000 + i, goals: i, assists: 1, points: i + 1, shots: 5, shots_on_goal: 3, saves: 0 })) },
    '/api/v1/teams/1/stats': { data: [{ season: 2026, games_with_boxscore: 8, shots: 66, shots_on_goal: 18, saves: 3, shots_against: 104 }] },
    '/api/v1/games': page(Array.from({ length: 50 }, (_, i) => ({ ...game, id: i + 1 })), 1359),
    '/api/v1/games/1/boxscore': { data: { game: { ...game, boxscore_url: null, boxscore_url_alt: null, last_verified_at: '2026-10-15T00:00:00Z' }, available: true, home: side(1, LONG_TEAM), away: side(2, 'Mercer'), unattributed: [] } },
    '/api/v1/players': page(Array.from({ length: 50 }, (_, i) => ({ id: i, name: i ? `Player Number ${i}` : LONG_PLAYER, team_slug: 'duke', team_name: LONG_TEAM, conference: 'Patriot', games_played: 13, minutes: 1000, goals: 5, assists: 2, points: 7, shots: 20, shots_on_goal: 9, saves: 0 })), 5997)
});

// Analytics built, for the Overview and its Team of the Week. Served only in 'analytics'
// mode, so the checks above keep exercising the fallback to the database-backed views.
const score = { games: 100, log_loss: 1, brier: 0.6, accuracy: 0.5, baseline_log_loss: 1.05 };
const totwPlayer = (id, name, team, group, rating, extra = {}) => ({
    id, name, team: { id, slug: `t${id}`, name: team }, position_group: group, position: group.toLowerCase(), rating, score: rating / 2,
    best_game: rating / 2, rank: 1, games: 2, minutes: 180, missing: group === 'GK' ? ['saves'] : [],
    explanation: `2 goals, 1 assist (2 games, 180 min). Best game ${(rating / 2).toFixed(2)} pts; ranked #1 of ${group}s this week.`,
    game_log: [{ game_id: 1, date: '2026-10-07', opponent: 'California State University Northridge', team_score: 2, opponent_score: 1, minutes: 90,
        goals: 2, assists: 1, shots_on_goal: 3, saves: group === 'GK' ? null : null, goals_allowed: group === 'GK' ? 1 : null,
        goals_allowed_source: group === 'GK' ? 'inferred' : null, score: rating / 2, components: { goals: 2, assists: 0.7, result: 0.3 } }],
    ...extra
});
const XI_GROUPS = ['GK', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD'];
const totwXi = XI_GROUPS.map((group, i) => ({
    slot: i + 1, position_group: group,
    // One empty place: the site must show it empty, not borrow from another position.
    player: i === 10 ? null : totwPlayer(200 + i, i === 2 ? LONG_PLAYER : `Player Number ${i}`, i === 2 || i === 9 ? LONG_TEAM : 'Mercer', group, 9.6 - i * 0.3)
}));
const analyticsFixtures = {
    '/api/v1/artifacts/analytics/index.json': {
        generated_at: '2026-10-15T09:00:00Z', current_season: '2026', current_week: null, seasons: ['2026'], coverage: [],
        model: { performance: { train: score, test: score, calibration: [] } },
        prediction_record: { overall: { games: 0, correct: 0, accuracy: 0, log_loss: 0, baseline_log_loss: 0 }, by_season: {} }
    },
    '/api/v1/artifacts/manifest.json': { generated_at: '2026-10-15T09:00:00Z', default_season: '2026', seasons: [] },
    '/api/v1/artifacts/analytics/ratings.json': { teams: [] },
    '/api/v1/artifacts/analytics/standouts.json': { weeks: [] },
    '/api/v1/team-of-week': {
        week: { start: '2026-10-05', end: '2026-10-11', season: 2026, competition: { code: 'ncaa-d1-msoc', name: "NCAA Division I Men's Soccer" },
            status: 'provisional', revision: 1, computed_at: '2026-10-15T09:00:00Z', first_computed_at: '2026-10-13T09:00:00Z',
            completeness: { final_games: 190, games_with_boxscore: 176, games_captured: 170, position_share: 0.97, keeper_official_ga_share: 0.9, keeper_saves_share: 0.88 },
            previous: '2026-09-28', next: null },
        formation: '4-3-3', xi: totwXi, filled: 10,
        best: { GK: totwXi[0].player, DEF: totwXi[1].player, MID: totwXi[5].player, FWD: totwXi[8].player },
        honorable_mentions: { GK: [totwPlayer(300, 'Backup Keeper', LONG_TEAM, 'GK', 6.1, { rank: 2 })], DEF: [], MID: [], FWD: [] },
        model: { version: 'totw-1', summary: 'Smoke-test model summary.' }
    },
    '/api/v1/team-of-week/weeks': { data: [{ start: '2026-10-05', end: '2026-10-11', status: 'provisional', filled: 10 }, { start: '2026-09-28', end: '2026-10-04', status: 'final', filled: 11 }] }
};

function startApi() {
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (apiMode === 'down') {
            req.socket.destroy();
            return;
        }
        // Analytics not built yet: the app must still start, on the database-backed views.
        let body = fixtures[url.pathname] ?? (apiMode === 'analytics' ? analyticsFixtures[url.pathname] : undefined);
        if (apiMode === 'malformed' && url.pathname === '/api/v1/teams') body = { data: 'not-a-list', pagination: null };
        if (!body) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'not_found', message: 'No such route' } }));
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    });
    return new Promise(resolve => server.listen(API_PORT, '127.0.0.1', () => resolve(server)));
}

async function startSite() {
    const { preview } = await import('vite');
    const vercel = JSON.parse(readFileSync(path.join(here, '../vercel.json'), 'utf8'));
    const csp = vercel.headers
        .find(h => h.source === '/(.*)')
        .headers.find(h => h.key === 'Content-Security-Policy')
        .value.replace(/https:\/\/api-production[^\s;]+/, `http://127.0.0.1:${API_PORT}`)
        .replace('; upgrade-insecure-requests', '');
    return preview({
        root: path.join(here, '..'),
        base: '/ncadb/',
        configFile: false,
        preview: { host: '127.0.0.1', port: SITE_PORT, strictPort: true, headers: { 'Content-Security-Policy': csp } }
    });
}

// --- checks -----------------------------------------------------------------------------

async function assets(site) {
    const html = await (await fetch(site)).text();
    check(/<div id="root">/.test(html) && /College Soccer Lab/.test(html), 'HTML is served with the boot fallback');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m => new URL(m[1], site).toString());
    check(refs.length >= 2, `bundle and stylesheet referenced (${refs.length})`);
    for (const ref of refs) {
        const res = await fetch(ref);
        const type = res.headers.get('content-type') || '';
        check(res.ok && /javascript|css/.test(type), `${new URL(ref).pathname} → ${res.status} ${type.split(';')[0]}`);
    }
}

/**
 * Clerk Protect's in-page loader is refused by the CSP on purpose (docs/AUTHENTICATION.md,
 * "Content Security Policy"), so the browser reports it on every page with sign-in on.
 * A message is excused only when the blocked URL (the first one in it; the rest quote the
 * policy) is on one of those hosts, compared by parsed hostname. Anything else still fails.
 */
const isClerkProtect = url => {
    try {
        const { protocol, hostname } = new URL(url);
        return protocol === 'https:' && (hostname === 'cdn.protect.clerk.com' || hostname.endsWith('.client.protect.clerk.com'));
    } catch {
        return false;
    }
};
const EXPECTED_REFUSAL = {
    test: text => {
        const blocked = text.match(/https?:\/\/[^\s'"]+/);
        return blocked !== null && isClerkProtect(blocked[0].replace(/\.$/, ''));
    }
};

/**
 * Layout at phone, tablet and laptop widths: the page never scrolls sideways (wide tables
 * scroll inside their own box), every section is reachable from the section bar, no image
 * is broken, and nothing throws. Screenshots go to SMOKE_SCREENSHOTS for review.
 */
const WIDTHS = [320, 390, 768, 1366];
const LAYOUT_PAGES = [
    ['teams', '#/teams'],
    ['team', '#/teams/duke'],
    ['games', '#/games'],
    ['game', '#/games/1'],
    ['players', '#/directory'],
    ['status', '#/status']
];
async function layout(browser, base) {
    const shots = process.env.SMOKE_SCREENSHOTS;
    if (shots) (await import('node:fs')).mkdirSync(shots, { recursive: true });
    for (const width of WIDTHS) {
        const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: width < 768, hasTouch: width < 1100 });
        for (const [name, hash] of LAYOUT_PAGES) {
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.goto(base + hash, { waitUntil: 'networkidle' });
            await page.waitForFunction(() => !document.querySelector('.loading, .boot'), null, { timeout: 15000 }).catch(() => errors.push('still loading'));
            const m = await page.evaluate(() => {
                const visible = el => el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none';
                const ribbon = document.querySelector('.nav-ribbon');
                const ribbonFits = ribbon && ribbon.scrollWidth <= ribbon.clientWidth + 1;
                return {
                    overflow: document.documentElement.scrollWidth - window.innerWidth,
                    sticky: getComputedStyle(document.querySelector('.broadsheet-nav')).position,
                    // Every section is either on screen in the ribbon or listed in the Menu.
                    reachable: ribbonFits || (visible(document.querySelector('.nav-menu-toggle')) && document.querySelectorAll('.nav-panel a').length === 9),
                    tablesContained: [...document.querySelectorAll('table')].every(t => t.closest('.table-scroll')),
                    brokenImages: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
                    h1: document.querySelectorAll('h1').length
                };
            });
            const label = `${name} @ ${width}px`;
            check(m.overflow <= 0, `${label}: no horizontal page overflow${m.overflow > 0 ? ` (${m.overflow}px)` : ''}`);
            check(m.sticky === 'sticky' && m.reachable, `${label}: section bar pinned and every section reachable`);
            check(m.tablesContained && m.brokenImages === 0 && m.h1 === 1, `${label}: tables scroll in place, no broken images, one h1`);
            check(errors.length === 0, `${label}: no errors${errors.length ? ` (${errors.join(' | ').slice(0, 200)})` : ''}`);
            if (shots) await page.screenshot({ path: path.join(shots, `${name}-${width}.png`), fullPage: true });
            await page.close();
        }
        await context.close();
    }
}

/**
 * Team of the Week on the Overview, at every width: the XI is eleven places (an empty one
 * shown as empty), every marker is a 44px target with a readable name, the page never
 * scrolls sideways, a phone gets the ranked list under the pitch, and choosing a player —
 * by tap or keyboard — opens their breakdown with a link to the full profile.
 */
async function teamOfWeek(browser, base) {
    const shots = process.env.SMOKE_SCREENSHOTS;
    apiMode = 'analytics';
    for (const width of WIDTHS) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 1100 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(base + '#/overview', { waitUntil: 'networkidle' });
        const label = `team of the week @ ${width}px`;
        const found = await page.waitForSelector('.totw-pitch', { timeout: 15000 }).then(() => true, () => false);
        check(found, `${label}: pitch rendered`);
        if (!found) { await context.close(); continue; }
        const m = await page.evaluate(() => {
            const markers = [...document.querySelectorAll('.totw-pitch .totw-marker')];
            const buttons = markers.filter(el => el.tagName === 'BUTTON');
            const names = [...document.querySelectorAll('.totw-pitch .totw-marker-name')];
            const companion = document.querySelector('.totw-list-companion');
            return {
                overflow: document.documentElement.scrollWidth - window.innerWidth,
                slots: markers.length,
                empty: document.querySelectorAll('.totw-pitch .totw-marker.is-empty').length,
                smallTargets: buttons.filter(b => b.getBoundingClientRect().height < 44 || b.getBoundingClientRect().width < 44).length,
                smallestName: Math.min(...names.map(n => parseFloat(getComputedStyle(n).fontSize))),
                labelled: buttons.every(b => (b.getAttribute('aria-label') || '').includes('rating')),
                markersInside: markers.every(el => {
                    const r = el.getBoundingClientRect();
                    const p = document.querySelector('.totw-pitch').getBoundingClientRect();
                    return r.left >= p.left - 1 && r.right <= p.right + 1;
                }),
                companionVisible: !!companion && getComputedStyle(companion).display !== 'none',
                partialNotice: /Only 10 of 11 places/.test(document.body.innerText)
            };
        });
        check(m.overflow <= 0, `${label}: no horizontal page overflow${m.overflow > 0 ? ` (${m.overflow}px)` : ''}`);
        check(m.slots === 11 && m.empty === 1 && m.partialNotice, `${label}: eleven places, the empty one shown and explained`);
        check(m.smallTargets === 0 && m.smallestName >= 12 && m.markersInside, `${label}: 44px markers inside the pitch, names at least 12px`);
        check(m.labelled, `${label}: every marker has a spoken description`);
        check(width <= 640 ? m.companionVisible : !m.companionVisible, `${label}: ranked list under the pitch on phones only`);

        // Choose the long-named defender, by tap on touch screens and by keyboard elsewhere.
        const target = page.locator('.totw-pitch button.totw-marker', { hasText: width <= 640 ? 'Fuente' : 'Alfonso' });
        if (width < 1100) await target.tap(); else { await target.focus(); await page.keyboard.press('Enter'); }
        await page.waitForTimeout(400);
        const detail = await page.evaluate(() => {
            const panel = document.querySelector('.totw-detail');
            const link = panel?.querySelector('a[href*="#/directory/"]');
            return { name: panel?.querySelector('.totw-detail-name')?.textContent ?? '', link: link?.getAttribute('href') ?? '',
                inferred: /from the score/.test(document.querySelector('.totw')?.innerText ?? '') };
        });
        check(/Tenconi/.test(detail.name) && /#\/directory\/202$/.test(detail.link), `${label}: choosing a player opens their breakdown and profile link`);
        await page.locator('.totw-mode button', { hasText: 'Table' }).click();
        const tableRows = await page.locator('.totw-table tbody tr').count();
        check(tableRows === 11, `${label}: table view lists all eleven places`);
        if (shots) await page.screenshot({ path: path.join(shots, `totw-${width}.png`), fullPage: false });
        await page.locator('.totw-mode button', { hasText: 'Pitch' }).click();
        if (shots) {
            await page.locator('.totw').screenshot({ path: path.join(shots, `totw-pitch-${width}.png`) });
        }
        check(errors.length === 0, `${label}: no errors${errors.length ? ` (${errors.join(' | ').slice(0, 200)})` : ''}`);
        await context.close();
    }
    apiMode = 'ok';
}

async function render(browser, site, { expectText, hash = '', label }) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && !EXPECTED_REFUSAL.test(m.text()) && errors.push(m.text()));
    await page.exposeFunction('__cspViolation', v => EXPECTED_REFUSAL.test(v) || errors.push(`CSP: ${v}`));
    await page.addInitScript(() =>
        document.addEventListener('securitypolicyviolation', e => window.__cspViolation(`${e.violatedDirective} ${e.blockedURI}`))
    );
    await page.goto(site + hash, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const text = (await page.innerText('body')).replace(/\s+/g, ' ');
    check(text.trim().length > 40, `${label}: page has visible content`);
    check(expectText.test(text), `${label}: shows ${expectText}`);
    // The deliberate-failure scenarios log the error they recover from; there only a CSP
    // violation counts as a failure.
    const allowed = label.includes('error') ? errors.filter(e => e.startsWith('CSP:')) : errors;
    check(allowed.length === 0, `${label}: no uncaught errors or CSP violations${allowed.length ? ` (${allowed.join(' | ').slice(0, 300)})` : ''}`);
    await page.close();
}

const browser = await chromium.launch();
let api;
let site;
try {
    if (remote) {
        const base = remote.endsWith('/') ? remote : `${remote}/`;
        await assets(base);
        await render(browser, base, { label: 'home', expectText: /College Soccer Lab/ });
        await render(browser, base, { label: 'teams', hash: '#/teams', expectText: /Teams[\s\S]*W-D-L/ });
        await render(browser, base, { label: 'status', hash: '#/status', expectText: /Coverage by season/ });
    } else {
        api = await startApi();
        site = await startSite();
        const base = `http://127.0.0.1:${SITE_PORT}/ncadb/`;
        await assets(base);
        await render(browser, base, { label: 'home', expectText: /Teams[\s\S]*Smoke Test Duke/ });
        await render(browser, base, { label: 'navigation', hash: '#/status', expectText: /Data status/ });
        await layout(browser, base);
        await teamOfWeek(browser, base);
        // Account routes, in a build without a Clerk key: a clear message, never a blank page.
        await render(browser, `${base}login`, { label: 'account route, sign-in off', expectText: /Log in[\s\S]*not switched on/ });
        apiMode = 'malformed';
        await render(browser, base, { label: 'malformed data (error boundary)', hash: '#/teams', expectText: /could not be displayed[\s\S]*Reload/ });
        apiMode = 'down';
        await render(browser, base, { label: 'API down (error state)', expectText: /could not be reached|taking too long/ });
    }
} finally {
    await browser.close();
    api?.close();
    await site?.close();
}

if (failures.length) {
    console.error(`\n${failures.length} smoke check(s) failed.`);
    process.exit(1);
}
console.log('\nSmoke test passed.');
