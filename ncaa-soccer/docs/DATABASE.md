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

Before a name is resolved, rank and seed markers ("19 Cornell", "#21/#15 UNC Greensboro",
"4-Seed Charlotte"), trailing rounds and seeds ("(Sweet 16)", "(#3 Seed)") are stripped,
and bracket placeholders, conference names and intrasquad games ("ELITE 8", "COLLEGE CUP",
"Coastal Athletic Association", "Blue & Gold Game") are refused. A trailing state
disambiguator ("Holy Cross College (Ind.)") keeps a school apart from the Division I
program it resembles unless that program's own spellings carry it. Two inventory entries
that would answer to the same spellings stop the load instead of merging silently.

When a stored game's teams resolve differently on a later load, the loader moves it to its
new key (keeping its id and box score) or merges it into the game already there, and a
box-score row left filed under a team that is no longer either side is replaced once the
batch has stored that game's box score for both sides. See `renormalize` and
`reconcile-identities` in OPERATIONS.md.
| Player game stat | `(game, player, jersey)` | One name at two numbers in a box score is two people. |

## Tables

- `sports`, `competitions`, `seasons`, `conferences` — reference data.
- `teams` — `inventory_id`/`is_division_one` for the 213 Division I programs: the 197 the
  scraper covers (`data/teams/d1_msoc_teams.json`) and the 16 it does not
  (`d1_msoc_unscraped.json`, from the conference rosters in `d1_msoc_rosters.json`), whose
  games are known only from opponents' schedules. Opponents outside Division I are teams
  too, flagged false. The flag is not per season (a program that changed division is
  classified by its current membership).