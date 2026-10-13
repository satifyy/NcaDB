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
  1. Generate data:
     ```
     npx tsx apps/scraper/src/scripts/build_ratings.ts
     npx tsx apps/scraper/src/scripts/build_predictions.ts
     npx tsx apps/scraper/src/scripts/generate_dashboard_data.ts
     npx tsx apps/scraper/src/scripts/generate_dashboard_analytics.ts
     ```
     Or all four at once with `run_pipeline.ts --only ratings,predictions,dashboard,analytics`.
  2. Start app: `cd apps/dashboard && npm run dev`
  3. Open `http://localhost:5173`.
  - On a bind-mounted filesystem (WSL2, some Docker setups) Vite's file watcher can miss
    edits and serve a stale module. Restart the dev server if a change does not appear.

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
  - `GameSchema`: Date, teams, scores, source URLs, dedupe key, fixture kind.
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

## What kind of fixture a row is (`game_type`)

Not every game is worth the same to a rating. A friendly against a nearby NAIA side is
evidence, but it is not the evidence a conference final is, so `games.csv` carries a
`game_type` column: `exhibition`, `ncaa_tournament`, `conference_tournament`, `regular`.
`classifyGameType` in `packages/parsers` sets it; `apps/scraper/src/scripts/backfill_game_type.ts`
adds it to seasons written before the column existed.

The four values are not equally trustworthy, and the column is easy to over-read:

- **Exhibitions are stated, and the column is reliable.** WMT returns `is_exhibition`
  outright and Sidearm schools hang the marker on the opponent — "Marist (Exhibition)",
  "Clemson (Exhib.)", "UConn (exh)". 938 of the 23,765 stored rows are exhibitions.
- **Postseason labels are a floor, not a census.** Only a minority of bracket games name
  their round ("Stony Brook (CAA Semifinals)", "Syracuse - First Round"); most say
  nothing. Where a round is named but the bracket is not, the calendar separates the two —
  conference championship weekend has ended by Nov 17 in every stored season and the NCAA
  first round has never opened before Nov 19.
- **`regular` means "nothing said otherwise"**, not "known to be a regular-season game".
  Real postseason fixtures sit in it.
- **Conference vs non-conference is not represented at all.** Sidearm marks conference
  opponents with an asterisk and `cleanTeamName` strips it, so no asterisk survives into a
  stored row. Deriving it from the inventory instead would need membership *by season*,
  which `data/teams/*.json` does not carry: it lists Stanford as ACC, true from 2024 and
  wrong for the seven Pac-12 seasons before it. So the column does not guess.

The marker has to be read on the way in, because the pipeline destroys it: `normalizeRow`
runs `cleanTeamName` over the team-name columns, which turns "Marist (Exhibition)" into
"Marist". `game_id` and `dedupe_key` are left as the site published them, which is the
only reason the eleven stored seasons could be backfilled offline rather than re-scraped.
It is also why the flag `matches.ts` used to derive from the name columns found 22 of the
938 — the names it was reading had already been cleaned.

## Team inventories (`data/teams/`)
One JSON per conference (`acc_teams.json`, `big_ten_teams.json`, ...) plus
`d1_msoc_teams.json`, which unions them for a single run — 197 programs across 23
conferences. Each entry carries the school's schedule URL, its platform, and the IANA
zone its kickoff times are quoted in. (The union was `p5_msoc_teams.json` while the
dataset covered five conferences.)

These are generated, not written by hand — see `discover_teams.ts` and
`normalize_inventory.ts`.

