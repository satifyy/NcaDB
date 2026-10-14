# Security

Assessment and hardening of the NCADB production platform (2026-10-13), the threat
model it was done against, and the runbook for operating it. Status words mean what they
say: **verified** = observed working (tests or production), **implemented** = in code,
not yet deployed, **open** = not addressed.

## Architecture and trust boundaries

```
                     PUBLIC INTERNET
  browsers ──HTTPS──▶ satifyy.com (Vercel hub, satifyy/webpage)
                         │ /ncadb/* rewrite (server-side proxy)
                         ▼
                     ncadb.vercel.app ── static bundle only; CSP: connect-src = API
                                         no secrets, no source maps
  browsers ──HTTPS──▶ api-production-24fc6.up.railway.app  (Railway edge, TLS)
                         │  rate limit · CORS allowlist · validation · headers
  school athletics       │  admin routes: bearer token, audited, read-only
  sites (untrusted) ◀──┐ │
                       │ │ ─────────────── RAILWAY PRIVATE NETWORK ───────────────
                       │ ▼
           worker (cron, no inbound)   api (ncadb_api: SELECT, 5 s)     migrate (runs once
           ncadb_worker: DML, no DDL       │                            per deploy, exits)
           URL guard · Chromium blocks     │                            owner credentials,
           internal names · no eval        ▼                            role passwords
                       └──────────────▶ Postgres (no public endpoint) ◀──────┘
  operators ── Railway CLI/dashboard (account MFA) ── worker CLI, railway ssh, logs
  GitHub ── CI (read-only token, pinned actions, audit, CodeQL, gitleaks) ── no deploy secrets
```

Secret boundaries: owner DB credentials exist only in the Postgres service and the
`migrate` service; role passwords only in `migrate` (referenced by api/worker as
variables); the admin token only in `api`; nothing secret in Vercel, GitHub, the
repository or the browser bundle.

## Findings

| # | Severity | Finding | Component | Remediation | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | **Critical** | Scraped page text executed with `new Function()`; the last fallback ran a page's entire inline script. Any compromised athletics site → code execution in the worker, which holds DB credentials. | `parsers/sidearm/schedule.ts` | Data-only `parseJsLiteral`; whole-script fallback removed | Implemented; tests prove payloads are not executed; golden fixtures unchanged |
| 2 | **High** | SSRF: box-score URLs from third-party pages opened by Chromium inside Railway's private network (Postgres, API reachable; no URL policy) | box-score stage, WMT clients | `url_guard`: scheme/port/credential/internal-host policy, school-domain allowlist (99.7% of 31,188 historical links on school domains), DNS → public-only, redirect re-validation, Chromium resolver rules + sub-request blocking, response size caps | Implemented; unit-tested |
| 3 | **High** | API and worker connected as the `postgres` superuser | Railway variables | Migration 002: `ncadb_api` (read-only, 5 s), `ncadb_worker` (DML only); owner creds only in the `migrate` service | Implemented; privilege tests pass against real Postgres; **production cutover awaiting approval** |
| 4 | **High** | 14 high-severity dependency advisories (axios SSRF/NO_PROXY, undici decompression, vite/rollup path traversal, …) | npm lockfile | `npm audit fix`, csv-parse 7 | Verified: `npm audit` 0 vulnerabilities; CI fails on high |
| 5 | **High** | `main` unprotected; GitHub secret scanning and push protection off on a public repo | GitHub | Recommend protection (require PR + CI); enable secret scanning + push protection | **Awaiting approval** (repository settings) |
| 6 | Medium | A whole-season load could delete any number of stored rows (the row guard only covers the scrape path) | loader | Refuses deleting > 5% (min 25) of a season's schedule rows without `--allow-mass-delete` | Implemented; tested |
| 7 | Medium | No security headers on API or site; no CSP | API, Vercel | API: CSP `default-src 'none'`, HSTS, nosniff, DENY, no-referrer, CORP. Site: strict CSP (self + API), HSTS, nosniff, DENY, COOP | API implemented + tested; site CSP verified on all 9 views with 0 violations and blocked injection attempts |
| 8 | Medium | Statement timeout 120 s for public reads; pool setting overrode role defaults; unbounded page depth | API, pool | 5 s for API; pool no longer overrides role defaults; page ≤ 500; body limit 1 KB; request timeouts | Implemented; tested |
| 9 | Medium | Third-party actions on mutable tags; workflow token permissions implicit | CI | SHA-pinned actions, `permissions: contents: read`, dependency review, CodeQL, Dependabot | Implemented |
| 10 | Low | Admin routes listed in public OpenAPI; failed admin auth not logged | API | Hidden; `security.admin_auth_failed` / `security.admin_access` / `security.rate_limited` log events; admin limit 30/min | Implemented; tested |
| 11 | Low | Image code writable by the runtime user | Dockerfiles | `chmod -R a-w /app`; writes only to `/tmp` | Implemented; verify on next production run |
| 12 | Info | Gitleaks reported 67 "secrets" in history | repo | All are public reCAPTCHA site keys inside saved third-party HTML, plus one column name. **No NcaDB credential has ever been committed** — no rotation needed. Allowlisted narrowly | Verified: full-history scan clean |

