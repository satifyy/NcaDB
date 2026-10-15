/**
 * End-to-end test of accounts against a real Clerk development instance.
 *
 *   E2E_DIST=<built site>  CLERK_SECRET_KEY=sk_test_…  CLERK_FAPI=<x>.clerk.accounts.dev \
 *   E2E_API=http://localhost:3001  MIGRATION_DATABASE_URL=postgres://owner…  node scripts/auth-e2e.mjs
 *
 * The site must be built with BASE_PATH=/ncadb, VITE_API_BASE_URL=$E2E_API and the
 * instance's VITE_CLERK_PUBLISHABLE_KEY; the API must run with that instance's secret key,
 * CLERK_ISSUER=https://$CLERK_FAPI and CLERK_AUTHORIZED_PARTIES=http://localhost:4173.
 *
 * The site is served the way vercel.json describes it (the same rewrites, the same CSP
 * with only the Clerk and API origins swapped for the local ones), and a real browser
 * signs up and signs in on Clerk's hosted pages with Clerk test addresses
 * (`+clerk_test`, verification code 424242), so no email is sent. Test users are deleted
 * at the end. Google sign-in needs a real Google account and is checked only as far as
 * the hand-off to accounts.google.com.
 *
 * Clerk's bot protection stops a headless browser on its hosted pages, as it should. The
 * browser here carries a Clerk Testing Token (issued by the Backend API, development
 * instances only) on its Frontend API requests: Clerk's supported way through for tests,
 * the same thing @clerk/testing does.
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Playwright is the scraper's dependency; the dashboard borrows it, as smoke.mjs does.
const { chromium } = createRequire(path.join(here, '../../scraper/package.json'))('playwright-chromium');
const { E2E_DIST, CLERK_SECRET_KEY, CLERK_FAPI, E2E_API = 'http://localhost:3001', MIGRATION_DATABASE_URL } = process.env;
for (const [k, v] of Object.entries({ E2E_DIST, CLERK_SECRET_KEY, CLERK_FAPI, MIGRATION_DATABASE_URL })) {
    if (!v) throw new Error(`${k} is required`);
}
if (!CLERK_SECRET_KEY.startsWith('sk_test_')) throw new Error('Only a Clerk development instance (sk_test_) may be used here');

const SITE_PORT = 4173;
const ORIGIN = `http://localhost:${SITE_PORT}`;
const SITE = `${ORIGIN}/ncadb/`;
const SHOTS = process.env.E2E_SCREENSHOTS || path.join(here, '../.e2e-screenshots');
const RUN = Date.now().toString(36);
const ALICE = { email: `alice-${RUN}+clerk_test@example.com`, password: `Alice-e2e-${RUN}-Pw!93` };
const BOB = { email: `bob-${RUN}+clerk_test@example.com`, password: `Bob-e2e-${RUN}-Pw!71` };

const results = [];
function check(ok, label, detail = '') {
    results.push({ ok, label });
    console.log(`${ok ? '✔' : '✘'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
}

// --- Clerk Backend API (cleanup and lookups only) ----------------------------------------

async function clerk(method, p, body) {
    const res = await fetch(`https://api.clerk.com/v1${p}`, {
        method,
        headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
}

// --- the site, served like vercel.json ---------------------------------------------------

function siteServer() {
    const vercel = JSON.parse(readFileSync(path.join(here, '../vercel.json'), 'utf8'));
    const all = vercel.headers.find(h => h.source === '/(.*)').headers;
    const csp = all
        .find(h => h.key === 'Content-Security-Policy')
        .value.replaceAll('https://clerk.satifyy.com', `https://${CLERK_FAPI}`)
        .replace(/https:\/\/api-production[^\s;]+/, E2E_API)
        .replace('; upgrade-insecure-requests', '');
    // Vercel sources are path patterns: `/:page(login|signup)` is the group `(login|signup)`.
    const rewrites = (vercel.rewrites ?? []).map(r => new RegExp(`^${r.source.replace(/:\w+\(/g, '(')}$`));
    const types = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8' };
    const server = createServer((req, res) => {
        const url = new URL(req.url, ORIGIN);
        if (!url.pathname.startsWith('/ncadb/')) {
            res.writeHead(url.pathname === '/ncadb' ? 307 : 404, url.pathname === '/ncadb' ? { Location: '/ncadb/' } : {});
            return res.end();
        }
        // The hub strips /ncadb before proxying to the Vercel project; mirror that.
        let rel = url.pathname.slice('/ncadb'.length);
        let file = path.join(E2E_DIST, rel === '/' ? 'index.html' : rel);
        if (!existsSync(file) || rel === '/') {
            if (rel === '/' || rewrites.some(r => r.test(rel))) file = path.join(E2E_DIST, 'index.html');
            else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('not found');
            }
        }
        const headers = { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' };
        for (const h of all) headers[h.key] = h.key === 'Content-Security-Policy' ? csp : h.value;
        res.writeHead(200, headers);
        res.end(readFileSync(file));
    });
    return new Promise(resolve => server.listen(SITE_PORT, '127.0.0.1', () => resolve({ server, csp })));
}

// --- browser helpers ---------------------------------------------------------------------

let testingToken = null;
let clientTrustSeen = false;

/** A context whose pages record uncaught errors and CSP violations on our origin. */
async function newContext(browser, viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport });
    await context.route(`https://${CLERK_FAPI}/v1/**`, route => {
        const url = new URL(route.request().url());
        url.searchParams.set('__clerk_testing_token', testingToken);
        return route.continue({ url: url.toString() });
    });
    const problems = [];
    context.on('page', page => {
        page.on('pageerror', e => page.url().startsWith(ORIGIN) && problems.push(`pageerror ${e.message}`));
    });
    await context.exposeFunction('__csp', v => problems.push(`CSP ${v}`));
    await context.addInitScript(() => {
        if (location.origin.startsWith('http://localhost')) {
            document.addEventListener('securitypolicyviolation', e => window.__csp(`${e.violatedDirective} ${e.blockedURI}`));
        }
    });
    return { context, problems };
}