**Every school is filed under the name the scraped rows carry**, not the formal
institution name. Wikipedia's roster says "Loyola Marymount University"; every athletics
site, and therefore every row in `games.csv`, says "Loyola Marymount". Scraping under the
formal name files one school twice, once per source, so discovery resolves an incoming
name against the inventory before adding it and prefers the established spelling. What
counts as the same school is containment between match keys rather than a shared key:
"Pacific" and "University of the Pacific" are one program, while "Boston College" and
"Boston University" merely share the loose key `boston` and are two.

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
    `d1_msoc_teams.json`, their union, which is what the scrapers are usually pointed at.
  - `normalize_inventory.ts`: Repairs the inventories in place — one entry per school,
    filed under the name the scraped data uses — reading `data/games` and
    `data/player_stats` as the authority for what each school is called. Dry-run by
    default; `--write` applies. Idempotent, so it is safe to re-run.
  - `prune_ambiguous_boxscores.ts`: Deletes player rows scraped from a box score that
    several fixtures claim. Dry-run by default; `--write` applies, after which the season
    needs re-aggregating. `fetch_boxscores_from_csv.ts` now refuses these while scraping,
    so this is only for data collected before that.
  - `preflight_seasons.ts`: Samples a few schools per platform and reports how many
    fixtures each publishes for the requested seasons. Exits non-zero if a platform
    returns nothing, which is the signal not to start a run against that season.
  - `run_pipeline.ts`: Runs the stages below end to end for one or more seasons, with
    resume. See **Running it unattended**.
  - `fetch_schedule.ts`: Single team fetch.
  - `fetch_schedules_parallel.ts`: Bulk fetch for a given season; Playwright for
    Sidearm schools, the `/website-api` JSON for WMT schools.
  - `fetch_boxscores.ts`: Fetch box scores from a schedule URL.
  - `aggregate_player_stats.ts`: Summarize season totals per player. Takes the season as
    an argument, defaulting to the current year.
  - `build_ratings.ts`: Judges each season's roster coverage, fits the Elo and forecast
    models against it, and values every player-game. Writes `data/season_coverage.json`,
    `data/ratings/` and the weekly standouts. See **Ratings, forecasts and player impact**.
  - `build_predictions.ts`: Walks the whole dataset a week at a time, forecasting each
    week from ratings frozen before it was played. Writes `data/predictions/`.
  - `generate_dashboard_data.ts`: Writes the dashboard's per-season JSON and its manifest,
    joining each team to its conference. Seasons the coverage check failed are excluded and
    named. Writes every usable season found; the argument only sets which one the page
    opens on.
  - `generate_dashboard_analytics.ts`: Rounds and splits the ratings, forecasts and impact
    scores into the files the dashboard fetches.

## Ratings, forecasts and player impact

Everything in this section is derived from the scraped results and box scores and nothing
else. No polls, no votes, no ratings borrowed from anywhere. Three models sit on top of
the CSVs, and one gate decides what they are allowed to read.

### The coverage gate

A backfill does not fail loudly. A season where half the schools' sites no longer serve
that year produces a `games.csv` and a `player_stats.csv` like any other, just smaller,
and everything computed from it is quietly wrong: a scoring leaderboard drawn from the two
thirds of teams that answered is not a leaderboard, and an Elo table where a third of the
league never played is not a table.

So `build_ratings.ts` measures each season against the inventory before anything reads it.
A team counts as present when it fielded at least eleven distinct players; a season where
**more than 20% of Division I is missing is flagged and excluded** from the ratings, the
forecasts, the impact scores and the dashboard's totals. The verdict, with its numbers, is
written to `data/season_coverage.json` and shown on the site — the excluded years are
named rather than silently skipped, because a gap nobody mentions reads as a bug.

The Elo carryover is applied per calendar year rather than per file, so a season dropped
from the middle of the range regresses ratings across the gap instead of pretending the
two seasons either side of it were consecutive.

### Elo

Elo suits this dataset because it needs nothing but results in order, which is all
`games.csv` is. Four things about college soccer make plain Elo wrong for it, and each is
a parameter fitted against the record rather than a number chosen because it looked right:

- **Rosters turn over completely every few years.** A graduating class takes its rating
  with it, so ratings regress toward 1500 between seasons.
- **Half the schedule is not Division I.** Schools open against nearby D2, D3 and NAIA
  programs. Starting those at 1500 hands out free points for beating a team that never had
  them, so unrated opponents enter lower.
- **Margins carry information, but not linearly.** A 5–0 says more than a 1–0 and much
  less than five times as much, and running up a score against a weak team says least of
  all — so the multiplier is logarithmic and damped by the rating gap.
- **Draws are a third outcome.** They are scored 0.5, which keeps the ratings unbiased,
  but turning a rating gap into probabilities needs a draw band, and that is a separate
  model.

**Every fixture moves a rating the same amount, and that was checked rather than assumed.**
`game_type` makes it possible to weight exhibitions and bracket games differently, so the
weights were fitted: searched freely in [0, 2] against the training loss, then held to the
same test the roster term gets — keep it only if it improves the seasons the search never
saw. The conference-tournament and NCAA-tournament weights failed that test outright,
which is what fitting parameters on 118 labelled bracket games looks like. The exhibition
weight came back at 1.48 — *more* than a league game, not less — and improved the held-out
loss only in the fourth decimal. College soccer exhibitions are played hard enough that
the distinction does not earn a parameter, so none of the weights are in the model.

Parameters are searched with Nelder–Mead: each candidate set runs the entire history and
is scored on the ratings each game was *played at*, never the ratings that game produced.
That makes the search walk-forward by construction. Everything is fitted on all but the
last two seasons and reported on those two.

The K and margin-damping surface is flat above roughly K=50 — several combinations score
within 0.0001 of each other — so those two numbers are weakly identified and should not be
read as precise.

