# Deployment

| Piece | Where | Source | Deploys when |
| --- | --- | --- | --- |
| Postgres | Railway service `Postgres` (template), private network only | — | — |
| Migrate | Railway service `migrate`, root `ncaa-soccer`, `Dockerfile.api`; runs once and exits | GitHub `satifyy/NcaDB`, branch `main` | **manually**, by commit (below) |
| API | Railway service `api`, root `ncaa-soccer`, `Dockerfile.api` | same | **manually**, by commit, after `migrate` |
| Worker | Railway service `worker`, root `ncaa-soccer`, `Dockerfile.worker`, cron `0 8,9 * * *` | same | **manually**, by commit, after `migrate` (the image; it runs on the cron) |
| Dashboard | Vercel project `ncadb`, root `ncaa-soccer/apps/dashboard`, served at **https://satifyy.com/ncadb/** | same (Git integration connected) | **automatically**, on every merge to `main` |

Production URLs: site **https://satifyy.com/ncadb/** (proxied by the satifyy.com hub,
repo `satifyy/webpage`, see its `ROUTING.md`), origin `https://ncadb.vercel.app`; API
`https://api-production-24fc6.up.railway.app` (`/health`, `/api/v1/status`, `/api/v1/openapi.json`).

## Releasing (the tested procedure)

