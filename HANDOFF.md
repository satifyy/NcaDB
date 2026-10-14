# Handoff — state as of 2026-10-14 ~04:00 UTC

Work in progress; delete this file once the items below are done.

## Branches and PRs (stacked; all pushed)

`main` ← `feature/production-data-platform` (PR #21) ← `security/production-hardening` (PR #22) ← `fix/frontend-blank-page` (PR #23).
Merge in that order. `main` is protected: PR + green `build-and-test` and `secrets` checks.

## What is live

| Piece | Where | Running code |
| --- | --- | --- |
| Site | https://satifyy.com/ncadb/ (Vercel project `ncadb`, proxied by `satifyy/webpage`) | `fix/frontend-blank-page` |
| API | https://api-production-24fc6.up.railway.app — DB role `ncadb_api` | `security/production-hardening` @ d0d28fc |
| Worker | Railway cron `0 8,9 * * *` — DB role `ncadb_worker` | `security/production-hardening` @ 0f87cef |
| Migrate | Railway service, runs once per deploy, owner credentials | `security/production-hardening` |
| Postgres | Railway, private only (no TCP proxy) | — |

Railway services have **no Git deploy triggers** (Railway's GitHub app has no access to this
repo). They deploy only an explicit commit:

```bash
railway api 'mutation($s: String!, $e: String!, $c: String) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e, commitSha: $c) }' \
  --raw-var s=<service id> --raw-var e=b5bdf4e4-0330-4d4e-9c50-49a8ce74e2b6 --raw-var c=<full sha>
```

Service ids: api `b5abab80-0105-4197-8e0b-4d8b8e01781c`, worker `6a767159-e798-476c-81db-8850e4293fd3`,
migrate `c81571d7-b9aa-47d9-a82e-b51edd1d39f5`, Postgres `079feaa9-aa51-41b8-ba72-25b58d1fee02`.
**Do not change a variable without `--skip-deploys`**: a variable-triggered redeploy builds `main`,
which has no Dockerfile yet, and fails.

## Open items, in order

1. **Verification run in flight** (worker @ 0f87cef, started ~03:55 UTC). The previous run
   (#4) loaded data fine as `ncadb_worker` but failed in analytics with EACCES — fixed in
   0f87cef. Check it: `railway cron list --service worker` and `curl <api>/api/v1/data-status | jq '.recent_runs[0]'`.
2. **Then redeploy the worker** at 0f87cef (command above). `NIGHTLY_RECOVERY_AFTER_HOURS` has
   been set back to 26 with `--skip-deploys`, but the deployed snapshot still has 0, which
   makes both cron firings run each night until the redeploy.
3. Grant the Railway and Vercel GitHub apps access to `satifyy/NcaDB` (GitHub → Settings →
   Applications), then create Railway deploy triggers on `main` and `npx vercel git connect`.
4. Merge #21 → #22 → #23 into `main`, then point everything at `main`.
5. Optional: `ALERT_WEBHOOK_URL` on the worker; Railway usage limit (workspace-wide — affects
   other projects); Cloudflare Access in front of admin routes.

## Docs

`ncaa-soccer/docs/`: ARCHITECTURE, DATABASE, DEPLOYMENT, OPERATIONS, SECURITY.
Re-applying Railway settings: `ncaa-soccer/scripts/railway/configure.sh` (idempotent, never prints secrets).

## New computer setup

```bash
git clone https://github.com/satifyy/NcaDB && cd NcaDB/ncaa-soccer && git checkout fix/frontend-blank-page
npm ci
npm i -g @railway/cli && railway login && railway link   # project "ncadb", environment production
npx vercel login && (cd .. && npx vercel link --project ncadb)   # scope santy0629-8466s-projects
npm test                                                  # unit tests
TEST_DATABASE_URL=postgres://... npm run test:db          # needs a disposable Postgres
```
