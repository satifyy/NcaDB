# Architecture

NCADB collects NCAA Division I men's soccer schedules and box scores from each school's
athletics site, stores them in PostgreSQL, and serves them to a dashboard.

```
                       ┌──────────────────────── Railway project "ncadb" ────────────────────────┐
                       │                                                                          │
 school athletics      │   worker (cron 0 8,9 * * * UTC)              Postgres (private network)  │
 sites (Sidearm,  ◀────┼── apps/worker ── spawns ──▶ apps/scraper      ┌──────────────────────┐    │
 WMT, WordPress)       │      │   (existing pipeline stages, Playwright)│ games, game_sources  │    │
 robots: Crawl-delay   │      │                                         │ players, stats       │    │
 honoured, identified  │      ├── hydrate CSVs ◀── export ──────────────│ team_game_stats      │    │
 User-Agent            │      ├── validate + upsert (1 txn / season) ──▶│ ingestion_* , sync   │    │
                       │      └── analytics (ratings, forecasts) ──────▶│ derived_artifacts    │    │
                       │                                                 └──────────▲───────────┘    │
                       │   api (always on, /health) ── read-only SQL ──────────────┘                │
                       │      apps/api  ── https://<api>.up.railway.app                             │
                       └──────────────────────────────▲───────────────────────────────────────────┘
                                                      │ JSON over HTTPS (CORS-restricted)
                              Vercel ── apps/dashboard (static React + Vite, hash routes)
                                                      ▲
                                                   browsers
```

## Components

| Component | Code | Runs as | Does |
| --- | --- | --- | --- |
| Scrapers | `apps/scraper`, `packages/parsers`, `packages/storage` | child processes of the worker | Unchanged pipeline stages: fetch schedules, fetch box scores, aggregate, ratings, predictions, dashboard files. CSV in, CSV out. |
| Database | `packages/database` | library | Schema migrations, idempotent season loader, run bookkeeping, coverage metrics, CSV export. |
| Worker | `apps/worker` | Railway cron service | `nightly`, `backfill`, `refresh-game`, `retry`, `analytics`, `status`, `health`, `migrate`. |
| API | `apps/api` | Railway web service | Read-only JSON API + OpenAPI; admin routes behind a bearer token. |
| Dashboard | `apps/dashboard` | Vercel static site | Existing analytics views (now fed by the API) plus Teams, Games, Players and Data status. |

## Why the scrapers write CSV and the worker loads it

The scraping pipeline is the most valuable and most battle-tested part of the project:
it merges two schools' versions of each fixture, skips box scores already collected,
keeps rows a transient failure would otherwise lose, refuses a stage that shrinks a
season (the row guard), and checks a season is published before scraping it. Rewriting
that around a database would discard all of it.

So the worker builds a scratch tree for each run: it exports the season's stored rows
to the CSV files the scrapers expect, runs the stages against it, then validates what
they wrote and upserts it. The database is what persists between runs; the container's
filesystem is disposable.

## Nightly run

1. Railway starts the worker at 08:00 and 09:00 UTC. The worker proceeds only for the
   firing that is 03:00 in America/Chicago (DST-safe), or if the last successful night
   is more than 26 h old (missed-run recovery). The other firing runs a freshness check.
2. Take the Postgres advisory lock (a second run records itself `skipped` and exits).
   Mark runs left `running` by a dead process as `abandoned`.
3. Outside August–December: record the run and exit.
4. Hydrate the current season, run `schedules` and `boxscores` with `--incremental
   --recheck-days 7`: box scores are fetched only when missing or played in the last 7
   days (corrections).
5. Validate, resolve teams and players, upsert in one transaction.
6. Refresh read models; rebuild analytics from the whole database; store the files.
7. Record coverage and sync state; alert on failure, emptiness or staleness; exit 0/1.

See [DATABASE.md](DATABASE.md) and [OPERATIONS.md](OPERATIONS.md).
