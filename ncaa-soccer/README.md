# NCAA Soccer Scraper Monorepo (Deep Guide)

This repository is a TypeScript/Node monorepo that scrapes NCAA men’s soccer schedules and box scores, normalizes them into shared schemas, saves them to CSV, and provides a modern React dashboard for analyitcs.

## Quick start
- **Prereqs**: Node 18+ and npm. For Playwright flows, install browser binaries once with `npx playwright install chromium`.
- **Install deps**: `npm install`.
- **Build all**: `npm run build` (outputs to each workspace `dist/`).
- **Fetch one schedule**:
  - `node apps/scraper/dist/scripts/fetch_schedule.js <scheduleUrl> "<Team Name>" [alias]`
  - Output merges into `data/games/<year>/games.csv`.
- **Pull box scores**: `node apps/scraper/dist/scripts/fetch_boxscores.js <scheduleUrl> "<Team Name>" [alias]` → writes `data/player_stats/<year>/player_stats.csv`.
- **View Dashboard**:
  1. Generate data: `npx tsx apps/scraper/src/scripts/generate_dashboard_data.ts`
  2. Start app: `cd apps/dashboard && npm run dev`
  3. Open `http://localhost:5173`.

## Monorepo layout
- `package.json`: Root workspace config.
- `apps/`: Executable surfaces.
  - `scraper/`: The main runner scripts and scraping utilities.
  - `dashboard/`: **New** React + Vite application for visualizing player stats.
  - `dashboard-legacy/`: Backup of the old vanilla JS dashboard.
  - `ui/`: Shared UI component library (stub).
- `packages/`: Shared libraries used by the apps.
  - `shared/`: Schemas (Zod), ID helpers, team resolver.
  - `parsers/`: Pluggable parsers (Sidearm schedule + box score).
  - `storage/`: CSV adapters and game merge logic.
- `data/`: Working dataset (input + output).
  - `teams/`: Metadata (`acc_teams.json`).
  - `games/<season>/games.csv`: Saved schedule rows.
  - `player_stats/<season>/*.csv`: Box score outputs and aggregated stats.

## Shared contracts (`packages/shared`)
- **Schemas**:
  - `TeamSchema`: Metadata, conference, scraping hints.
  - `GameSchema`: Date, teams, scores, source URLs, dedupe key.
  - `PlayerStatSchema`: Game/team/player IDs + flexible stats map.
- **Utils**: ID generation (Base64 keys), Name normalization.

## Parsers (`packages/parsers`)
Three platforms cover the schools in `data/teams/`, selected per school by
`platform_guess`:

| `platform_guess` | Product | How it is read | Example schools |
| --- | --- | --- | --- |
| `sidearm` | Sidearm Sports | Rendered HTML (Playwright) | Duke, Georgetown, Portland |
| `wmt` | WMT Digital (Nuxt) | `/website-api` JSON, no browser | Clemson, UCLA, UCF |
| `wmt_wp` | WMT Digital (WordPress) | Server-rendered HTML, no browser | Kentucky, South Carolina |

- **Sidearm Schedule**: Handles HTML/JSON, cleans canonical names, resolves box score links.
- **Sidearm Box Score**: Parses player rows from Nuxt data or HTML tables.
- **WMT Schedule** (`wmt/schedule.ts` + `wmt/client.ts`): Reads the site's own
  `/website-api` JSON instead of the DOM. WMT schedule pages are unscrapeable in
  practice — Notre Dame renders its table client-side, Clemson omits the year from
  every row, and the season switcher only rewrites the URL after hydration — while the
  API returns exact kickoff times, scores and box-score links with no browser at all.
  Discovery is `sport slug -> season -> schedule -> events`; sport slugs differ per
  school (`mens-soccer`, but `msoc` at Notre Dame and Virginia), and so do season names
  (`2025-26` at Clemson/Notre Dame/Virginia, `2025` at Stanford/Virginia Tech), so both
  spellings are tried.
- **WMT Box Score** (`wmt/boxscore.ts`): A WMT box-score page is an iframe onto
  `wmt.games` backed by a JSON stats feed. Scraping that iframe returns scoring plays
  interleaved with players, so the parser reads the feed directly
  (`api.wmt.games/api/statistics/games/<id>`) for goals, assists, shots, minutes and saves.
- **WMT WordPress Schedule** (`wmt/wordpress.ts`): WMT's other product. It has no
  schedule API — `wp-json` exposes only editor routes — but renders the season
  server-side. Schools theme it differently, so two row shapes are supported
  (Kentucky's `.schedule-item`, South Carolina's `.schedule-table_row`); each is
  described once in a `THEMES` table. Rows carry no year, so the season year is
  supplied and the calendar year inferred from the month, except where the theme
  provides a `data-order` unix timestamp.
- **Team names** (`names.ts`): WMT stores two names per opponent and which one
  holds the school is a per-site choice — Notre Dame files Michigan under
  "Wolverines". `TeamNameResolver` picks the school-looking value and maps it onto the
  canonical name in `team_aliases.json`, so a WMT row for "Pitt" dedupes against a
  Sidearm row for "Pittsburgh". Longer-form spellings ("University of Kentucky") are
  derived automatically, and only registered where they do not collide with a name
  given explicitly — "Northern Kentucky" stays its own school.

