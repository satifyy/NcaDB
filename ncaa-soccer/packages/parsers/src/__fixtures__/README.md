# Golden fixtures

One real, unedited response per platform the scrapers read, captured on 2026-09-03 for
the 2025 season. `apps/scraper/src/tests/golden_fixtures.test.ts` parses each of these
and asserts the complete parsed output — every row, every field.

They exist because every failure mode of this codebase is silent. A school re-themes its
schedule page and the selector stops matching; a JSON field is renamed and the score
comes back `null`; a date shifts by a day because a timezone assumption changed. None of
that throws. The scrape "succeeds", writes fewer or emptier rows, and the pipeline
carries on. A fixture with the answer written down turns that into a failing build.

| File | Source | Parser |
| --- | --- | --- |
| `sidearm_schedule_duke_2025.html` | `https://goduke.com/sports/mens-soccer/schedule/2025` | `SidearmParser.parseSchedule` |
| `sidearm_boxscore_duke_syracuse_2025.html` | `https://goduke.com/sports/mens-soccer/stats/2025/syracuse/boxscore/24396` | `SidearmBoxScoreParser.parse` |
| `wmt_schedule_events_clemson_2025.json` | `https://clemsontigers.com/website-api/schedule-events?filter[schedule_id]=4&…` | `WmtParser.parseEvents` |
| `wmt_stats_clemson_south_carolina_2025.json` | `https://api.wmt.games/api/statistics/games/6391107?with[0]=players` | `WmtBoxScoreParser.parseStats` |
| `wordpress_schedule_kentucky_2025.html` | `https://ukathletics.com/sports/msoc/schedule/2025` | `WmtWordpressParser.parseSchedule` (`.schedule-item` theme) |
| `wordpress_schedule_south_carolina_2025.html` | `https://gamecocksonline.com/sports/msoc/schedule/2025` | `WmtWordpressParser.parseSchedule` (`.schedule-table_row` theme) |

The two Sidearm pages are Nuxt apps whose schedule and box-score tables are built from a
`__NUXT_DATA__` hydration blob rather than served as markup, so they are stored as
Playwright rendered them — `page.content()` after the same navigation, view-toggle and
scroll the pipeline performs — which is the string `SidearmParser` actually receives. The
other four are plain HTTP responses, byte for byte.

## Re-capturing

Do not hand-edit these. Stripping the analytics scripts or minifying the markup makes the
fixture a description of what we assumed the response looks like instead of a record of
what it is, and the paths that break in production are the ones nobody thought to keep.

Refresh one only when the assertions change for a reason you can name — the site really
did change, or a parser fix really did alter the output. Re-fetch the URL above, replace
the file, re-run the test, and read the diff line by line before accepting it: that diff
is the entire value of the exercise.

The season is fixed at 2025 and every game in it has been played, so a correct parser
returns the same answer forever. A fixture pinned to the current season would go red
every time a game kicked off.
