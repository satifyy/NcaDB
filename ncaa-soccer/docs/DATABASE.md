# Database

PostgreSQL 14+ (Railway runs 16+). Schema: `packages/database/migrations/*.sql`, applied
in name order by `npm run worker -- migrate` (checksummed, advisory-locked, one
transaction per file). Never edit an applied migration; add a new one.

User accounts (migration 003, schema `accounts`, role `ncadb_accounts`) and admin
maintenance requests (migration 004) are described in [AUTHENTICATION.md](AUTHENTICATION.md),
with the permission boundary between the three application roles.

## Identity rules

| Entity | Natural key | Why |
| --- | --- | --- |
| Team | `(sport, slug)`; slug from the inventory's canonical name (`nc-state`) | Every spelling a site uses is resolved through the inventory and aliases first; raw spellings are kept in `source_identifiers`. |
| Game | `(season, date, low team id, high team id)` | Each school publishes its own row for a fixture, in its own orientation and spelling. Once both resolve to the same two teams on the same date they are one game (a team plays at most once a day). |
| Game source | `(season, dedupe_key)` | One per school row, verbatim, so the scrapers can be re-fed exactly what they wrote. |
| Player | `(sport, "<team slug>:<letters of First Last>")` | Box scores carry no player id. A name is not a person: the same name at two schools in one season is two people. A transfer is therefore a second player; the API lists same-name players elsewhere as a lead, never merged. |
| Player game stat | `(game, player, jersey)` | One name at two numbers in a box score is two people. |

## Tables

- `sports`, `competitions`, `seasons`, `conferences` — reference data.
- `teams` — `inventory_id`/`is_division_one` for the 197 scraped programs; opponents
  outside Division I are teams too, flagged false.
- `team_seasons` — team × season with conference. The inventory records current
  alignment only, so `conference_source = 'inventory_current'` marks past seasons as
  approximate.
- `games` — merged fixture: scores (NULL until played — never 0), `status`
  (`scheduled|live|final|postponed|canceled|unknown`), `game_type`, box-score URLs,
  `boxscore_status` (`none|partial|complete`), `quality_flags` (`score_conflict`),
  `content_hash`, `first_seen_at`, `updated_at`, `last_verified_at`.
  CHECKs: different teams; a final has both scores; scores ≥ 0.
- `game_sources` — raw schedule rows (`payload jsonb`) per game.
- `players`, `player_team_seasons` (jersey by season).
- `player_game_stats` — minutes, goals, assists, shots, shots on goal, saves; NULL when
  the box score did not say. Provenance columns (`source_*`) reproduce the scraper row.
  From migration 005: the published `position` and its `position_group` (GK/DEF/MID/FWD),
  `started`, the keeper's `goals_allowed`, and `capture_version` (1 = loaded before these
  were captured, where `saves = 0` may mean "not published"; 2 = captured, NULL means not
  reported). `backfill-capture` re-reads rows below the current version.
- `team_game_stats` — per side totals, the score the schedule reported, and
  `goals_reconciliation`: `ok`, `unattributed` (fewer player goals than the score —
  own goals), `excess` (more — a real inconsistency, reported, not altered), `unknown`.
- `ingestion_runs`, `ingestion_tasks`, `ingestion_errors`, `data_sync_state` — history,
  per-stage outcomes, categorised errors and data-quality issues, freshness per scope.
- `totw_*` (migration 006) — Team of the Week, precomputed after every load: weeks
  (status, revision, inputs hash, completeness), every eligible player's rating and game
  breakdown, the XI, and the weights of each model version. See
  [TEAM_OF_THE_WEEK.md](TEAM_OF_THE_WEEK.md).
- `derived_artifacts` — analytics JSON (ratings, forecasts, impact, season tables) by key.
- Materialized views `player_season_stats`, `team_season_records` — refreshed
  `CONCURRENTLY` after every load; back the leaderboards and records.

Indexes cover every API filter: games by date, season+date, each team+date, status;
stats by player+season, team+season; players by lower(name).

## How a load stays correct

- One transaction per season: a failure leaves the season exactly as before.
- Every write is `INSERT … ON CONFLICT` on the natural key, updating only when the
  row's content hash changed. Re-loading identical data reports 0 inserted / 0 updated.
- A whole-season batch is authoritative for which source rows exist; a partial batch
  (one team, one game, a date range) only adds and updates.
- A re-read box score replaces that side of that game (a removed player is removed); a
  side missing from the batch keeps its rows.
- Validation rejects rather than coerces, and records every rejection by code with
  samples: bracket placeholders as opponents, placeholder dates, placeholder players,
  unnamed teams, stats pointing at no game. Box-score labels that are abbreviations are
  attributed to a fixture side by elimination or roster overlap, or left flagged.

Verified on the full 2016–2026 history: 22,899 games, 787,110 player-game rows,
loaded in ~70 s; a second load reports every row unchanged.

## Backups and restore

Railway Postgres has volume backups (Hobby/Pro: enable scheduled backups in the
service's *Backups* tab). Independently, a logical dump can be taken any time:

```bash
railway connect Postgres            # interactive psql, for inspection
# dump through a temporary TCP proxy (see OPERATIONS.md → "Direct database access")
pg_dump --format=custom --no-owner "$DATABASE_PUBLIC_URL" > ncadb-$(date +%F).dump
pg_restore --clean --if-exists --no-owner --dbname "$TARGET_URL" ncadb-YYYY-MM-DD.dump
```

The committed CSVs are a second, independent recovery path: an empty database is
rebuilt from them with `backfill --seasons 2016-2026 --from-csv .` in about a minute.
