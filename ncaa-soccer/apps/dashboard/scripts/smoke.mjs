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

let apiMode = 'ok'; // 'ok' | 'down' | 'malformed'
const fixtures = {
    '/api/v1/data-status': { freshness: { last_successful_sync: new Date().toISOString(), hours_since_sync: 1, last_final_game_date: '2026-10-12', latest_run: null }, coverage: [], recent_runs: [], latest_run_issues: [] },
    '/api/v1/conferences': { data: [{ id: 1, name: 'ACC', teams: 1 }] },
    '/api/v1/teams': { season: 2026, data: [{ id: 1, slug: 'duke', name: 'Smoke Test Duke', is_division_one: true, conference: 'ACC', played: 3, wins: 2, draws: 1, losses: 0, goals_for: 5, goals_against: 2 }], pagination: { page: 1, page_size: 50, total: 1, pages: 1 } },
    '/api/v1/seasons': { data: [{ season: 2026, games: 1, completed: 1 }] }
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
        let body = fixtures[url.pathname];
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

async function render(browser, site, { expectText, hash = '', label }) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await page.exposeFunction('__cspViolation', v => errors.push(`CSP: ${v}`));
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
