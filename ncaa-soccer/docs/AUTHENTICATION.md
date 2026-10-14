# Authentication and accounts

Accounts are optional: every statistic stays public. A signed-in reader can save teams
and players, keep preferences, and (if an operator has made them an administrator) see
the operations console.

## Architecture

```
browser (satifyy.com/ncadb/…)                 Clerk (clerk.satifyy.com, accounts.satifyy.com)
 ├─ clerk-js, headless ──── session cookies ──┤  hosted sign-in / sign-up / account pages:
 │   (no UI, no styles)                       │  email + password, email codes, Google,
 │                                            │  verification, recovery, lockout, new-device
 │                                            │  checks, bot protection
 └─ fetch + Authorization: Bearer <60 s session token>
        │
        ▼
 Railway API (Fastify) ── verifies the token (signature, iss, azp, exp/nbf/iat, sid, sts)
   ├─ public routes ──────── ncadb_api       (read-only, sports data)
   └─ /api/v1/me, /admin ─── ncadb_accounts  (accounts schema; role column read-only)
                              ncadb_api       (admin reads of ingestion data)
 Railway worker ───────────── ncadb_worker   (sports data + maintenance queue; no accounts)
```

**Provider: Clerk.** It has a first-party React SDK that works with this Vite single-page
app and a backend verifier for Node, and it supplies everything the requirements list
(email and password, email codes, Google OAuth, verified addresses, recovery, session
lifetime and renewal, lockout after repeated failures, bot protection) without our
storing a credential. Auth0 and Cognito would do the same with more integration code;
Supabase or Firebase Auth would bring a second data platform.

**Clerk runs headless on our pages** (`prefetchUI={false}` in `src/auth/session.tsx`).
Credentials are typed only on Clerk's hosted Account Portal. Clerk's embedded components
would need `style-src 'unsafe-inline'` and Cloudflare Turnstile frames on our origin,
which the site's CSP refuses. The site's own pages (`/ncadb/login`, `/ncadb/signup`) are
branded hand-offs that send the browser to the hosted page and name the return address
(`/ncadb/dashboard`).

**Sessions.** Clerk keeps the session in its own cookies; the long-lived one is HttpOnly
on the Clerk domain. Its session token is a JWT valid for 60 seconds, re-minted in the
background while the session lives. Nothing is written to localStorage (verified by the
end-to-end test). The API reads no cookies and sets none, and accepts the token only in
the `Authorization` header, so a cross-site page cannot make a browser send a credential
to it. That is why the write routes need no CSRF token. CORS allows the site's origins
only, without credentials mode.

**Token checks** (`apps/api/src/auth.ts`): Clerk's `verifyToken` checks the RS256
signature (networkless with `CLERK_JWT_KEY`, or JWKS fetched with `CLERK_SECRET_KEY`),
`exp`/`nbf`/`iat` with a 5 s skew, and `azp` against `CLERK_AUTHORIZED_PARTIES`. We
additionally require `iss` to equal `CLERK_ISSUER`, a well-formed `sub`, a `sid`, and an
active session (`sts`). Clerk session tokens carry no `aud`, so none is checked. A
half-configured verifier (no issuer, no authorized parties, or an `http` issuer) refuses
to start.

**Authorization** is the `role` stored in `accounts.user_profiles`, read on every request.
Claims in the token, and anything the browser says, are never consulted. Nobody becomes
an administrator by signing up, including the first user.

## Database

Migrations `003_user_accounts.sql` and `004_maintenance_requests.sql`. The sports schema
is unchanged.

| Table | Key | Notes |
| --- | --- | --- |
| `accounts.user_profiles` | `UNIQUE (auth_provider, auth_subject)` | Clerk user id, display name, `role` (`user`/`admin`) |
| `accounts.user_favorite_teams` | `PRIMARY KEY (user_id, team_id)` | FK to `public.teams`, cascade on either side |
| `accounts.user_favorite_players` | `PRIMARY KEY (user_id, player_id)` | FK to `public.players` |
| `accounts.user_preferences` | `user_id` | default season, default view, favorites first |
| `accounts.user_activity_audit` | `id` | append-only; `user_id` set NULL (not deleted) when a profile is |
| `public.maintenance_requests` | one open request per (action, target) | admin requests the worker carries out |

