# NCAA Soccer Scraper Monorepo (Deep Guide)

This repository is a TypeScript/Node monorepo that scrapes NCAA men’s soccer schedules and box scores, normalizes them into shared schemas, saves them to CSV, and can render a lightweight dashboard. Below is a detailed map of every important piece and how they interact.

## Monorepo layout
- `package.json`: Root workspace config (TypeScript build, Cheerio dependency).
- `apps/`: Executable surfaces.
  - `scraper/`: The main runner scripts and scraping utilities.
  - `dashboard/`: Static HTML/JS dashboard fed by generated data.
  - `ui/`: Minimal React stub to prove shared types compile in a UI.
- `packages/`: Shared libraries used by the apps.
  - `shared/`: Schemas, ID helpers, team resolver, name normalizers.
  - `parsers/`: Pluggable parsers (currently Sidearm schedule + box score).
  - `storage/`: CSV read/write adapters and game merge logic.
- `data/`: Working dataset (input + output).
  - `teams/`: Metadata (`acc_teams.json`, `team_aliases.json`, test fixtures).
  - `games/<season>/games.csv`: Saved schedule rows.
  - `player_stats/<season>/*.csv`: Box score outputs and aggregated stats.
  - `raw/`: Captured raw HTML/JSON snapshots from fetch runs.

## Shared contracts and helpers (`packages/shared`)
- Schemas (Zod):
  - `TeamSchema` (`schemas/team.ts`): `team_id`, `name_canonical`, `conference`, `sport`, optional `aliases`, and scraping hints `schedule_url`, `platform_guess`, `parser_key`.
  - `GameSchema` (`schemas/game.ts`): `game_id`, `date`, team names/IDs, rankings, scores, `location_type`, `status`, and `source_urls` (schedule/boxscore/recap), plus a `dedupe_key`.
  - `PlayerStatSchema` (`schemas/playerStat.ts`): Game/team/player identifiers, `player_key`, optional jersey and convenience stat fields, plus a flexible `stats` map.
- ID utilities (`ids.ts`):
  - `makeGameDedupeKey(date, home, away)`, `makeGameId(dedupeKey)` (Base64), `makePlayerKey(teamId, playerName)`.
- Normalizers (`normalize.ts`): Strip rankings and whitespace noise from team names; collapse whitespace in player names.
- Team resolution (`teams.ts`): `TeamResolver` loads teams + aliases, resolves arbitrary names/aliases to canonical IDs, and exposes the loaded teams.

## Parsers (`packages/parsers`)
- Parser interface (`types.ts`): `Parser` has `parseSchedule(html, options)` and `parseBoxScore(html, options)` returning `Game[]` or `{ game, playerStats }`.
- Registry (`index.ts`): `ParserRegistry` registers `SidearmParser`; exports box score parser.
- Sidearm schedule parser (`sidearm/schedule.ts`):
  - Accepts HTML or JSON from Sidearm sites; falls back through JSON, Nuxt hydration data, game cards, table rows, scoreboard items, and ld+json sports events.
  - Normalizes dedupe keys, cleans ranked/team names, resolves relative box score links, and merges ld+json fields (dates, scores, URLs) into parsed games.
  - Supports debug logging and base URL resolution.
- Sidearm box score parser (`sidearm/boxscore.ts`):
  - Attempts Nuxt hydration parsing first; falls back to HTML table parsing.
  - Extracts player rows (jersey, minutes, goals, assists, shots, saves), builds `player_key`, and populates `PlayerStat` entries tied to the source URL-derived game ID.

## Storage (`packages/storage`)
- CSV writers (`csv/writers.ts`): Stubs for writing games/player stats (console-only placeholders).
- Game CSV adapter (`game_adapter.ts`):
  - `GameStorageAdapter.saveGames(games, season)` merges into `data/games/<season>/games.csv`.
  - Upserts by `dedupe_key`, prefers non-unknown location, fills missing scores/URLs, updates status, sorts by date, writes CSV via `csv-stringify`.
- CSV readers (`csv/readers.ts`): Placeholder.

## Scraper app (`apps/scraper`)
- Entry validation (`src/index.ts`): Smoke-tests schemas and `TeamResolver` wiring.
- Inventory validator (`src/validate_inventory.ts`): Zod validation, uniqueness checks, and required metadata (`schedule_url`, `platform_guess`, `parser_key`) across `data/teams/acc_teams.json`.
- Utility:
  - `utils/fetcher.ts`: Axios + axios-retry wrapper with optional delay, UA spoofing, raw HTML saving to `data/raw`, and basic retry logic.