### From a rating to a forecast

Outcome probabilities come from a symmetric ordered logit on the rating gap: one slope,
and a draw band whose half-width is fitted **per era**. That split is not tuning, it is a
rule change. The NCAA stopped playing regular-season overtime in 2022 and the draw rate
went from 12.2% of games in 2021 to 22.3% in 2022 and has stayed there. One band fitted
across that change would be wrong on both sides of it.

Expected goals are a separate two-Poisson fit against goals scored. Independent Poissons
famously under-predict draws, so rather than trusting them for the outcome, the scoreline
grid is re-weighted until its home/draw/away masses match the ordered logit's. Each model
keeps the job it is fitted for.

### Player impact

A college box score records six things: minutes, goals, assists, shots, shots on goal,
saves. There is no xG feed and no lineup detail, so any honest impact metric is a valuation
of those six and nothing more. What it does that a scoring leaderboard cannot:

- **One unit for everything.** Goals, chances and saves all become goal equivalents, so a
  goalkeeper and a forward are on the same axis. A goal is 1.0, an assist 0.75, a shot on
  target that did not score is worth that season's own goals-per-shot-on-target, and an
  off-target shot half of the average attempt. Because the goal is credited separately and
  removed from the chance count, nothing is counted twice.
- **Adjusted for the opponent.** Two goals against a 1900-rated side is not two goals
  against an exhibition opponent, and roughly a third of the fixtures in this dataset are
  outside Division I. Production is scaled by the opponent's Elo at kickoff, clamped so one
  absurd rating cannot dominate a season.
- **Adjusted for the sample.** A raw per-90 leaderboard here is a list of players who came
  off the bench once and scored, so every rate is mixed with five games of league-average
  play before it is ranked. A regular's rate barely moves; a cameo's collapses back to the
  middle, which is all the evidence there is for it.

Goalkeepers are credited with **goals prevented**: the goals a league-average keeper would
have conceded from the same shots, minus what this one actually conceded. Shots faced is
saves plus goals conceded, and goals conceded are attributed across a game's keepers by
minutes played. A keeper is identified from their whole season rather than one game — a
keeper who conceded three without making a save has no saves in that game, and judging per
game would let exactly the worst performances escape being counted.

What it deliberately does not claim: **nothing in a box score measures defending**, so a
centre back's number reflects their attacking contribution only. The site says so.

The qualifying bar scales with how much of the season has been played — about a third of
what the busiest tenth of players have on the clock, capped at 270 minutes once the season
is complete. A fixed bar is right in November and returns an empty leaderboard in August.

### Why the model is not refitted daily

A daily refresh adds last night's results. It does not learn anything new about how college
soccer works, and refitting anyway would move every parameter a little, which moves every
rating in every season a little, which rewrites eleven seasons of ratings, impact scores
and forecasts — tens of megabytes of churn committed every morning for no new information.

With the parameters held fixed, Elo is sequential: yesterday's games cannot change 2017's
ratings. Every completed season's files come out byte-identical run to run — verified, not
assumed — so a refresh diff contains only the season actually being played. Refitting is
therefore a deliberate act:

```
npx tsx apps/scraper/src/scripts/build_ratings.ts --refit
```

Two consequences worth knowing. The search starts from the stored parameters rather than
from the defaults, so a refit refines rather than restarts. And per-season output files
carry no build timestamp — a stamp alone would rewrite a megabyte of otherwise identical
JSON every morning, which is the whole problem again in miniature. The timestamp lives in
the index files.

### Does the roster tell us anything Elo cannot?

Elo cannot see that a team graduated its whole front line: a rating carries forward from a
squad that has since left, and a team returning everyone and a team returning nobody arrive
at the new season on the same number. **Returning production** — the share of a team's
previous-season impact that is back on the roster — can see it, and is applied as an
adjustment to the season carryover.

It is only kept if it earns its place. The weight is chosen on the training seasons and
then checked against the held-out ones, and the result of that check is printed by the
build and stored in `data/ratings/model.json`. If a run finds it does not generalise, the
weight is set to zero and the build says so rather than shipping it anyway.

Because it is computed from who appears in the new season's box scores, it is not available
before a team has played. In a backtest that is fine; live, it means week one is forecast on
carryover alone and the roster term arrives with the first box score.

Note that the two are fitted separately — the Elo search runs with the roster term off, and
the weight is chosen afterwards on top of the parameters it found. So this is not a case of
one absorbing the other. The carryover comes out gentler than you would guess for a sport
with this much turnover, and the roster term then adds a per-team correction on top, which
is the shape of the claim: a blanket regression treats the side that returned everyone and
the side that lost its front three identically, and one of those two is misrated either
way.

