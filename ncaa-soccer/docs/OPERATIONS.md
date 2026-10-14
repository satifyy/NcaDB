# Operations

All commands run from `ncaa-soccer/`. Locally they need `DATABASE_URL`; against
production, run them **inside the worker container** with `railway ssh --service worker`
(the database is only reachable on Railway's private network), or prefix with
`railway run --service worker` when a temporary TCP proxy is enabled (see the last
section). Every worker command is recorded in `ingestion_runs` and exits 0 on success,
1 on failure, 2 on a usage error.

## Routine

| Task | Command |
| --- | --- |
| Run tonight's ingestion now | `npm run worker -- nightly --force` |
| Same, for another season | `npm run worker -- nightly --force --season 2025` |
| Skip the analytics rebuild | add `--no-analytics` |
| Latest runs, failures, freshness, coverage | `npm run worker -- status` |
| One run in full (tasks, errors) | `npm run worker -- status --run 42` |
| Freshness check (alerts, exit 1 when stale) | `npm run worker -- health` |
| Trigger the cron service off-schedule | `railway cron --help` (Railway CLI) |
| Production health | `curl https://<api>/health` and `curl https://<api>/api/v1/status` |
| Data freshness, as the site shows it | `curl https://<api>/api/v1/data-status` |
| Admin run list | `curl -H "Authorization: Bearer $ADMIN_API_TOKEN" https://<api>/api/v1/admin/runs` |

## Backfills

Historical backfills share the nightly lock, so they never overlap a nightly run, and
are **resumable**: each season records success under a scope naming the exact request,
and re-running the same command skips seasons already done.

| Task | Command |
| --- | --- |
| Load the committed CSVs (no scraping, ~1 min for 2016–2026) | `npm run worker -- backfill --seasons 2016-2026 --from-csv .` |
| Scrape a season, missing box scores only (default) | `npm run worker -- backfill --season 2024` |
| Re-scrape everything for a season | `npm run worker -- backfill --season 2024 --force` |
| One team | `npm run worker -- backfill --season 2024 --team "Duke"` |
| A date range (box scores) | `npm run worker -- backfill --season 2024 --from 2024-10-01 --to 2024-10-31` |
| A single date | `... --from 2024-10-05 --to 2024-10-05` |
| Box scores only, no schedule scrape | add `--no-schedules` |

A full-season scrape is several hours with the server's polite defaults
(`SCRAPER_CONCURRENCY=3`, 30 s between requests to one school's site). Run long
backfills from a machine you control (`DATABASE_URL` pointed at the TCP proxy) or
inside the worker container with `nohup`.

## Corrections and failures

| Task | Command |
| --- | --- |
| Refresh one game (both schools' schedules + its box score) | `npm run worker -- refresh-game --game 20851` (the id from the API/URL) |
| Retry the most recent failed or abandoned run | `npm run worker -- retry` |
| Retry a specific run | `npm run worker -- retry --run 42` |
| See what a run rejected and why | `npm run worker -- status --run 42` → `errors` (category, code, count, samples) |
| Rebuild ratings/forecasts/dashboard files only | `npm run worker -- analytics` |

A run killed mid-way (deploy, OOM, timeout) leaves nothing half-written: loads are one
transaction per season, and the next run marks the dead run `abandoned` and alerts.
A stage that loses more than 3% of a season's rows is failed by the row guard and its
output is not loaded.

## Migrations

Applied automatically before each API deploy (Railway pre-deploy command). Manually:

```bash
npm run worker -- migrate
```

The worker refuses to run against a database with pending migrations.

## Alerts

Set `ALERT_WEBHOOK_URL` on the worker (Slack incoming webhook, Discord webhook, or any
endpoint accepting JSON `{text, content}`). Alerts fire on: failed or crashed run, run
terminated by a signal, runs found abandoned, no games after a nightly run, database
unreachable, and — checked at every cron firing — no successful sync for more than
`STALE_AFTER_HOURS` (36) during the season. Without a webhook, alerts are `warn` log lines.

## Rolling back

- **Code:** Railway → service → Deployments → *Redeploy* an earlier deployment, or
  `git revert` on main (both services and Vercel redeploy from main). Vercel: Deployments
  → *Promote to Production* on an earlier build.
- **Schema:** migrations are forward-only; ship a new migration that undoes the change.
  Take a dump first (DATABASE.md) if a migration rewrites data.
- **Data:** a bad load is fixed by re-running the corrected scrape (`backfill --force` or
  `refresh-game`); upserts overwrite. For anything worse, restore a backup (DATABASE.md).

## Direct database access

Postgres has no public endpoint by default. For a one-off operation from a laptop
(initial CSV load, `pg_dump`), enable a TCP proxy, use it, and remove it:

```bash
railway tcp-proxy --help                       # create one for the Postgres service
railway variable list --service Postgres --kv | grep DATABASE_PUBLIC_URL
DATABASE_URL="<DATABASE_PUBLIC_URL>" DATABASE_SSL=true npm run worker -- backfill --seasons 2016-2026 --from-csv .
# ...then delete the proxy again
```

## Cost controls

```bash
railway usage                                    # this billing period
railway usage limit set --target workspace --soft 30 --hard 50
```

The hard limit stops services when reached; the soft limit emails. Expected usage is in
[DEPLOYMENT.md](DEPLOYMENT.md#cost).
