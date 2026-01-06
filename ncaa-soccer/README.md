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
- **Sidearm Schedule**: Handles HTML/JSON, cleans canonical names, resolves box score links.
- **Sidearm Box Score**: Parses player rows from Nuxt data or HTML tables.

## Storage (`packages/storage`)
- **GameAdapter**: Upserts games by dedupe key, handling status updates and missing data.

## Scraper app (`apps/scraper`)
- **Validation**: Schema checks for teams and inventory.
- **Scripts** (`src/scripts/`):
  - `fetch_schedule.ts`: Single team fetch.
  - `fetch_schedules_parallel.ts`: Bulk fetch (Playwright).
  - `fetch_boxscores.ts`: Fetch box scores from a schedule URL.
  - `aggregate_player_stats.ts`: Summarize season totals per player.
  - `generate_dashboard_data.ts`: **Updated** to output `player_stats.json` for the React dashboard.

## Dashboard app (`apps/dashboard`)
A modern analytics UI built with **React 18** and **Vite**.
- **Features**: Interactive charts (Chart.js), sortable tables, team filters, and KPI cards.
- **Data Source**: Consumes `src/data/player_stats.json`.
- **Styling**: Premium dark theme using vanilla CSS variables.

## Data pipeline: end-to-end
1. **Seed teams**: Update `data/teams/acc_teams.json`.
2. **Fetch schedules**: `ts-node apps/scraper/src/scripts/fetch_schedules_parallel.ts`.
3. **Fetch box scores**: `ts-node apps/scraper/src/scripts/fetch_boxscores_from_csv.ts`.
4. **Aggregate**: `ts-node apps/scraper/src/scripts/aggregate_player_stats.ts`.
5. **Dashboard**:
   - Updates JSON: `npx tsx apps/scraper/src/scripts/generate_dashboard_data.ts`.
   - Run UI: `npm run dev` in `apps/dashboard`.

## Build/test notes
- **Build**: `npm run build` builds all workspaces.
- **Playwright**: Required for parallel fetching scripts.
- **Lint**: `npm run lint` (dashboard has its own strict config).
