# Team of the Week

Every week, the eleven best-performing Division I players, in a 4-3-3, chosen from box-score
statistics alone and ranked only against players in the same position group. Shown on the
Overview page; served by `/api/v1/team-of-week`.

| | |
| --- | --- |
| Model | `totw-1` — `packages/database/src/totw/model.ts` (weights and rules in one place) |
| Computation | `packages/database/src/totw/store.ts`, run by the worker after every load |
| Tables | migration 006: `totw_model_versions`, `totw_weeks`, `totw_player_weeks`, `totw_selections` |
| API | `apps/api/src/routes/teamOfWeek.ts` |
| UI | `apps/dashboard/src/components/TeamOfWeek.tsx` |
| Tests | `packages/database/test/totw_model.test.ts`, `totw_store.test.ts`, `apps/api/test/team_of_week.test.ts`, smoke test |

## 1. What the data supports

Audited on the 2016–2026 CSVs and the production coverage report before anything was built.

| Statistic | Stored | Reliability | Used |
| --- | --- | --- | --- |
| Minutes | yes | good — 98% of team-games sum to ~990 | eligibility, pro-rata goals conceded |
| Goals, assists | yes | good — player goals exceed the score in ~10 games a season | yes |
| Shots, shots on goal | yes | good | shots on target that were not goals (small credit) |
| Result, team goals for/against | yes (schedule score) | good | result bonus, clean sheets, goals conceded |
| **Position** | **from migration 005** | published per game by every platform; see §2 | position groups |
| Starter / substitute | from migration 005 | published by every platform | stored, not scored |
| **Keeper saves** | yes | **before capture v2, missing in 48% of box scores and stored as 0** | only where reported (v2) |
| Keeper goals allowed | from migration 005 | official where the goalkeeping table exists | official, or inferred (§3.4) |
| Cards, fouls | WMT schools only | partial | no |
| Tackles, interceptions, passes, pressures | **not published** | — | **no** |
| Opponent strength (Elo) | derived artifact | season-end ratings | **no** (would leak future results into past weeks) |
| Competitions | NCAA Division I men's only | — | one competition |

Box-score coverage is 80% (2016) to 92% (2025–26) of final games: about 150–200 box scores
in a regular-season week.

### Why positions needed an ingestion change

Every platform publishes positions — Sidearm's hydration data (`gk`, `def`, `mid`, `fwd`) and
rendered tables (`GK`, `DEF`, `MID`, `FWD`), the WMT feed (`GK`, `D`, `M`, `F`) — and the
parsers read them into a free-form map that the CSV writer then dropped. The 48% of box scores
without saves were the 94 schools whose Sidearm layout publishes goalkeeping in a separate
"Goalie Statistics" table, which the captioned-table reader skipped; every keeper there was
stored with 0 saves. Capture version 2 fixes both (see `docs/DATABASE.md`).

## 2. Position classification

- The **raw label is stored verbatim** (`player_game_stats.position`).
- It is mapped to `GK | DEF | MID | FWD` by `positionGroup` (`packages/shared/src/positions.ts`).
  Combined labels (`D/M`, `MF/FW`, `FM`) and unknown labels map to **nothing**: those rows are
  excluded from positional ranking and counted in the week's completeness, never guessed.
- A box score lists the slot a player filled **in that game**. A player is ranked for the week
  in the group they played the most minutes in (latest game breaks a tie), and only games in
  that group count — so nobody can take two places.
- Sources give the broad group only, so the 4-3-3 has four defenders, three midfielders and
  three forwards **without** LB/CB/RB or LW/ST/RW assignments.
- Positions are never inferred from who scored or who made saves.

### Measured coverage after capture v2 (2026, development copy)

Measured on the 2026 season re-read into a development database on 2026-10-15: 1,236 of
1,245 stored games at capture v2 (9 failed to fetch and remain v1 until the next
`backfill-capture`). Production is unchanged until the deployment is approved.

| Measure | Result |
| --- | --- |
| Division I player-games (minutes > 0) with a valid group | **94.7%** (95.3% of the 60+ minute rows that can be rated) |
| No label at all | 5.6% of all played rows: mostly substitutes, and opponents whose host site left the column blank |
| Combined labels (`FM`, `MD`) | 0.1% |
| Starter flag known | 100% |
| Team-sides with an identified keeper | 100% (145 sides used two keepers) |
| Team-sides with saves reported | 100% (≈52% before the fix) |
| Saves = opponent shots on goal − goals | 89.8% exactly, 99.0% within one (46–49% exactly before) |
| Official keeper goals allowed = opponent's score | 99.1% |


## 3. The rating model (`totw-1`)

### 3.1 Which rows count

A row is rated only if all hold: the game is `final` and not an exhibition; the player's team
is Division I; the row was captured at version 2; it has a position group and minutes; the
player played **60+ minutes (keepers 80+)** in that game. Anything else is not evidence — not
a zero.