Verified not vulnerable: rate limiting cannot be bypassed by spoofing `X-Forwarded-For`
(Railway's edge overwrites it — tested against production); Postgres has no TCP proxy
or domain; only the API has a public domain; no `shell: true`/`exec` with untrusted
arguments (child processes take argument arrays); raw-page filenames are sanitised;
React escapes all scraped strings (no `dangerouslySetInnerHTML`); the built bundle
contains no internal hostnames, credentials or source maps; the API has no write
routes — ingestion can only be started from the worker CLI with Railway access.

## Threat model

| Threat | Controls |
| --- | --- |
| Unauthorized DB access | No public endpoint; private network only; per-service roles; owner creds isolated in `migrate`; CREATE revoked from PUBLIC |
| Stolen credentials | Secrets only in Railway variables, generated by script, never printed or committed; gitleaks in CI and history; rotation runbook below |
| API abuse / scraping of our API | 300 req/min/IP (unspoofable), bounded pages/sizes, 5 s statements, CDN caching headers, Railway resource caps |
| SQL injection | Parameterised queries throughout; sort keys from whitelists; tested with injection payloads |
| XSS | React escaping; strict CSP (no inline/eval, connect-src = API); API responses `default-src 'none'` + nosniff |
| SSRF | URL guard + allowlist + DNS check + redirect checks; Chromium cannot resolve internal names |
| Malicious source responses | No eval; size caps; strict validation before writes; rejects counted and reported |
| Compromised dependencies | Lockfile + `npm ci`; audit gate; dependency review; Dependabot; CodeQL |
| Unauthorized ingestion | No HTTP trigger; worker has no inbound port; Railway account access required |
| Accidental data destruction | Per-season transactions; idempotent upserts; mass-deletion guard; worker cannot DROP/TRUNCATE/ALTER; committed CSVs as an independent restore source |
| Denial of service | Rate limits, timeouts, body limit, resource caps, Railway usage limit (recommended) |
| CI/CD supply chain | Pinned actions, read-only tokens, no deploy secrets in CI, PRs from forks get no secrets |

## Security test report

| Suite | Covers | Result |
| --- | --- | --- |
| `apps/scraper/src/tests/url_guard.test.ts` | private/metadata/Railway addresses, internal names, schemes, credentials, ports, allowlist, DNS refusal, redirect into private network, oversized bodies (declared and streamed), Chromium sub-request policy, payloads never executed | 9/9 pass |
| `packages/database/test/privileges.test.ts` | worker can load and refresh; API can read; API cannot INSERT/UPDATE/DELETE/CREATE/DROP or refresh; worker cannot CREATE/DROP/ALTER/TRUNCATE, touch the migration ledger or reference data, or create roles; 5 s API timeout; mass-deletion refused and rolled back, override works | 5/5 pass |
| `apps/api/test/security.test.ts` | SQLi payloads on every parameter, LIKE wildcards, stored XSS returned inert, headers on all responses incl. errors, admin auth (6 bad token forms), no write methods, oversized/invalid input, bounded pagination, no internals in errors, CORS lookalike origins, rate limiting | 11/11 pass |
| Regression | all previous unit, integration and E2E tests | 105 unit + 48 DB/API/E2E pass |
| Frontend | CSP on every view (0 violations); injected inline script, external image and fetch blocked | pass |
| Static | `npm audit` 0; gitleaks full history clean; CodeQL runs in CI | pass |

Limitations: the URL guard's DNS check runs before navigation, so a host that changes
its DNS answer between check and use is mitigated only by Chromium's resolver rules
(internal names) — not for arbitrary private IPs behind public names. No load test was
run against production. Penetration testing was limited to controlled requests.

## Residual risks

- **Admin access is a shared bearer token**, not an identity provider with MFA. The
  admin routes are read-only, rate-limited and audited, which limits the impact; moving
  them behind Cloudflare Access (as `trader.satifyy.com` already is) is the recommended
  next step.
- **Railway account compromise** is game over for any Railway-hosted system; enable MFA
  on the Railway, Vercel and GitHub accounts and review collaborators periodically.
- **Pages rendered in Chromium execute third-party JavaScript** (that is how Sidearm
  pages render). It runs in the browser sandbox with internal names unresolvable, not in
  Node — but a Chromium sandbox escape would land in the worker container.
- **Logs** are Railway's (retention per plan); there is no external SIEM. Security
  events are distinguishable by the `event: security.*` field.
- **Backups**: enable Railway's scheduled Postgres backups; a restore drill into a
  scratch database is documented but has not been run against a production backup.

## Runbook

**Rotate a database role password** (no downtime for the role not being rotated):
```bash
openssl rand -hex 32 | railway variable set NCADB_WORKER_DB_PASSWORD --stdin --service migrate --skip-deploys
# redeploy migrate (sets the new password), then redeploy worker (reads it)
```
**Rotate the owner password**: Railway Postgres service → Variables → regenerate
`POSTGRES_PASSWORD`/`PGPASSWORD` per Railway's docs, then redeploy `migrate`.
**Rotate the admin token**: `openssl rand -hex 24 | railway variable set ADMIN_API_TOKEN --stdin --service api` (redeploys the API; old token stops working).
**Emergency revocation of admin access**: `railway variable delete ADMIN_API_TOKEN --service api` — the admin routes disappear entirely on redeploy.
**Investigate suspicious activity**: `railway logs --service api --json | jq 'select(.event? // "" | startswith("security."))'`; `npm run worker -- status`; check `ingestion_errors` for unusual codes; compare `data-status` coverage with the previous day.
**Failed ingestion**: OPERATIONS.md → *Corrections and failures*. A `blocked URL (...)` skip in a run's errors is the SSRF guard working, not a scraper failure; a `MassDeletionError` means a load tried to remove a large part of a season — investigate before re-running with `--allow-mass-delete`.
**Database recovery**: DATABASE.md → *Backups and restore*; worst case, rebuild from the committed CSVs (`backfill --from-csv`).
**Deployment rollback**: OPERATIONS.md → *Rolling back*. Railway deploys only explicit commits (`serviceInstanceDeployV2`), so redeploying the previous SHA is the rollback.