const bodyText = async page => (await page.innerText('body')).replace(/\s+/g, ' ');

async function shot(page, name) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Fills the first visible input matching any selector. */
async function fill(page, selectors, value) {
    for (const s of selectors) {
        const el = page.locator(s).first();
        if (await el.isVisible().catch(() => false)) {
            await el.fill(value);
            return true;
        }
    }
    return false;
}

async function clickContinue(page) {
    const button = page.getByRole('button', { name: /^continue$/i }).first();
    await button.click();
}

/** Types Clerk's test verification code into whatever OTP field the hosted page shows. */
async function enterCode(page) {
    await page.waitForSelector('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', { timeout: 30_000 });
    const field = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]').first();
    await field.click();
    await page.keyboard.type('424242', { delay: 60 });
}

async function waitForSite(page, pathname, timeout = 45_000) {
    await page.waitForURL(u => u.origin === ORIGIN && u.pathname === pathname, { timeout });
}

/** Signs up on Clerk's hosted page, starting from our /ncadb/signup. */
async function signUp(page, user) {
    await page.goto(`${SITE}signup`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /continue to sign up/i }).click();
    await page.waitForURL(u => u.hostname.endsWith('accounts.dev'), { timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    await fill(page, ['input[name="emailAddress"]', 'input[type="email"]', 'input[name="identifier"]'], user.email);
    await fill(page, ['input[name="password"]', 'input[type="password"]'], user.password);
    await clickContinue(page);
    await enterCode(page);
    await waitForSite(page, '/ncadb/dashboard');
}

/** Signs in with email and password on Clerk's hosted page, starting from /ncadb/login. */
async function signInPassword(page, user) {
    await page.goto(`${SITE}login`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /continue to log in/i }).click();
    await page.waitForURL(u => u.hostname.endsWith('accounts.dev'), { timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    await fill(page, ['input[name="identifier"]', 'input[type="email"]'], user.email);
    await clickContinue(page);
    await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 30_000 });
    await fill(page, ['input[name="password"]', 'input[type="password"]'], user.password);
    await clickContinue(page);
    // A correct password from a browser Clerk has not seen still needs an emailed code
    // ("client trust"), which is part of what defeats credential stuffing.
    await page.waitForURL(u => u.origin === ORIGIN || u.pathname.includes('client-trust'), { timeout: 30_000 });
    if (new URL(page.url()).pathname.includes('client-trust')) {
        clientTrustSeen = true;
        await enterCode(page);
    }
    await waitForSite(page, '/ncadb/dashboard');
}