### 3.2 Game score (points)

| Component | GK | DEF | MID | FWD | Why |
| --- | --- | --- | --- | --- | --- |
| Goal | 2.0 | 1.5 | 1.2 | 1.0 | a goal from deeper is rarer within its group |
| Assist | 0.7 | 0.7 | 0.7 | 0.7 | |
| Shot on target **not** scored | 0.1 | 0.1 | 0.1 | 0.1 | threat without double-counting the goal |
| Win / draw (60+ min) | 0.3 / 0.1 | same | same | same | small: team context, not individual merit |
| Clean sheet (60+ min) | 1.5 | 1.0 | 0.3 | — | the only defensive evidence the sources publish |
| Goals conceded, pro rata to minutes | — | −0.25 each | — | — | charged only for the share of the game played |
| Goals allowed (keeper) | −0.5 each | | | | |
| Save (only where reported) | +0.25 each | | | | |

A game against a team **outside Division I** counts at **0.75×** its positive score (shown as
its own component). Off-target shots score nothing, so shooting volume is not rewarded. Minutes earn nothing
beyond the eligibility threshold.

### 3.3 Week score, rating, ranking

- **Week score = 0.75 × best game + 0.25 × mean game.** Averaging (not summing) means a
  two-game week cannot win on accumulation: a hat trick in one game beats one goal in each of
  two. The best-game weight still rewards a second strong game over a quiet one.
- Players are ranked **within their position group** by week score. Ties break on best game,
  then fewer minutes, then player id — fully deterministic (tested by permuting inputs).
- The **0–10 rating** is `10 × (1 − e^(−score / s))`, where `s` is the 90th-percentile week
  score in the player's group that week: that percentile rates 6.3, twice it 8.6, three times
  9.5, and 10 is never reached. Week scores are heavily right-skewed, so a z-score scale put
  most of each XI at the ceiling (found in backtesting). It compares players within a group
  and week, not across groups.
- A week needs **at least 20 captured games** for an XI; below that the week is stored with
  `published: false` and the site says so.
- The XI is the top 1 GK, 4 DEF, 3 MID and 3 FWD. A group with too few eligible players leaves
  **empty places**; nothing is borrowed from another group.
- Best in each group = the group's #1; honorable mentions = the next two in each group.

### 3.4 Missing statistics

- **Saves not reported:** no saves credit, no penalty, and the player's `missing` list says so.
- **Keeper goals allowed:** *official* when the goalkeeping table printed it. Otherwise
  *inferred* from the final score **only** when this keeper was the team's only keeper and
  played the whole game; the API returns `goals_allowed_source: "inferred"` and the UI labels
  it "from the score". In any other case (two keepers, subbed off) the game is not rated.
- **Shots on goal missing:** no shots credit; flagged.

## 4. Weeks, publication and corrections