## Storage (`packages/storage`)
- **GameAdapter**: Upserts games by `dedupe_key`, handling status updates and missing
  data. Rows already on disk are passed through the caller's `normalizeRow` before they
  are keyed, so a fixture stored under an older spelling merges with the canonical one
  instead of sitting beside it. Per-team fields (scores, ranked flags) are read through
  each row's home/away orientation, since the two schools list the same game in
  opposite order. See **Two sources per fixture** below.

## Team inventories (`data/teams/`)
One JSON per conference (`acc_teams.json`, `big_ten_teams.json`, ...) plus
`p5_msoc_teams.json`, which unions them for a single run. Each entry carries the
school's schedule URL, its platform, and the IANA zone its kickoff times are quoted in.

These are generated, not written by hand — see `discover_teams.ts`.

## Scraper app (`apps/scraper`)
- **Validation**: Schema checks for teams and inventory.
- **Scripts** (`src/scripts/`):
  - `discover_teams.ts`: Builds a conference's inventory from nothing but a roster of
    school names. It harvests school -> athletics domain from schedule pages already
    reachable (Sidearm links each opponent to that school's own site; the WMT API
    carries `opponent.website_url`), re-harvests from whatever that unlocks, then
    probes each domain for a men's soccer schedule and identifies its platform.
    Usage: `npx tsx .../discover_teams.ts <rosters.json> [season]`, where `rosters.json`
    is `{ "Big Ten": ["Indiana", ...] }`. Writes one file per conference plus
    `p5_msoc_teams.json`, their union, which is what the scrapers are usually pointed at.
  - `fetch_schedule.ts`: Single team fetch.
  - `fetch_schedules_parallel.ts`: Bulk fetch for a given season; Playwright for
    Sidearm schools, the `/website-api` JSON for WMT schools.
  - `fetch_boxscores.ts`: Fetch box scores from a schedule URL.
  - `aggregate_player_stats.ts`: Summarize season totals per player.
  - `generate_dashboard_data.ts`: **Updated** to output `player_stats.json` for the React dashboard.

## Dashboard app (`apps/dashboard`)
A modern analytics UI built with **React 18** and **Vite**.
- **Features**: Interactive charts (Chart.js), sortable tables, team filters, and KPI cards.
- **Data Source**: Consumes `src/data/player_stats.json`.
- **Styling**: Premium dark theme using vanilla CSS variables.

## Two sources per fixture
Both schools in a game publish their own schedule row and their own box score, and the
two are merged on a shared `dedupe_key` (date + both teams, alphabetically). Making that
key match is why every team name is canonicalised before storage — Sidearm decorates
opponents with poll rankings and long-form names ("#3 NC State", "Pitt",
"#24/RV University of Virginia") while the WMT API returns plain school names, and
without normalisation the same fixture lands twice.

When the two schools give different box-score links, the second is kept as
`boxscore_url_alt`. A parseable HTML page always takes the primary slot over a PDF, and
if the primary yields no players the box-score stage retries against the alternate.
That recovers games where one school's stats feed is empty but the other's is not.
Where both schools are on WMT they often share a single underlying stats record, so the
fallback cannot help there — those are genuine source-side gaps.

Runs are also additive: a game that fails transiently keeps the stats an earlier run
collected rather than being wiped from `player_stats.csv`.

## Seasons
Every scrape targets one season, passed as the second argument to
`fetch_schedules_parallel.ts` (defaults to the current calendar year). Games outside
that year are dropped before writing, so a run can never leak next season's fixtures
into an earlier season's file.

- WMT schools honour the season exactly, current or historical.
- Sidearm schools are requested at `/schedule/<year>`, which most of them serve
  server-side. Cal and SMU ignore it and always return the current season; for a past
  season they contribute nothing new and their existing rows are left untouched by the
  merge.

## Data pipeline: end-to-end
No model is involved at any step; it is four Node commands.

1. **Seed teams**: `npx tsx apps/scraper/src/scripts/discover_teams.ts rosters.json 2025`,
   or edit `data/teams/*.json` directly.
2. **Fetch schedules**: `npx tsx apps/scraper/src/scripts/fetch_schedules_parallel.ts data/teams/p5_msoc_teams.json 2025`.
3. **Fetch box scores**: `npx tsx apps/scraper/src/scripts/fetch_boxscores_from_csv.ts data/games/2025/games.csv`.
4. **Aggregate**: `npx tsx apps/scraper/src/scripts/aggregate_player_stats.ts`.
5. **Dashboard**:
   - Updates JSON: `npx tsx apps/scraper/src/scripts/generate_dashboard_data.ts`.
   - Run UI: `npm run dev` in `apps/dashboard`.

## Build/test notes
- **Build**: `npm run build` builds all workspaces.
- **Playwright**: Required for parallel fetching scripts.
- **Lint**: `npm run lint` (dashboard has its own strict config).