### The week-by-week predictor

`build_predictions.ts` forecasts a season the way it is played: ratings are frozen at the
start of each week, every fixture in that week is predicted from the frozen ratings, and
only then are the week's results applied. Predicting a Sunday game from ratings that
already contain Friday's result would produce a hit rate no forecast could have achieved,
and an accuracy figure that means nothing.

The same loop runs over the whole dataset, so every past week keeps the forecast it would
have been given at the time beside what happened — which is what makes the record on the
site checkable rather than a claim.

**The record, over 19,546 completed fixtures: 57.0% called correctly, log loss 0.923.** On
the two held-out seasons the model never saw while fitting, log loss is 0.947 against 1.053
for a forecast that knows only how often each outcome happens.

Accuracy is not comparable across the 2022 rule change, and the split is stark: 56–61% in
the overtime seasons against 53–56% since. Nothing about the model got worse. Draws went
from 12–13% of games to 22%, and a draw is the outcome a rating gap says least about — the
sport got harder to predict, not the model worse at predicting it. It is the clearest
argument for fitting the draw band per era rather than across the change.

### Five fixture bugs this exposed

All were invisible until something started counting games rather than listing them.

**Placeholder dates.** Where a Sidearm schedule row carries no date, some sites emit
January 1 of the season year, and a school's entire schedule lands on that day — Loyola
Chicago's eight opponents and Iona's twelve, all on 2026-01-01. Unplayed fixtures dated
before August 1 of their season are dropped as unparsed dates. Played ones are kept: spring
dates with a final score are real, since most of the country played its 2020 season in
spring 2021.

**Duplicate fixtures.** The storage layer merges the two schools' versions of a game on a
key built from the names as they were scraped, which catches most of it. What survives is
the pair each side spelled differently: Cal Baptist's site filed "Cal Baptist vs Denver"
and Denver's filed "California Baptist vs University of Denver", so the rows carry
different keys and both reach the models. About 4% of fixtures were affected. Left alone
they appear twice on a prediction page and, worse, move both teams' ratings twice for one
result — so fixtures are de-duplicated once the team names have been resolved, with the
row that has a result winning.

**Spellings nothing could resolve.** The harder half of the same problem: SMU's schedule
calls them "HCU" where Houston Christian's own says "Houston Christian", and a hundred
fixtures are filed under "Massachusetts" against UMass's own "UMass". No string rule joins
those without also joining something else wrongly, and roster overlap — which resolves the
same problem in the box scores — cannot help, because these spellings appear only as
opponents in `games.csv` and never as a box score with players in it.

The schedule itself can, because **a team plays one game a day**. If one row has SMU
playing "HCU" and another has SMU playing "Houston Christian" on the same date with the
same result, they are one fixture, so the two names are one school. Applied naively that
rule is dangerous — it made "Colgate" into Drake and "Coker" into Queens, real schools that
merely played on the same day as the team they were mistaken for — so it carries three
conditions: it only ever names an *unknown* spelling after a *known* one and only when the
known candidate is unanimous; the two names must never play each other; and the candidate
must account for most of the spelling's whole calendar rather than the one day that
suggested it. Exhibitions are excluded from the evidence entirely, since a friendly is the
one thing a team really does play alongside a real fixture on the same day — St. Thomas's
against Western Iowa Tech made that opponent Houston Christian until it was.

That resolves 50-odd spellings and, with the decoration fixes below, takes the dataset from
1,228 distinct team names to 920 without a single Division I programme losing a fixture.

**A short form that fits two schools.** Worse than a duplicate, because it is silently
wrong rather than visibly doubled. Dropping "College" from Boston College and "University"
from Boston University both yield "Boston", and the resolver answered with whichever it had
registered first — so Lehigh's Patriot League fixtures against Boston University were filed
as Boston College, with identical scores, across five seasons, and Boston College's rating
was built partly out of another school's results. The expansion also ran one-sided at
lookup time: "Boston" grew into "Boston University" and stopped, which looks like a
confident answer rather than the coin toss it is.

Both directions now refuse an ambiguous name rather than pick from it, in the scrape-time
resolver and in the analytics one. Unresolved is recoverable; the wrong school is not. The
rows already written keep the wrong name — the fix cannot recover a spelling the CSV no
longer holds — so `build_ratings.ts` counts them and says so, and they clear when those
seasons are next scraped.

**Rounds and brackets standing in for schools.** A conference tournament published before
its draw puts the round where the opponent goes, so "CAA Quarterfinals", "First Round",
"Pac-12 Tournament" and "Elon vs. UNC Asheville" were all teams with ratings and schedules.
So were "Alumni Game" and "Intrasquad Scrimmage". None of them is a school, and no school
has any of those words in its name, so they are dropped rather than rated.