- A week is **Monday–Sunday by game date**, which is the local calendar date of the game
  (America/Chicago is the site's reference for "today").
- `in_progress` until Sunday ends; `provisional` for **8 days** after (the nightly scrape
  re-reads box scores for 7 days after a game); `final` after that.
- The worker recomputes every week of the loaded season after each load, but each week is
  hashed from exactly the rows the model reads plus the model version: an unchanged week is
  skipped; a changed one is replaced in one transaction. A changed week that already existed
  raises its `revision` (shown as "revised N times after corrections"); a status change alone
  does not.
- Changing a weight means a new `MODEL_VERSION`; old weeks keep the version and weights they
  were ranked by (`totw_model_versions`).
- Each week stores completeness: final games, games with box scores, games captured at v2,
  share of player rows with a position, keeper rows with official goals allowed and with
  saves. The UI shows it beside the status.

## 5. API

All public, read-only, cacheable (`Cache-Control` as the rest of the API, plus an `ETag` that
changes exactly when the week is recomputed). Filters: `season` (year) and `competition`
(`ncaa-d1-msoc`, the only one stored).

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/team-of-week` | the newest week with at least one selected player |
| `GET /api/v1/team-of-week/weeks` | every computed week, newest first: start, end, status, revision, filled places |
| `GET /api/v1/team-of-week/:date` | the week containing `YYYY-MM-DD` (404 if not computed) |

A week response: `week` (start, end, season, competition, status, revision, computed_at,
completeness, previous/next), `formation`, `xi` (11 slots, `player: null` when empty),
`filled`, `best` (per group), `honorable_mentions` (per group), `model` (version, summary,
weights, rules). Each player: id, name, team, position group and raw label, rating, score,
rank, games, minutes, `missing`, a plain-language `explanation`, and `game_log` — every rated
game with opponent, score, minutes, statistics, keeper goals allowed and its source, and the
score components.

## 6. Operations

| Task | Command |
| --- | --- |
| Recompute a season | `npm run worker -- team-of-week --season 2026` |
| Re-read box scores captured before v2 (bounded, resumable) | `npm run worker -- backfill-capture --season 2026 [--limit 150]` |

Nightly, backfill, backfill-capture and refresh-game runs compute Team of the Week for the
seasons they loaded, as their own `team_of_week` task after the load and read-model refresh.

## 7. Backtest: 2026 weeks 1–9

Computed on the development copy; full weeks Aug 17 – Oct 11 (8 published weeks, 88 picks),
plus the in-progress week of Oct 12.

| Check | Result |
| --- | --- |
| Weeks with an XI | 9 of 11; the weeks of Aug 3 (3 games) and Aug 10 (5 games) have none (`too_few_games`) |
| Places filled | 11 of 11 in every published week |
| Distinct players | 81 across 88 picks; at most 2 from one team in a week |
| Two-game weeks among picks | 30.7%, against 28.8% of all rated player-weeks — no accumulation bias |
| Picks with a game against a non-Division I opponent | 2.3% (12.9% before the 0.75× weight) |
| Keepers picked on inferred goals allowed | 0% (official figures everywhere in v2 data) |
| XI ratings | 7.6–9.8, mean 8.9 |

**Surprising selections inspected.**

- *Two Seattle forwards in one XI* (week of Sep 28): separate hat tricks in separate games —
  Notzka in a 4–2 win over Saint Mary's, Flores in a 3–3 draw with Pacific, both Division I.
  Both also scored twice in the same 6–1 win over UC Davis a month earlier. Legitimate.
- *Zach Ramsey (Washington), selected four times:* a midfielder with 4 goals in week 1 and
  repeated multi-goal games against Big Ten opponents; in quiet weeks he ranks #31 and #263.
  Legitimate.
- *Before the changes:* the week of Aug 10 picked a full XI from one captured game, two
  Wisconsin forwards were picked on a game against a non-Division I side, and six of the
  Oct 5 XI rated 10.0. Each led to a rule above: the 20-game minimum, the 0.75× weight and
  the non-saturating rating curve.

Example, week of Oct 5 (provisional when computed):

| Pos | Player | Team | Rating | Why |
| --- | --- | --- | --- | --- |
| GK | Hugo Amo | Evansville | 7.6 | 16 saves, 1 clean sheet, 4 allowed in 2 games |
| DEF | Maguire Perkins | Omaha | 8.9 | goal, clean sheet, win |
| DEF | Joey Buchanan | Marquette | 8.9 | goal, clean sheet, win |
| DEF | Henrique Cruz | Memphis | 8.8 | goal, clean sheet, win |
| DEF | Cole Dougherty | Fairfield | 8.8 | goal, clean sheet, win |
| MID | Ryan Zellefrow | North Carolina | 9.8 | 2 goals, 3 assists |
| MID | Uzman Ramees | Cleveland State | 9.2 | 2 goals, 3 assists in 2 games |
| MID | Tom Mertz | Cleveland State | 9.0 | 1 goal, 3 assists in 2 games |
| FWD | Joschi Schelb | North Carolina | 9.3 | hat trick and an assist |
| FWD | Xavier Gagnon | Western Illinois | 8.6 | 2 goals, 1 assist in 2 games |
| FWD | Renan Syrio | Memphis | 8.6 | 2 goals, 1 assist |

## 8. Performance (development copy, local Postgres 16)

| | |
| --- | --- |
| Compute a full season (11 weeks, ~42k rows read) | 1.24 s |
| Nightly no-op (nothing changed) | 0.73 s |
| `GET /team-of-week` | 11 ms cold, 17 KB (3 KB compressed) |
| `GET /team-of-week/:date` | 4–5 ms |
| `GET /team-of-week/weeks` | 2 ms |
| Conditional request with the ETag | 304 |


## Known statistical limitations

- **Defenders are judged mostly by team outcomes.** Without tackles, interceptions or
  passing data, a defender's score is clean sheets, goals conceded while on the field, and
  attacking returns. A dominant defender on a leaky team will be undervalued.
- **No opponent-strength adjustment within Division I.** Apart from the blunt 0.75× for
  non-Division I opponents, a hat trick against a weak Division I side counts the same as one
  against a top-10 team. The existing Elo ratings are season-end values and
  would leak future results into past weeks; a point-in-time rating is the obvious `totw-2`.
- **Substitution times are unknown**, so goals conceded are shared pro rata by minutes, and a
  keeper's goals allowed are inferred only in the unambiguous case.
- **60-minute threshold.** A substitute who scores twice in 30 minutes is not rated that game.
- **Positions are the box score's.** A forward listed as `mid` by their school is a midfielder
  here. Combined labels are excluded.
- **Coverage is not complete.** Games without a box score (PDF-only sources, ~8–10%) cannot
  contribute; their players are simply absent that week.
- **Only seasons re-read at capture v2 have weeks.** Older seasons need `backfill-capture`.