No password, token or provider secret is stored anywhere in PostgreSQL. Email addresses
are not copied from Clerk either: the API never needs them.

### Permission boundaries

User data is in its own schema, `accounts`. Migration 002's default privileges on `public`
would otherwise have granted every new table to `ncadb_api` and `ncadb_worker`.

| | sports data | `accounts.*` | `role` column | audit trail | `maintenance_requests` | DDL |
| --- | --- | --- | --- | --- | --- | --- |
| `ncadb_api` | read | **no access** | — | — | read | no |
| `ncadb_worker` | read/write | **no access** | — | — | read/write | no |
| `ncadb_accounts` | read `teams`, `players` only | read/write own tables | **cannot write** | insert only | insert, read | no |
| owner (migrate) | all | all | via `roles.ts` only (audited) | all | all | yes |

No application role is a superuser or can create roles or databases, replicate, or bypass
RLS. `packages/database/test/accounts.test.ts` checks every row of this table by
connecting as each role.

Users can only reach their own rows because no route takes a user id: every query is
keyed by the profile resolved from the verified token.

### Provisioning an administrator

Only the database owner can change `role`, and only through `apps/worker/src/roles.ts`,
which writes every change and its reason to `accounts.user_activity_audit` in the same
transaction.

**Normal path: the list on the migrate service.** The migrate service (the only holder
of owner credentials) runs `sync-admins` after `migrate` and `provision-roles` on every
deploy. It makes the administrators exactly the Clerk user ids in `NCADB_ADMIN_SUBJECTS`:

```bash
railway variable set --service migrate --skip-deploys \
  'NCADB_ADMIN_SUBJECTS=user_2abc…,user_2def…' \
  'NCADB_ADMIN_CHANGE_REASON=Grant ops access to <name>, approved by <name>'
# then deploy migrate at the commit production runs (see DEPLOYMENT.md)
```

- Removing an id demotes that person on the next migrate deploy.
- An id whose owner has not signed in yet is reported as pending and promoted once they
  have.
- **Unset** leaves roles alone (a missing variable never demotes everyone). An **empty**
  value demotes everyone, on purpose.
- The audit row names the Railway deployment (`migrate:<RAILWAY_DEPLOYMENT_ID>`), and
  Railway's activity log records who changed the variable.

A person's Clerk user id is in the Clerk dashboard (Users), and on `/ncadb/profile` once
they are signed in (`GET /api/v1/me` → `user_id`).

**Break-glass or local:** `npm run worker -- set-role --subject user_… --role admin
--reason "…" --actor "<you>"` with `MIGRATION_DATABASE_URL` set to an owner connection.
In production that connection exists only inside Railway's private network, so this is
for local or restored databases; use the list above in production.

### Admin maintenance

`/ncadb/admin` shows ingestion runs, failed tasks and data issues. An administrator can
request **retry a failed or abandoned run** or **rebuild analytics**, with a reason and an
explicit confirmation. The API only records the request (audited, rate-limited, one open
request per target); the worker carries it out after its next scheduled run, using the
same code as the `retry` and `analytics` CLI commands, after checking the target again.
No HTTP request starts a scrape. Run pending requests immediately with
`npm run worker -- maintenance`.

## Routes

| Path | |
| --- | --- |
| `/ncadb/login`, `/ncadb/signup` | hand-off to Clerk's hosted pages; back to `/ncadb/dashboard` |
| `/ncadb/dashboard` | saved teams (with latest record) and players |
| `/ncadb/profile` | display name, favorites, preferences, account security link, sign out, delete data |
| `/ncadb/admin` | operations console (server-side `admin` check) |

These are real paths, rewritten to `index.html` by `apps/dashboard/vercel.json`. The
statistics stay hash-routed (`/ncadb/#/teams/duke`). `satifyy.com`'s hub already proxies
`/ncadb/:path*` to the Vercel project.

