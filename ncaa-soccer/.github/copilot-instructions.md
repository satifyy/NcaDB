# NCAA Soccer Copilot Guide

- Monorepo (TypeScript/Node) with workspaces for apps and shared packages; build uses `tsc -b` from root.
- Install once at repo root: `npm install`; build all: `npm run build`. Playwright flows need `npx playwright install chromium` before first run.
- Key run commands (ts-node/tsx fine during dev):
  - Single schedule: `ts-node apps/scraper/src/scripts/fetch_schedule.ts <scheduleUrl> "<Team Name>" [alias]`
  - Bulk Sidearm schedules (Playwright): `ts-node apps/scraper/src/scripts/fetch_schedules_parallel.ts [path/to/teams.json]`
  - Box scores from schedule: `ts-node apps/scraper/src/scripts/fetch_boxscores.ts <scheduleUrl> "<Team Name>" [alias]`
  - Box scores from games.csv: `ts-node apps/scraper/src/scripts/fetch_boxscores_from_csv.ts data/games/<year>/games.csv [limit]`
  - Aggregation: `ts-node apps/scraper/src/scripts/aggregate_player_stats.ts`
  - Dashboard data bundle: `ts-node apps/scraper/src/scripts/generate_dashboard_data.ts` then open `apps/dashboard/index.html`.
- Data locations: schedules -> `data/games/<season>/games.csv`; player stats -> `data/player_stats/<season>/player_stats.csv`; aggregated totals -> `data/player_stats/<season>/aggregated_player_stats.csv`; generated dashboard payload -> `apps/dashboard/data.js`; raw HTML/JSON captures -> `data/raw/`.
- Schemas live in [packages/shared/src/schemas](packages/shared/src/schemas) (Zod). `GameSchema` expects ISO `date`, `location_type`, `status`, and `source_urls` object; `PlayerStatSchema` uses flexible `stats` map plus convenience fields.
- ID helpers in [packages/shared/src/ids.ts](packages/shared/src/ids.ts): `makeGameDedupeKey(date, home, away)` and `makeGameId` (Base64), `makePlayerKey(team_id, player_name)` uses normalized player names from [packages/shared/src/normalize.ts](packages/shared/src/normalize.ts). Keep dedupe keys stable when adding new parsers/storage.
- Team resolution in [packages/shared/src/teams.ts](packages/shared/src/teams.ts): `TeamResolver` loads `data/teams/acc_teams.json` and `team_aliases.json`; `resolveTeamId` matches aliases case-insensitively. If you add metadata, reload via constructor paths.
- Parser contract in [packages/parsers/src/types.ts](packages/parsers/src/types.ts): `Parser.parseSchedule(html, options)` returns `Game[]`; `parseBoxScore` returns `{ game, playerStats }`. Register parsers via `ParserRegistry` (see [packages/parsers/src/index.ts](packages/parsers/src/index.ts)).
- Sidearm schedule parser behavior (see [packages/parsers/src/sidearm/schedule.ts](packages/parsers/src/sidearm/schedule.ts)): JSON-first, then Nuxt hydration, then HTML selectors (cards, tables, scoreboard), finally ld+json. Cleans rankings/stars, dedupes by sorted team names + date, fixes missing dates from ld+json, merges scores/boxscore URLs/status when duplicates arise. Uses `location_indicator` to infer home/away; neutral handled via indicator + `neutral_hometeam`.
- Sidearm box score parser (see [packages/parsers/src/sidearm/boxscore.ts](packages/parsers/src/sidearm/boxscore.ts)): prefers Nuxt hydration; falls back to advanced tables or classic `sidearm-table` layouts. Extracts shots/SOG/goals/assists/minutes, goalie saves/GA, builds `player_key` from team+normalized player name, and derives `game_id` from boxscore URL. Be prepared for column-count heuristics when extending.
- Storage merge rules in [packages/storage/src/game_adapter.ts](packages/storage/src/game_adapter.ts): saves to `data/games/<season>/games.csv`, upserts by `dedupe_key`, preserves earlier rows but upgrades unknown location, missing scores, status changes, and empty URLs; sorts by date before write. Respect this merge logic when altering schemas/output.
- Dashboard expects `window.playerStats` from generated `apps/dashboard/data.js`; keep numeric fields (goals/assists/shots/minutes/saves) as numbers for Chart.js usage in [apps/dashboard/app.js](apps/dashboard/app.js).
- Inventory validation in [apps/scraper/src/validate_inventory.ts](apps/scraper/src/validate_inventory.ts) enforces required team metadata (`schedule_url`, `platform_guess`, `parser_key`, unique ids/names). Run after editing team lists.
- Fetcher utilities (UA spoofing, retries, optional raw capture) live under `apps/scraper/src/utils`; Playwright scripts block heavy assets and retry navigation—keep that pattern when adding browser automations.
- Archived one-offs under [apps/scraper/src/scripts/archive](apps/scraper/src/scripts/archive) are excluded from builds; do not rely on them for new flows.
- When extending parsers: normalize team names (`normalizeTeamName`), set `dedupe_key` and `source_urls`, and align status values to `GameSchema` enums to keep storage merge stable.
- When adding new outputs: prefer writing CSV via existing adapters or mirror the `csv-stringify` pattern; preserve header order used in `game_adapter` to avoid downstream diffs.
- Keep non-ASCII out unless the file already uses it; repo is ASCII-oriented.

If anything here is unclear or missing for your task, tell me and I will tighten this guide.