/** Signs in with an emailed code (Clerk test code) instead of the password. */
async function signInEmailCode(page, user) {
    await page.goto(`${SITE}login`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /continue to log in/i }).click();
    await page.waitForURL(u => u.hostname.endsWith('accounts.dev'), { timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    await fill(page, ['input[name="identifier"]', 'input[type="email"]'], user.email);
    await clickContinue(page);
    await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 30_000 });
    await page.getByRole('link', { name: /use another method/i }).or(page.getByRole('button', { name: /use another method/i })).first().click();
    await page.getByRole('button', { name: /email code/i }).first().click();
    await enterCode(page);
    await waitForSite(page, '/ncadb/dashboard');
}

const sessionToken = page => page.evaluate(() => window.Clerk?.session?.getToken());
const tokenClaims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

async function api(method, p, token, body) {
    const res = await fetch(`${E2E_API}${p}`, {
        method,
        headers: {
            Origin: ORIGIN,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        /* not JSON */
    }
    return { status: res.status, json };
}

const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// --- the scenario ------------------------------------------------------------------------

// A clean slate in the local test database: no accounts or maintenance requests left over
// from an earlier run (the one-open-request-per-target rule would refuse a repeat).
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(MIGRATION_DATABASE_URL)) throw new Error('MIGRATION_DATABASE_URL must be a local test database');
{
    const { Client } = createRequire(path.join(here, '../../api/package.json'))('pg');
    const db = new Client({ connectionString: MIGRATION_DATABASE_URL });
    await db.connect();
    await db.query('TRUNCATE accounts.user_profiles, accounts.user_activity_audit, maintenance_requests CASCADE');
    await db.end();
}

const issued = await clerk('POST', '/testing_tokens');
testingToken = issued.json?.token;
if (!testingToken) throw new Error(`Could not get a Clerk testing token (${issued.status})`);
const { server, csp } = await siteServer();
console.log(`site ${SITE}\nCSP  ${csp}\n`);
const browser = await chromium.launch();
const created = [];
try {
    // A real team and player from the API to save.
    const teams = await api('GET', '/api/v1/teams?search=duke');
    const team = teams.json.data.find(t => t.slug === 'duke') ?? teams.json.data[0];
    const players = await api('GET', '/api/v1/players?season=2025&sort=-goals&page_size=1');
    const player = players.json.data[0];

    // 1. Public statistics, signed out.
    const anon = await newContext(browser);
    const page0 = await anon.context.newPage();
    await page0.goto(`${SITE}#/teams`, { waitUntil: 'networkidle' });
    await page0.waitForTimeout(1500);
    check(/W-D-L/.test(await bodyText(page0)), 'public statistics render without signing in');
    check(await page0.getByRole('link', { name: /log in/i }).isVisible(), 'navigation shows a Log in button when signed out');
    await page0.goto(`${SITE}#/teams/${team.slug}`, { waitUntil: 'networkidle' });
    await page0.waitForTimeout(1000);
    check(await page0.getByRole('link', { name: /log in to save/i }).isVisible(), 'team page offers "Log in to save" when signed out');
    for (const route of ['login', 'signup', 'profile', 'dashboard', 'admin']) {
        const res = await page0.goto(`${SITE}${route}`, { waitUntil: 'networkidle' });
        check(res.status() === 200, `/ncadb/${route} is served (rewrite) — ${res.status()}`);
    }
    await page0.goto(`${SITE}profile`, { waitUntil: 'networkidle' });
    await page0.waitForTimeout(1000);
    check(/Sign in to see this page/.test(await bodyText(page0)), '/ncadb/profile asks a signed-out reader to sign in');
    const missing = await fetch(`${SITE}assets/does-not-exist.js`);
    check(missing.status === 404, 'a missing asset is a 404, not index.html');
    check((await api('GET', '/api/v1/me')).status === 401, 'API: /me without a token is 401');
    check((await api('GET', '/api/v1/teams')).status === 200, 'API: public statistics need no token');

    // 2. Registration (email + password, verified by code) and the redirect back.
    const a = await newContext(browser);
    const alice = await a.context.newPage();
    await signUp(alice, ALICE);
    check(true, 'new registration through Clerk, email verified, redirected to /ncadb/dashboard');
    await alice.waitForTimeout(1500);
    await shot(alice, 'dashboard-desktop');
    check(await alice.locator('.account-trigger').isVisible(), 'navigation shows the profile menu when signed in');
    let token = await sessionToken(alice);
    const claims = tokenClaims(token);
    created.push(claims.sub);
    check(claims.azp === ORIGIN && claims.iss === `https://${CLERK_FAPI}`, `session token: iss and azp are ours (azp ${claims.azp})`);
    check(claims.exp - claims.iat <= 120, `session token is short-lived (${claims.exp - claims.iat}s)`);
    // Key names and sizes only, never values, in the report.
    const stored = await alice.evaluate(() =>
        Object.keys(localStorage).map(k => ({ k, len: localStorage.getItem(k).length, jwt: /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/.test(localStorage.getItem(k)) }))
    );
    const jwtKeys = stored.filter(x => x.jwt);
    check(jwtKeys.length === 0, 'no token is stored in localStorage', `keys holding a JWT: ${jwtKeys.map(x => `${x.k} (${x.len})`).join(', ')}; all keys: ${stored.map(x => x.k).join(', ')}`);
    const me = await api('GET', '/api/v1/me', token);
    check(me.status === 200 && me.json.data.role === 'user', 'API: first request creates a plain "user" profile (not admin)');

    // 3. Favorites, through the UI, and their persistence.
    await alice.goto(`${SITE}#/teams/${team.slug}`, { waitUntil: 'networkidle' });
    await alice.getByRole('button', { name: /save team/i }).click();
    await alice.getByRole('button', { name: /saved/i }).waitFor({ timeout: 10_000 });
    check((await alice.getByRole('button', { name: /saved/i }).getAttribute('aria-pressed')) === 'true', `favorite team saved from its page (${team.name})`);
    await alice.goto(`${SITE}#/directory/${player.id}`, { waitUntil: 'networkidle' });
    await alice.getByRole('button', { name: /save player/i }).click();
    await alice.getByRole('button', { name: /saved/i }).waitFor({ timeout: 10_000 });
    check(true, `favorite player saved from their page (${player.name})`);
    await alice.goto(`${SITE}profile`, { waitUntil: 'networkidle' });
    await alice.getByText(team.name).first().waitFor({ timeout: 15_000 });
    const profileText = await bodyText(alice);
    check(profileText.includes(team.name) && profileText.includes(player.name), 'favorites persist across a reload (profile page)');
    await alice.getByLabel('Display name').fill('Alice E2E');
    await alice.getByRole('button', { name: /^save$/i }).click();
    await alice.getByText('Saved.').first().waitFor({ timeout: 10_000 });
    check(true, 'profile update saves, with a confirmation');
    await alice.getByLabel('Display name').fill('<b>bad</b>');
    await alice.getByRole('button', { name: /^save$/i }).click();
    await alice.locator('.form-error').first().waitFor({ timeout: 10_000 });
    check(true, 'invalid profile input shows a form error');

    // 4. Session renewal: a new token is minted while the session lives. Waits past the
    // verifier's 5 s clock-skew allowance, inside which a just-expired token still passes.
    const firstExp = claims.exp;
    await alice.waitForTimeout(Math.max(0, (firstExp - Math.floor(Date.now() / 1000) + 7) * 1000));
    const renewed = await sessionToken(alice);
    check(tokenClaims(renewed).exp > firstExp, 'session renews: a fresh token after the first expired');
    check((await api('GET', '/api/v1/me', token)).status === 401, 'an expired session token is refused (401)');
    check((await api('GET', '/api/v1/me', renewed)).status === 200, 'the renewed token is accepted');
    token = renewed;

    // 5. A second user: isolation.
    const b = await newContext(browser);
    const bob = await b.context.newPage();
    await signUp(bob, BOB);
    await bob.locator('.account-trigger').waitFor({ timeout: 15_000 });
    const bobToken = await sessionToken(bob);
    created.push(tokenClaims(bobToken).sub);
    const bobTeams = await api('GET', '/api/v1/me/favorites/teams', bobToken);
    check(bobTeams.status === 200 && bobTeams.json.data.length === 0, 'cross-user isolation: Bob sees none of Alice’s favorites');
    await api('DELETE', `/api/v1/me/favorites/teams/${team.slug}`, bobToken);
    await api('PATCH', '/api/v1/me', bobToken, { display_name: 'Mallory' });
    const aliceAfter = await api('GET', '/api/v1/me/favorites/teams', token);
    const aliceMe = await api('GET', '/api/v1/me', token);
    check(aliceAfter.json.data.length === 1 && aliceMe.json.data.display_name === 'Alice E2E', 'cross-user isolation: Bob’s writes do not touch Alice’s data');

    // 6. Admin: refused until the audited role change, then allowed.
    await alice.goto(`${SITE}admin`, { waitUntil: 'networkidle' });
    await alice.getByText(/Administrator access is required/).waitFor({ timeout: 15_000 });
    check(true, '/ncadb/admin refuses a plain user (server-side 403)');
    check((await api('GET', '/api/v1/admin/runs', token)).status === 403, 'API: admin route is 403 for a user');
    execFileSync(
        'npm',
        ['run', '-s', 'worker', '--', 'set-role', '--subject', claims.sub, '--role', 'admin', '--reason', 'E2E test of admin provisioning', '--actor', 'auth-e2e'],
        { cwd: path.join(here, '../../..'), env: { ...process.env, MIGRATION_DATABASE_URL }, stdio: 'pipe' }
    );
    await alice.reload({ waitUntil: 'networkidle' });
    await alice.getByText('Ingestion runs').waitFor({ timeout: 15_000 });
    check(true, 'after the audited set-role, /ncadb/admin shows ingestion runs');
    await alice.getByLabel(/Action/).selectOption('rebuild_analytics');
    await alice.getByLabel(/Reason/).fill('E2E: rebuild analytics after loading 2025');
    await alice.getByLabel(/I authorize this maintenance/).check();
    await alice.getByRole('button', { name: /request maintenance/i }).click();
    await alice.getByText(/Requested\./).waitFor({ timeout: 10_000 });
    check(true, 'an admin can file an explicit, audited maintenance request');
    check((await api('GET', '/api/v1/admin/runs', bobToken)).status === 403, 'API: Bob is still refused admin routes');
    await shot(alice, 'admin-desktop');

    // 7. Login with an existing account, by password and by email code.
    const c = await newContext(browser);
    const again = await c.context.newPage();
    await signInPassword(again, ALICE);
    await again.locator('.account-trigger').waitFor({ timeout: 15_000 });
    await again.getByText(team.name).first().waitFor({ timeout: 15_000 });
    check(true, 'email + password login of an existing account, favorites intact');
    check(clientTrustSeen, 'a new device must also confirm an emailed code (Clerk client trust)');
    const d = await newContext(browser);
    const code = await d.context.newPage();
    try {
        await signInEmailCode(code, BOB);
        check(true, 'email-code login (passwordless) of an existing account');
    } catch (err) {
        check(false, 'email-code login (passwordless) of an existing account', err.message.split('\n')[0]);
    }

    // 8. Google: the hand-off to Google is configured (a real Google account is needed to finish).
    const g = await newContext(browser);
    const google = await g.context.newPage();
    await google.goto(`${SITE}login`, { waitUntil: 'networkidle' });
    await google.getByRole('button', { name: /continue to log in/i }).click();
    await google.waitForURL(u => u.hostname.endsWith('accounts.dev'), { timeout: 30_000 });
    await google.getByRole('button', { name: /google/i }).first().click();
    await google.waitForURL(u => u.hostname === 'accounts.google.com', { timeout: 30_000 });
    const redirect = new URL(google.url()).searchParams.get('redirect_uri') ?? '';
    check(redirect.includes(CLERK_FAPI) || redirect.includes('clerk'), `Google OAuth hands off to Google with Clerk’s callback (${redirect})`);

    // 9. Logout: the session ends, the UI says so, and protected pages ask to sign in.
    await again.locator('.account-trigger').waitFor({ timeout: 15_000 });
    const beforeLogout = await sessionToken(again);
    await again.locator('.account-trigger').click();
    await again.getByRole('menuitem', { name: /sign out/i }).click();
    await waitForSite(again, '/ncadb/');
    await again.getByRole('link', { name: /log in/i }).waitFor({ timeout: 15_000 });
    check(true, 'logout returns to /ncadb/ with the Log in button');
    await again.goto(`${SITE}dashboard`, { waitUntil: 'networkidle' });
    await again.getByText(/Sign in to see this page/).waitFor({ timeout: 15_000 });
    check(true, 'after logout, /ncadb/dashboard asks to sign in');
    const ended = await clerk('GET', `/sessions/${tokenClaims(beforeLogout).sid}`);
    check(['ended', 'revoked', 'removed'].includes(ended.json?.status), `the session is ended server-side (${ended.json?.status})`);
    await again.waitForTimeout(Math.max(0, (tokenClaims(beforeLogout).exp - Math.floor(Date.now() / 1000) + 6) * 1000));
    check((await api('GET', '/api/v1/me', beforeLogout)).status === 401, 'the last token of a signed-out session stops working at expiry');

    // 10. Mobile.
    const m = await newContext(browser, { width: 390, height: 844 });
    const mobile = await m.context.newPage();
    for (const route of ['login', 'signup']) {
        await mobile.goto(`${SITE}${route}`, { waitUntil: 'networkidle' });
        await mobile.waitForTimeout(800);
        check(await noOverflow(mobile), `mobile 390px: /ncadb/${route} has no horizontal overflow`);
        await shot(mobile, `${route}-mobile`);
    }
    await signInPassword(mobile, ALICE);
    await mobile.locator('.account-trigger').waitFor({ timeout: 15_000 });
    for (const route of ['dashboard', 'profile', 'admin']) {
        await mobile.goto(`${SITE}${route}`, { waitUntil: 'networkidle' });
        await mobile.waitForTimeout(1500);
        check(await noOverflow(mobile), `mobile 390px: /ncadb/${route} has no horizontal overflow`);
        await shot(mobile, `${route}-mobile`);
    }
    await mobile.locator('.account-trigger').click();
    check(await mobile.getByRole('menu').isVisible(), 'mobile 390px: the profile menu opens');

    // The smallest phone the site supports, still signed in: no overflow, the account menu
    // fits on screen, and the section menu reaches the statistics.
    await mobile.setViewportSize({ width: 320, height: 568 });
    for (const route of ['dashboard', 'profile', 'admin']) {
        await mobile.goto(`${SITE}${route}`, { waitUntil: 'networkidle' });
        await mobile.waitForTimeout(1500);
        check(await noOverflow(mobile), `mobile 320px: /ncadb/${route} has no horizontal overflow`);
        await shot(mobile, `${route}-mobile-320`);
    }
    await mobile.locator('.account-trigger').click();
    const menuBox = await mobile.getByRole('menu').boundingBox();
    check(menuBox !== null && menuBox.x >= 0 && menuBox.x + menuBox.width <= 320, 'mobile 320px: the profile menu fits on screen');
    await mobile.keyboard.press('Escape');
    await mobile.locator('.nav-menu-toggle').click();
    await mobile.locator('.nav-panel a', { hasText: 'Teams' }).click();
    await mobile.waitForURL(/\/ncadb\/#\/teams$/, { timeout: 15_000 });
    const stillSignedIn = await mobile.locator('.account-trigger').waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check(stillSignedIn, 'mobile 320px: the section menu leads from an account page to Teams, still signed in');

    // 11. CSP: nothing on our origin was blocked at any point, except Clerk Protect's
    // in-page loader, which the policy refuses on purpose (see docs/AUTHENTICATION.md): it
    // needs a wildcard script origin and writes a token to localStorage, and every flow
    // above passed without it.
    const all = [anon, a, b, c, d, g, m].flatMap(x => x.problems);
    const protect = all.filter(p => /^CSP \S+ https:\/\/[^/]*protect\.clerk\.com\//.test(p));
    const problems = all.filter(p => !protect.includes(p));
    check(problems.length === 0, 'no CSP violations or uncaught errors on any page', problems.slice(0, 5).join(' | '));
    console.log(`  (Clerk Protect loader refused by the CSP ${protect.length} time(s), as intended)`);
} catch (err) {
    check(false, 'scenario completed', err.stack?.split('\n').slice(0, 3).join(' '));
} finally {
    for (const id of created) await clerk('DELETE', `/users/${id}`).catch(() => undefined);
    await browser.close();
    server.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