API (all `Cache-Control: no-store`, 401 without a valid session, 503 while sign-in is off):
`GET/PATCH/DELETE /api/v1/me`, `PUT /api/v1/me/preferences`,
`GET /api/v1/me/favorites/{teams,players}`,
`PUT/DELETE /api/v1/me/favorites/teams/:idOrSlug`, `PUT/DELETE /api/v1/me/favorites/players/:id`,
`GET /api/v1/admin/whoami`, `GET/POST /api/v1/admin/maintenance` (plus the existing
admin reads, which now also accept an administrator's session).

## Content Security Policy

Added to the site's policy, and nothing else:

- `script-src` and `connect-src`: `https://clerk.satifyy.com` (the Clerk Frontend API).
- `worker-src 'self' blob:`: clerk-js runs its token-refresh timers in a worker so they
  are not throttled in background tabs.

Still refused: `'unsafe-inline'` anywhere, frames, Clerk's avatar images (initials are
shown instead), and **Clerk Protect's in-page loader** (`cdn.protect.clerk.com`, then
randomized `*.client.protect.clerk.com` hosts). Allowing it would need a wildcard script
origin and it writes a token to localStorage. Bot protection still applies on the hosted
pages, where every credential is entered, and every flow passes with it refused. The
browser logs those refusals as CSP violations; they are expected.

## Configuration

### Environment variables

| Where | Variable | |
| --- | --- | --- |
| Vercel (`ncadb`) | `VITE_CLERK_PUBLISHABLE_KEY` | `pk_live_…`; public by design |
| Railway `api` | `CLERK_JWT_KEY` | PEM public key (preferred, networkless) |
| Railway `api` | `CLERK_SECRET_KEY` | only if no `CLERK_JWT_KEY`; **secret** |
| Railway `api` | `CLERK_ISSUER` | `https://clerk.satifyy.com` |
| Railway `api` | `CLERK_AUTHORIZED_PARTIES` | `https://satifyy.com` |
| Railway `api` | `ACCOUNTS_DATABASE_URL` | `ncadb_accounts` on the private network |
| Railway `api` | `ACCOUNTS_DATABASE_POOL_MAX` | default 5 |
| Railway `migrate` | `NCADB_ACCOUNTS_DB_PASSWORD` | 24+ chars, generated by `configure.sh`; applied by `provision-roles` |
| Railway `migrate` | `NCADB_ADMIN_SUBJECTS` | Clerk user ids of administrators; unset = unchanged |
| Railway `migrate` | `NCADB_ADMIN_CHANGE_REASON` | recorded in the audit trail with each change |

`CORS_ALLOWED_ORIGINS` already includes `https://satifyy.com`. No secret key ever goes in
a `VITE_` variable.

### Clerk (one-time, in the Clerk dashboard)

1. Create a **production** instance with domain `satifyy.com`. Add the DNS records Clerk
   lists, with **DNS only (grey cloud)** in Cloudflare: `clerk` → `frontend-api.clerk.services`,
   `accounts` → `accounts.clerk.services`, and the `clkmail`, `clk._domainkey`,
   `clk2._domainkey` mail records. Wait for Clerk to show them verified and issue certificates.
2. **User & authentication**: email address required and verified (email code); password
   on; Google enabled. For production Google, create an OAuth client in Google Cloud
   (Web application) with Clerk's **Authorized redirect URI**
   (`https://clerk.satifyy.com/v1/oauth_callback`) and paste its client id and secret into
   Clerk. Clerk's shared development credentials do not work in production.
3. **Attack protection**: keep user lockout on (10 attempts / 60 min by default), turn on
   bot protection and email enumeration protection, keep "client trust" (new-device
   verification) on.
4. **Sessions**: maximum lifetime (for example 7 days) and an inactivity timeout (for
   example 24 h). Session tokens stay at 60 s.