What actually happens on a merge, as observed on 2026-10-16 (PRs #43, #44, #46): the
Railway services track `main` but **no Railway deploy starts on a push**, not even after
CI passes; Vercel **does** build and promote the dashboard to production at once. So the
dashboard can go live before the API it calls: build UI changes to degrade gracefully
against an API that lacks their routes (a 404 is "not available yet", not an error).

1. CI green on the PR, then merge (merge commit, as the history uses).
2. Deploy `migrate` at the merge commit and wait for `SUCCESS`; its log lists the
   migrations it `applied`. Skip only when no migration changed.
3. Deploy `api` and `worker` at the same commit. A service whose code did not change can
   be left alone (the worker for a dashboard-only change).
4. Verify: `curl https://api-production-24fc6.up.railway.app/api/v1/status` shows the new
   `version` (the commit's first 12 characters) and `"pending_migrations":[]`.

```bash
E=b5bdf4e4-0330-4d4e-9c50-49a8ce74e2b6            # production environment
C=$(git rev-parse origin/main)                     # the merge commit
svc() { railway api 'query($e: String!) { environment(id: $e) { serviceInstances { edges { node { serviceName serviceId } } } } }' \
          --raw-var "e=$E" | jq -r ".data.environment.serviceInstances.edges[].node | select(.serviceName==\"$1\") | .serviceId"; }
deploy() { railway api 'mutation($s: String!, $e: String!, $c: String!) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e, commitSha: $c) }' \
          --raw-var "s=$(svc $1)" --raw-var "e=$E" --raw-var "c=$C"; }
deploy migrate   # wait: railway deployment list --service migrate  ->  SUCCESS; railway logs --service migrate
deploy api; deploy worker
railway deployment list --service api            # SUCCESS, then check /api/v1/status
```

Rolling back is the same call with the previous commit. Migrations are forward-only and
additive by convention, so the older code runs against the newer schema.

### Running worker and owner commands in production

The worker is a cron service: it has no running container to `railway ssh` into, and the
`api` container holds only the read-only role. One-off commands (`backfill-capture`,
`renormalize`, `team-of-week`) therefore run from a trusted machine through a temporary
TCP proxy to Postgres, as the **worker** role, and the proxy is removed afterwards:

```bash
railway tcp-proxy create --port 5432 --service Postgres        # note the endpoint
# DATABASE_URL = the worker's (railway variable list --service worker --kv) with host:port
# replaced by the proxy endpoint; keep it in a 0600 file, never on the command line.
railway run --service worker -- sh -c '. ./prod-worker.env; npm run worker -- status'
railway tcp-proxy delete <id> --service Postgres --yes
```

Owner commands (`reconcile-identities --apply`, `set-role`) need the owner URL instead:
the `migrate` service's `MIGRATION_DATABASE_URL`, rewritten the same way, exported as
`MIGRATION_DATABASE_URL` for that one command only.

## Railway

Created once with the CLI, then configured by a script (Railway's `railway.json`
config-as-code is deprecated, so settings are applied through its API):

```bash
cd ncaa-soccer
railway init --name ncadb
railway add --database postgres
railway add --service api    --repo satifyy/NcaDB --branch main
railway add --service worker --repo satifyy/NcaDB --branch main
scripts/railway/configure.sh --cors "https://<your-vercel-domain>,https://<project>-*-<team>.vercel.app"
railway domain --service api
```

`configure.sh` sets, per service:

| | api | worker |
| --- | --- | --- |
| Root directory | `ncaa-soccer` | `ncaa-soccer` |
| Dockerfile | `Dockerfile.api` (node:22-slim, no browser) | `Dockerfile.worker` (Playwright 1.57 + Chromium) |
| Pre-deploy | `npx tsx apps/worker/src/cli.ts migrate` | — |
| Start | `npx tsx apps/api/src/server.ts` | `npx tsx apps/worker/src/cli.ts nightly --cron` |
| Health check | `/health`, 120 s | — |
| Cron | — | `0 8,9 * * *` (UTC) |
| Restart | on failure, 5 retries | never (a cron job exits) |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (private) | same |

**Why two cron firings.** Railway cron is UTC. 03:00 America/Chicago is 08:00 UTC in
summer and 09:00 UTC in winter. Both fire; the worker proceeds only on the one that is
03:00 local (`NIGHTLY_LOCAL_HOUR`, `NIGHTLY_TIMEZONE`), runs anyway if the last success
is over 26 h old, and otherwise just checks freshness and exits. No edit at DST changes.

Environment variables: see `ncaa-soccer/.env.example` (server) and
`apps/dashboard/.env.example` (site). `ADMIN_API_TOKEN` is generated by the script;
read it with `railway variable list --service api --kv`. Add `ALERT_WEBHOOK_URL` on the
worker to receive alerts.

Initial data: the committed CSVs were loaded once through a temporary TCP proxy
(`backfill --seasons 2016-2026 --from-csv .`, 3 min), and the proxy was then deleted.

## Vercel and satifyy.com

The dashboard is its own Vercel project (`ncadb`, scope `santy0629-8466s-projects`) and
is **served only through the satifyy.com hub**: `satifyy/webpage`'s `vercel.json` redirects
`/ncadb` → `/ncadb/` and rewrites `/ncadb/:path*` → `https://ncadb.vercel.app/:path*`
(the hub deploys from its `production` branch). The browser only ever sees satifyy.com.

| Setting | Value |
| --- | --- |
| Root Directory | `ncaa-soccer/apps/dashboard` (files outside the root included — it is an npm workspace) |
| Framework / install / build / output | Vite; from `apps/dashboard/vercel.json` |
| Env `BASE_PATH` | `/ncadb` — Vite `base`, so assets resolve under the hub's prefix |
| Env `VITE_API_BASE_URL` | `https://api-production-24fc6.up.railway.app` (public by design; no secrets on Vercel) |
| Deployment Protection | **off** — required, or the hub proxies Vercel's login wall |

The API's `CORS_ALLOWED_ORIGINS` is `https://satifyy.com,https://www.satifyy.com,https://ncadb.vercel.app`.

Production deploys come from the Git integration (production branch `main`). A manual
deploy from the repo root is still possible (`.vercelignore` keeps the data CSVs out of the
upload); a raw `*.vercel.app` preview needs `--build-env BASE_PATH=/`:

```bash
npx vercel deploy --prod --scope santy0629-8466s-projects
```

## CI/CD

- `.github/workflows/ci.yml` — every PR and push to main: typecheck, unit tests, Postgres
  integration tests (migrations from scratch, loader, API, worker CLI), inventory
  validation, dashboard lint and build, gitleaks secret scan.
- Vercel's GitHub integration deploys the dashboard on every merge to `main` and builds a
  preview for every PR. Railway does not deploy on push: releases are deployed by commit
  (see *Releasing*). Protect `main` (require the CI checks) so only reviewed, green code
  reaches production; feature branches never touch the Railway production environment.
- `.github/workflows/refresh.yml` is the legacy CSV refresh, now manual-only.

## Cost

Measured footprint: database ≈ 360 MB for 2016–2026; worker ≈ 1 h a night in season
with Chromium (~1–1.5 GB RAM); API idles at ~100–150 MB.

Estimate at Railway's published Hobby rates (RAM $10/GB-month, vCPU $20/vCPU-month,
volume $0.15/GB-month, egress $0.05/GB):

| Item | Assumption | ≈ / month |
| --- | --- | --- |
| Postgres | 0.25 GB RAM, light CPU, 1 GB volume | $3 |
| API | 0.15 GB RAM, light CPU | $2 |
| Worker | 30 × 1 h × 1.5 GB, ~1 vCPU while running | $1.5 |
| Egress | a few GB of API responses | < $0.5 |
| **Railway total** | Hobby includes $5 of usage in its $5 fee | **≈ $5–10** |
| Vercel | Hobby (personal, non-commercial) | $0 |

These are estimates, not guarantees; read actual usage with `railway usage`. Cap it:

```bash
railway usage limit set --target workspace --soft 30 --hard 50
```