- Key scripts (`src/scripts/`):
  - `fetch_schedule.ts`: Fetch one Sidearm schedule URL, parse games, log summary, and save into `data/games/<year>/games.csv` via `GameStorageAdapter`.
  - `fetch_boxscores.ts`: Given a schedule URL, scrape schedule, collect box score links, fetch each, parse player stats, and write `data/player_stats/<year>/player_stats.csv` (CSV escaping included).
  - `fetch_boxscores_from_csv.ts`: Read an existing `games.csv`, de-duplicate by team/date, Playwright-fetch box score pages in parallel batches, parse player stats, and emit player CSV rows.
  - `fetch_schedules_parallel.ts`: Playwright-powered multi-school Sidearm fetcher. Loads `data/teams/acc_teams.json` (or a provided teams file), skips non-Sidearm, navigates with resource blocking, handles view toggles/popups, retries navigation, parses with `SidearmParser`, normalizes box score URLs, and saves merged schedules per season.
  - `aggregate_player_stats.ts`: Summarize `player_stats.csv` into per-player season totals (games played, minutes, goals, assists, shots, SOG, saves) and write `aggregated_player_stats.csv` sorted by points then minutes.
  - `generate_dashboard_data.ts`: Convert `aggregated_player_stats.csv` into `apps/dashboard/data.js` (assigns `window.playerStats` with numeric fields for the dashboard).
  - Other helper/debug scripts (selected highlights):
    - `compare_schedule_to_csv.ts`: Diff parsed schedule vs. existing CSV.
    - `fetch_schedule_table.ts` / `fetch_schedule_table_v2.ts`: Table-centric sched fetchers.
    - `debug_*`, `inspect_*`, `verify_*`, `peek_*`, `extract_*`, `inspect_*`: One-off probes for HTML/JSON structures, parser checks, and live/debug runs.
    - `test_boxscore_parser.ts`, `verify_boxscore_*`, `verify_nuxt_fetch.ts`: Parser regression and live fetch spot-checks.
    - `generate_dashboard_data.ts` + `apps/dashboard` pairing noted below.

## Dashboard app (`apps/dashboard`)
- Static HTML/CSS/JS showing charts and tables of aggregated player stats.
- Expects `apps/dashboard/data.js` generated by `generate_dashboard_data.ts` to populate `window.playerStats`.
- `app.js` handles pagination, sorting, filtering, summary cards, and Chart.js visualizations (goals leaders, efficiency, per-90 output, contribution scatter).

## UI stub (`apps/ui`)
- Minimal React entry (`src/main.tsx`) rendering a `TeamCard` and validating a dummy `Team` with `TeamSchema` to ensure shared types work in a frontend build.

## Data pipeline: end-to-end
1) **Seed teams**: Populate `data/teams/acc_teams.json` and `team_aliases.json` (used by `TeamResolver` and validators).
2) **Validate metadata**: `node apps/scraper/dist/validate_inventory.js` after `npm run build` to confirm team metadata completeness/uniqueness.
3) **Fetch schedules**:
   - Single team: `ts-node apps/scraper/src/scripts/fetch_schedule.ts <scheduleUrl> "<Team Name>" [alias]`.
   - Bulk Sidearm teams: `ts-node apps/scraper/src/scripts/fetch_schedules_parallel.ts [path/to/teams.json]` (Playwright required).
   - Output merges into `data/games/<year>/games.csv`.
4) **Fetch box scores**:
   - From a schedule URL: `ts-node apps/scraper/src/scripts/fetch_boxscores.ts <scheduleUrl> "<Team Name>" [alias]`.
   - From existing games CSV: `ts-node apps/scraper/src/scripts/fetch_boxscores_from_csv.ts [data/games/<year>/games.csv] [limit]`.
   - Output: `data/player_stats/<year>/player_stats.csv`.
5) **Aggregate + dashboard**:
   - Aggregate per-player season totals: `ts-node apps/scraper/src/scripts/aggregate_player_stats.ts`.
   - Generate dashboard data bundle: `ts-node apps/scraper/src/scripts/generate_dashboard_data.ts`, then open `apps/dashboard/index.html`.

## Build/test notes
- Install: `npm install` at repo root (workspaces cover apps + packages).
- Build all TS: `npm run build` (runs `tsc -b` across workspaces).
- Tests: none formal; many scripts double as manual checks (`verify_*`, `test_*`).
- Playwright scripts (`fetch_schedules_parallel.ts`, `fetch_boxscores_from_csv.ts`) require the `playwright-chromium` dependency (already in `apps/scraper` via `package-lock`) and browser binaries available.

## Operational considerations
- Rate limiting: `Fetcher` supports `delayMs`, retries, and raw HTML capture; Playwright scripts block heavy assets for speed.
- Deduplication: `GameStorageAdapter` merges by `dedupe_key`; `fetch_boxscores_from_csv.ts` also de-duplicates games by date/team before fetching.
- IDs: Default `game_id` is Base64 of `dedupe_key` (`date:home:away`), and `player_key` is `team_id:normalized_player_name`; ensure upstream parsers honor these formats when extending.

## Extending
- New parsers: Implement `Parser` interface in `packages/parsers`, register in `ParserRegistry`, and set teams’ `parser_key`/`platform_guess`.
- Storage: Fill in `csv/writers.ts` and add readers when moving beyond console stubs.
- Frontend: Expand `apps/dashboard` or `apps/ui` to consume richer stats once parsers and storage are upgraded. 