5. **Paths / Account Portal**: allowed redirect URLs `https://satifyy.com/ncadb/*`; after
   sign-in and sign-up `https://satifyy.com/ncadb/dashboard`; after sign-out
   `https://satifyy.com/ncadb/`. Brand the portal with the site's name and logo.
6. **API keys**: copy the publishable key (Vercel) and the JWT public key (Railway API).

## Rollout (needs authorization; nothing below has been applied to production)

1. Merge the PR into `main` (CI: unit, database/API, smoke).
2. Re-run `scripts/railway/configure.sh` (idempotent): generates
   `NCADB_ACCOUNTS_DB_PASSWORD`, sets `ACCOUNTS_DATABASE_URL` on the API and adds
   `sync-admins` to the migrate start command, all with `--skip-deploys`. Deploy migrate at
   the `main` commit: it applies 003 and 004 (additive; tested on a populated 002 database)
   and sets the new role's password.
3. Railway `api`: set the `CLERK_*` and `ACCOUNTS_DATABASE_URL` variables with
   `--skip-deploys`, deploy the same commit. Check `/api/v1/me` → 401 (not 503).
4. Railway `worker`: deploy the same commit (maintenance processing).
5. Vercel: set `VITE_CLERK_PUBLISHABLE_KEY` for Production, deploy from `main`.
6. Verify on https://satifyy.com/ncadb/: a real sign-up and Google login, a favorite saved
   and still there after reload, a protected API request with that session, logout, and
   `/ncadb/admin` refused. Then provision the first administrator through
   `NCADB_ADMIN_SUBJECTS` and a migrate deploy, and check `/ncadb/admin` works for them.

Rollback: unset `VITE_CLERK_PUBLISHABLE_KEY` and redeploy the site (accounts disappear
from the UI); unset `CLERK_JWT_KEY`/`CLERK_SECRET_KEY` on the API (user routes answer
503). The tables can stay; nothing else reads them.

## Tests

| Suite | What |
| --- | --- |
| `apps/api/test/auth.test.ts` (15) | forged, expired, not-yet-valid, wrong-issuer, wrong-`azp`, pending, `alg: none` and HS256 tokens refused; first sign-in is a `user`; role claims ignored; favorites idempotent and bounded; cross-user isolation; admin 403/200 and audit; maintenance validation; account deletion; CORS; disabled and half-configured modes |
| `packages/database/test/accounts.test.ts` (8) | upgrade from a populated 002 database; role attributes; every permission boundary above, as each role; duplicate favorites refused by the schema; audited role changes and `sync-admins`; worker maintenance processing |
| `apps/dashboard/scripts/smoke.mjs` | account route with sign-in off |
| `apps/dashboard/scripts/auth-e2e.mjs` (48 checks) | against a real Clerk development instance and a real API and database: registration with email verification, password login with new-device verification, email-code login, the Google hand-off, logout and server-side session end, renewal, token expiry, isolation, admin refusal and audited promotion, maintenance request, persistence of favorites, localStorage, CSP, rewrites, 390 px layouts |

Run the end-to-end suite with a Clerk **development** instance (the script refuses an
`sk_live_` key) as described at the top of `auth-e2e.mjs`.

## Residual risks

- **Not yet proven in production.** Everything above ran against a Clerk development
  instance locally. A real production login and protected request on satifyy.com are the
  last step of the rollout and must be done before calling it complete.
- **Google login was verified only to the hand-off** to accounts.google.com; finishing it
  needs a real Google account.
- **A signed-out token lives up to 60 s.** Session tokens are stateless; after logout or
  revocation the last one is accepted until it expires (verified by the end-to-end test).
  Acceptable for favorites; an action that cannot tolerate it would need a session lookup.
- **Clerk is a dependency** for signing in (not for reading statistics). If Clerk is down,
  the account menu hides itself and the statistics keep working.
- **Bundle size**: `@clerk/react` adds about 29 KB gzipped even with sign-in off.
- **Admin role is cached per request only**, so a revoked administrator loses access on
  their next request. Their already-loaded admin page stays visible until they reload.
