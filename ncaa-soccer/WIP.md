# WIP — expanding to all D1 conferences × 5 seasons

Stopped mid-task on 2026-08-20. Delete this file once the work below is finished.

## Goal

1. Expand the inventory from 5 conferences to **all D1 men's soccer conferences**.
2. Build `games` + `player_stats` for the **past 5 seasons (2021–2025)**.

Currently the repo holds **2025 only**, for the 58 P5 teams.

## Done and verified

- Full roster list for all 213 D1 men's soccer programs across 23 conferences,
  scraped from Wikipedia's program list and saved to
  `data/teams/d1_msoc_rosters.json` — this is the input to `discover_teams.ts`.
- `discover_teams.ts` parallelised (`CONCURRENCY = 12`) and made **non-destructive**:
  it merges with the existing inventory instead of overwriting, so a transient fetch
  failure can no longer shrink a conference. It clobbered the P5 inventories once
  before this fix.
- Discovery run over all 213: **206 resolved**, 19 unresolved (listed below).
  Wrote `data/teams/<conference>_teams.json` for 23 conferences plus the union
  `data/teams/p5_msoc_teams.json` (the filename is now a misnomer — rename it).
  All 23 inventories pass `validate_inventory.ts` (194 teams after the ACC repair).

## Known issues — fix before scraping

### 1. Discovery duplicates schools it has already seen (still open)

Discovery merges by `team_id`. The hand-written inventory keys Duke as `DUKE` /
"Duke"; the roster file gives "Duke University", so discovery mints
`DUKE_UNIVERSITY` alongside it and the merge keeps both. This blew `acc_teams.json`
up to 27 entries.

`acc_teams.json` has been repaired by hand back to its verified 15 (short names,
correct platforms) — **but the bug itself is not fixed**, so the next discovery run
will duplicate it again.

Fix: match an incoming school against existing entries through
`TeamNameResolver`/`matchKeys` rather than by `team_id` alone, preferring the
established shorter name.

### 2. The new inventories use formal institution names

The 22 generated conference files carry roster spellings — "Loyola Marymount
University", "University of the Pacific", "Clemson University" — while the 2025
dataset was built with short athletics names ("LMU", "Pacific", "Clemson"). Scraping
with them as-is would produce team names that do not match the existing rows.

Normalise the generated `name_canonical`/`team_id` to the short form (and seed
`aliases` with the formal name) as part of fixing issue 1.

## Unresolved schools (19 of 213)

No athletics domain harvested:
West Florida, Albany, Bakersfield, Cal State Northridge, Elon, Green Bay, NIU,
Niagara, Bowling Green, Grand Canyon, Fairleigh Dickinson, LIU, UIW, SIU Edwardsville,
UTRGV, Holy Cross.

Domain found but no men's soccer schedule at the probed slugs (worth a manual look —
these are probably real programs on a slug the prober does not try):
Bradley (`bubraves.com`), Central Connecticut (`ccsubluedevils.com`),
Colgate (`gocolgateraiders.com`).

Harvest coverage grows as more schedules are scraped, so re-running discovery after a
full-season scrape should resolve several of these on its own.

## Remaining work

1. Fix issues 1 and 2 above, regenerate inventories, confirm each conference has the
   expected team count and short names.
2. Run schedules for 2021–2025:
   `npx tsx apps/scraper/src/scripts/fetch_schedules_parallel.ts data/teams/<union>.json <year>`
   Writes `data/games/<year>/games.csv`. Roughly 10–15 min per season at 206 teams.
3. Run box scores per season:
   `npx tsx apps/scraper/src/scripts/fetch_boxscores_from_csv.ts data/games/<year>/games.csv`
   **This is the long pole.** 726 games took ~30 min; a full season is ~1,800 games
   (~75 min), so five seasons is on the order of **6 hours of wall clock**. Plan for
   an overnight or batched run rather than a single session.
4. Aggregate + dashboard per season (`aggregate_player_stats.ts` hardcodes 2025 —
   it needs a season argument before it can be used for other years).

## Things to know before resuming

- **Conference labels are 2026-27 alignment.** Wikipedia lists current membership, so
  a 2021 scrape will file some schools under a conference they had not joined yet.
  The per-school game data is unaffected; only the `conference` field is approximate
  for historical seasons.
- **Historical seasons are reachable on all three platforms**: WMT via its season API,
  Sidearm via `/schedule/<year>`, WMT WordPress via `/schedule/<year>`. This was
  verified for 2025 but **not yet for 2021–2024** — spot-check one school per platform
  before committing to a five-season run.
- `data/teams/test_teams.json` is a stale two-team fixture that still claims Stanford
  and Virginia Tech are Sidearm (they are WMT). It is excluded from validation.
- The whole-repo `git status` noise is a CRLF→LF artifact of the original checkout,
  not real edits.

## Regenerating the roster file

`data/teams/d1_msoc_rosters.json` is already saved; this is only needed to refresh it.
Fetch
`https://en.wikipedia.org/api/rest_v1/page/html/List_of_NCAA_Division_I_men%27s_soccer_programs`,
take the first table, and read each row's Institution and Conference cells. Use the
parenthetical common name after the `<br/>` ("(NC State)") when present, else the
link `title`. Do **not** use `data-sort-value` — it holds an abbreviated sort key
("Louisv"), not a name.