**Two schools, two dates, one game.** Conference tournaments again: one school files the
semi-final on the Friday and its opponent on the Saturday, so the same 2-0 appears twice,
two days apart, and moves both ratings twice. Forty-one results were double-counted that
way. A pair within three days with an identical result is one fixture; two teams genuinely
meeting twice inside a week do not also produce the same scoreline both times.

**Decoration nothing stripped.** Each of these made a second school out of one, because an
undecorated name never matches the decorated row: the several-poll forms schools publish in
full ("No. 12/13/17 Virginia", "[9/4] Louisville", "14/9 UMass Lowell", "#37/- Boston
College"), bullets ("• Fort Wayne"), a round hung on the opponent rather than the fixture
("Boston College - ACC Semifinals", "Memphis -- Wolstein Classic"), the abbreviated
exhibition marker "(Exhib.)" — which fell between the pattern for "(EX)" and the one for
"exhibition", so those friendlies were not flagged as friendlies at all — and HTML entities
that were never decoded, which is why "William &amp; Mary" was its own programme.

### Outputs

| Path | What it holds |
| --- | --- |
| `data/season_coverage.json` | Per season: rosters found, games played, and the usable verdict |
| `data/ratings/model.json` | Fitted parameters, train/test scorecards, calibration curve |
| `data/ratings/team_ratings.json` | Current rating, rank, record, peak and per-season close |
| `data/ratings/elo_history.csv` | Every rated game with the ratings it was played at |
| `data/ratings/elo_timeline.json` | Each team's rating at the end of each week |
| `data/ratings/impact/<season>.csv` | Every player's season impact, per 90 and percentile |
| `data/ratings/standouts.json` | The ten best individual performances of each week |
| `data/predictions/<season>.json` | Every fixture's forecast, and what happened |
| `data/predictions/index.json` | The record by season and overall |

## Dashboard app (`apps/dashboard`)
A React 18 + Vite site in five views, sharing one search box and nothing else — each view
keeps its own season and filters, because a season of predictions and a season of career
totals are not the same selection and forcing them to share one would silently change what
a reader was looking at when they switch tabs.

```
npx tsx apps/scraper/src/scripts/run_pipeline.ts --only ratings,predictions,dashboard,analytics
cd apps/dashboard && npm run dev                              # http://localhost:5173
```

| View | What it answers |
| --- | --- |
| **Overview** | What is true right now: top of the table, this week's marquee fixtures, the players of the last week, conference strength, and the coverage notice for any excluded season |
| **Rankings** | The full Elo table, sortable and filtered by conference, with a rating-history chart for up to five chosen teams over the current season or the whole dataset |
| **Predictions** | Every fixture of every week with three probabilities, an expected scoreline and — for past weeks — what happened; plus the model's log loss by season against a base-rate forecast, and its calibration curve on the held-out seasons |
| **Player impact** | The impact leaderboard, rate against workload as a scatter, the top fifteen as a bar, and the players of each week |
| **Season stats** | The counting stats exactly as the box scores recorded them, with the filters, KPI cards, charts and movers panel described below |

**Charts** use one registration and one theme (`src/charts.ts`), and read their colours
from CSS custom properties so the palette has a single definition. The categorical series
palette is a validated set: checked against the card surface for lightness band, chroma,
colour-vision separation and contrast, with the worst adjacent pair separating by ΔE 8.4
under protanopia. Slots are assigned in fixed order and never cycled, and charts stop at
five series — the sixth validated slot falls below 3:1 against the card, and a sixth line
is past what anyone can hold against a legend. Home and away take the two poles of a
diverging pair with the draw as the neutral middle, because that is what those outcomes
are. Interface colours (the indigo accent) and series colours are kept strictly separate,
so a blue bar and a blue button never claim the same meaning.

**Filters** narrow by season, conference and team, plus free-text search over players,
teams and conferences. Conference and team are dependent: choosing a conference restricts
the team list to that conference's teams, so no combination of the two can produce an
empty result. Seasons render as a row of years rather than a dropdown: it is one click instead of two,
and it makes the dataset's span visible at a glance — including the hole where 2020 should
be, which a dropdown would hide.

**All-time** totals a player's career across every season, following them through
transfers. See **Who counts as one player** below.

**Biggest Movers** ranks who gained and lost the most goal contributions, in whichever
comparison the data supports:

- **Season over season** — a player against their own previous, completed season. Only
  players who appear in both count: someone arriving with 15 contributions after a season
  of none has not moved, they have shown up, and admitting them fills the list with
  freshmen.
- **Pace** — for the season currently being played, the same stretch of each year: what a
  player has through six games now against what they had through six games then. Totals
  cannot be compared while a season is in progress, or every player who scored last year
  is a faller until around November.
- **Late-season form** — the last three games against the three before them, for the
  earliest season in the dataset, which has nothing behind it.

The mode is chosen per season at generation time, so seasons switch between them on their
own as the season progresses and as the backfill fills in the year before them. The panel
is hidden on the all-time view, which has no season behind it to move against. The panel
ranks whatever the filters leave rather than a precomputed national top ten — a
leaderboard that ignores the conference you just selected answers a question you did not
ask — which is why each player carries their own before/after numbers.

## Who counts as one player
`player_key` in the CSVs is `team:name`, with the team spelled as that box score spelled
it, so a player is several keys whenever their school was written more than one way. Aidan
Davock's 2023 arrived as `colgate:`, `colgateuniversity:` and `colgateplsemifinals:` —
three rows splitting one 13-game season, and three entries in every leaderboard. Rows are
re-keyed onto the canonical team and summed at generation, which removed about 2,000
phantom players per season.

Following a player **between** schools is the harder half, and all there is to go on is a
name — and *when* they played, which matters more than it looks. Names are not unique:
4,178 of them appear at two schools in the same season, which is proof of two different
people. So a name is only followed across schools when its stints never overlap — one
player cannot be on two rosters at once. Where a name overlaps
anywhere, none of its stints are joined, because nothing in the data says which of the
several people a given stint belongs to. That leaves some genuine transfers split rather
than risk welding two strangers into one career; roughly 4,200 careers span more than one
school.

## Two fixtures, one box score
A box-score URL that several fixtures point at cannot be the box score of any of them.
Some schools publish a single stale link on every schedule row — Winthrop serves
`boxscore.aspx?id=23965` for its whole season — so that one game's players were scraped
once per fixture and credited with the same goals four or five times over, in every
season. Pablo Ortega's two goals in one game became eight a season, five seasons running.

It affected 2–4% of games per season. Which fixture the page belongs to is not recoverable
from it, so the whole ambiguous group is dropped rather than attributed to a guess. The
box-score stage now refuses them while scraping, and `prune_ambiguous_boxscores.ts`
removed the ~11,000 rows collected before that.

**Data** is written by `generate_dashboard_data.ts` as `src/data/seasons/<year>.json` plus
a `manifest.json` index. The split matters: a season is ~2 MB of JSON, so the page loads
the manifest eagerly — it is what the filter controls are built from — and fetches a
season only when it is selected. Vite code-splits each season into its own chunk.

Two fields are added during generation because the CSVs do not carry them: `season`, and
`conference` looked up by team name against the inventory. Team names are also
canonicalised across seasons — including for schools the inventory does not hold, whose
spellings have nothing to normalise them against — so "Colgate" and "Colgate University"
reach the team filter as one school and a selected team survives a change of season.

Around **35% of player rows fall under `Other / Non-D1`**, and that is mostly real rather
than a matching failure. A season's box scores name ~350 teams against an inventory of
197: schools play preseason exhibitions against nearby D2, D3 and NAIA programs, and those
opponents' full rosters get scraped like anyone else's. Every unmatched team has a
complete roster behind it, not a stray row. The rest is the handful of D1 programs
discovery has not resolved. They are labelled rather than hidden, because dropping a third
of the players would misstate every season total on the page.

If you would rather the dataset were D1-only, the lever is the exhibition flag: the parser
already marks those fixtures (`cleanTeamName().exhibition`), so the box-score stage could
skip them. That is a change in what the dataset means, so it has not been made.

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

## Coverage
`data/games` and `data/player_stats` hold **2016–2026**, scraped against the full
inventory: roughly 2,000–2,350 completed games per season, and 8,300–13,200 players. 2026
is in progress and grows with each scheduled refresh.

**Ten of the eleven seasons are usable. 2020 is excluded**, by the coverage gate rather
than by hand: only 22 of 197 programs have a roster in it and only 83 games were played,
because most of Division I moved that season to spring 2021 — where this dataset files it,
since each scrape keeps only the games falling in its own calendar year. Every other season
has a roster for 98–100% of the inventory.

| Season | Rosters | Played | Players | |
| --- | --- | --- | --- | --- |
| 2016 | 194/197 | 2,328 | 12,379 | |
| 2017 | 195/197 | 2,295 | 12,714 | |
| 2018 | 196/197 | 2,250 | 13,210 | |
| 2019 | 196/197 | 2,238 | 11,676 | |
| 2020 | 22/197 | 83 | 697 | **excluded** |
| 2021 | 197/197 | 2,083 | 9,942 | |
| 2022 | 197/197 | 2,062 | 8,773 | |
| 2023 | 197/197 | 1,999 | 8,597 | |
| 2024 | 197/197 | 1,997 | 8,766 | |
| 2025 | 197/197 | 1,956 | 8,350 | |
| 2026 | 195/197 | 338 | 6,095 | in progress |

The player counts fall over time because the *inventory* does not: the earlier seasons
carry more opponents from outside Division I, whose rosters are scraped like anyone's. The
Division I share is flat — 3,400–3,800 players clear the impact qualifying bar in every
completed season. Per-fixture box-score coverage declines gently going back, from 91% of
played games with both teams' box scores in 2025 to 80% in 2016.

Conference labels are current (2026-27) alignment throughout, because the roster the
inventory is built from lists current membership. A school that changed conference is
therefore filed under its present one even in a 2016 row — and a programme that has since
moved *up* to Division I appears in the early seasons playing a schedule its Elo shows was
not a Division I one. The per-school game and player
data is unaffected; only the `conference` field is approximate for past seasons.

**16 D1 programs are still unresolved** and absent from the inventory: West Florida,
Albany, Bakersfield, Cal State Northridge, Elon, Green Bay, NIU, Bowling Green, Fairleigh
Dickinson, LIU, UIW, SIU Edwardsville, Holy Cross, Bradley, Central Connecticut and
Colgate. They appear in the data as opponents, under `Other / Non-D1`. Discovery picks up
stragglers as coverage grows — re-running it after a backfill resolved Grand Canyon,
Niagara and UTRGV — so it is worth re-running periodically:

```
npx tsx apps/scraper/src/scripts/discover_teams.ts data/teams/d1_msoc_rosters.json 2025 /tmp/probe
```

Writing to a scratch directory first is deliberate: run against `data/teams` it merges
non-destructively, but a scratch run shows exactly what it would add without touching the
inventory. Note that a scratch run appears to *drop* schools it failed to resolve — that
is the absence of an existing file to merge with, not a real removal.

`data/teams/test_teams.json` is a stale two-team fixture that still claims Stanford and
Virginia Tech are Sidearm (they are WMT). It is excluded from validation and discovery.

The whole-repo `git status` noise is a CRLF→LF artifact of the original checkout, not real
edits.

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
No language model is involved at any step; the statistical models are fitted from the data
and described under **Ratings, forecasts and player impact**. One command runs the lot:

```
npx tsx apps/scraper/src/scripts/run_pipeline.ts --season 2025
```

The stages underneath it, if you would rather drive them yourself. The first three run
once per season; the rest run once over the whole dataset, and in this order — `ratings`
decides which seasons are usable and fits the models, and everything after it reads that
verdict and those parameters.

0. **Seed teams**: `npx tsx apps/scraper/src/scripts/discover_teams.ts rosters.json 2025`,
   or edit `data/teams/*.json` directly. Not part of `run_pipeline.ts`; the inventory
   changes far less often than the data does.
1. **Fetch schedules**: `npx tsx apps/scraper/src/scripts/fetch_schedules_parallel.ts data/teams/d1_msoc_teams.json 2025`.
2. **Fetch box scores**: `npx tsx apps/scraper/src/scripts/fetch_boxscores_from_csv.ts data/games/2025/games.csv`.
3. **Aggregate**: `npx tsx apps/scraper/src/scripts/aggregate_player_stats.ts 2025`.
4. **Ratings**: `npx tsx apps/scraper/src/scripts/build_ratings.ts` — coverage verdict,
   Elo and forecast models, player impact, weekly standouts. It **reuses** the parameters
   in `data/ratings/model.json` rather than refitting; `--refit` searches them again, and
   `--quick` uses the built-in defaults without either. See **Why the model is not
   refitted daily**.
5. **Predictions**: `npx tsx apps/scraper/src/scripts/build_predictions.ts`.
6. **Dashboard**:
   - Player JSON: `npx tsx apps/scraper/src/scripts/generate_dashboard_data.ts 2025`.
   - Ratings, forecasts and impact JSON: `npx tsx apps/scraper/src/scripts/generate_dashboard_analytics.ts`.
   - Run UI: `npm run dev` in `apps/dashboard`.

The whole fitting-and-writing tail is a couple of minutes and needs no network, so
`--only ratings,predictions,dashboard,analytics` is the command to re-run after changing a
model.

## Running it unattended
The pipeline is meant to run without anyone watching it, in two modes with quite
different shapes.

### In season: a daily refresh
`.github/workflows/refresh.yml` runs at 09:00 UTC from August through December — early
morning in the US, so the previous evening's games have final box scores by then. It runs
the current season, commits whatever changed under `data/`, and does nothing quietly if
nothing changed.

It runs `--incremental`, which fetches only box scores that are missing or recent. A
season is ~1,800 games and re-fetching all of them takes about an hour; asking for that
daily, to learn about the handful played last night, is an hour of pointless load on
schools' sites every morning. Games played within the last three days are still
re-fetched, because a box score published minutes after full time is routinely corrected
afterwards.

The refresh depends on `ci.yml` passing first. It commits to the repository unsupervised,
so the tests are the only thing between a bad parser change and a season of corrupted
CSVs.

### Backfilling past seasons
Deliberately not scheduled — it is hours of scraping whose output is worth looking at
before it lands.

```
npx tsx apps/scraper/src/scripts/run_pipeline.ts --seasons 2016-2020
```

Roughly 75 minutes per season, nearly all of it box scores, so five seasons is on the
order of six hours. Pass `--skip dashboard,analytics` if the fitting tail will be re-run
by hand at the end; there is no point rebuilding the site after each season. It will be interrupted — a laptop sleeps, a runner times out, a site
rate-limits — so each stage records itself in `data/pipeline_state.json` as it completes
and re-running the same command resumes from the first stage that has not. `--force`
ignores that record and re-runs everything.

`--dry-run` prints the plan, including which stages would be skipped as already done and
which files the row guard will be watching.

### The row guard
Each per-season stage writes one CSV, and `run_pipeline.ts` counts its rows before the
stage runs and again afterwards. A stage that exits 0 but leaves the season more than a
few percent smaller than it found it is treated as failed, and the rest of that season is
abandoned rather than aggregated and rated.

This is the cheap half of the pair; the golden fixtures under
`packages/parsers/src/__fixtures__` are the other. The fixtures catch a parser that stops
understanding a page we have a copy of. The row guard catches everything else — a school
re-theming a page nobody has a fixture for, a consent wall served to datacentre IPs, a
site that starts rate-limiting halfway through the inventory. None of those raise, and
all of them end with a thinner file than yesterday's.

`--max-drop <percent>` moves the tolerance, which defaults to 3. `--no-row-guard` turns
the check off, for the rare rebuild that really is meant to shrink a season. It never
compares against anything but that season's own history, so the first scrape of a new
season is unguarded — there is nothing yet to have lost.

### The preflight
Before any scraping, `run_pipeline.ts` samples a few schools per platform and checks that
each actually publishes the requested seasons, failing the run if one returns nothing.
All three platforms were confirmed to serve 2016–2025 this way — 2020 comes back visibly
thin, which is the COVID season being real rather than the probe failing, and is what the
coverage gate is there to judge. It exists because the
failure it catches is silent: a school that serves the current season whatever year is
asked for produces a season file that looks full and holds the wrong year, and the
expensive stage runs behind it. Run it alone with:

```
npx tsx apps/scraper/src/scripts/preflight_seasons.ts 2016 2017 2018 2019 2020
```

## Build/test notes
- **Build**: `npm run build` builds all workspaces.
- **Test**: `npm test` builds, then runs the unit tests under `apps/scraper/src/tests`.
  They cover the failures that are silent in this codebase, none of which throw and none
  of which show up without a test:
  - a school entering the inventory twice under two spellings, and a decorated name
    ("(rv) Delaware") becoming a second team (`names`, `school_names`);
  - Elo that is not zero-sum, a season gap that regresses ratings only once, a duplicate
    fixture moving both teams twice for one result, a draw band fitted across the 2022
    overtime rule change, a goalkeeper credited with expected *saves* rather than expected
    goals conceded, and a per-90 rate with no shrinkage putting a twenty-minute substitute
    top of the country (`analytics`).
  - a parser that stops understanding a page it used to read (`golden_fixtures`). One
    real, unedited response per platform is stored under
    `packages/parsers/src/__fixtures__` — a Sidearm schedule and box score, a WMT
    `/website-api` season payload, an `api.wmt.games` stats payload, and one WordPress
    page per theme — and each is parsed and compared against its complete output, every
    row and every field. Asserting a count would pass for most of the ways these break;
    see that directory's README before refreshing one.
- **Validate**: `npm run validate` schema-checks every team inventory.
- **Playwright**: Required for parallel fetching scripts.
- **Lint**: `npm run lint` (dashboard has its own strict config).

Note that `@ncaa/parsers` is consumed from its `dist/`, so a change to
`packages/parsers/src` does not take effect until `npm run build` runs. `npm test` builds
first for this reason.
