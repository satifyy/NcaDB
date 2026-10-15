-- Positions, starters and goalkeeping, as box scores publish them.
--
-- Additive only: every new column is nullable or defaulted, so rows loaded before this
-- migration stay valid and the API's existing queries are unaffected.
--
--   position         the label the box score printed (`GK`, `def`, `M`), verbatim. It is
--                    the slot filled in that game, not a property of the player.
--   position_group   GK | DEF | MID | FWD, mapped from `position` by the worker
--                    (`positionGroup` in @ncaa/shared). NULL when the label was absent,
--                    combined ("D/M") or unrecognised.
--   started          from the box score's Starters/Substitutes split; NULL when it had none.
--   goals_allowed    the keeper's goals against as the goalkeeping table printed them.
--                    NULL for everyone without a keeper record, and wherever the box
--                    score had no goalkeeping table. Never inferred here.
--   capture_version  what the row is known to carry. 1: loaded before positions were
--                    captured, and `saves` = 0 may mean "not published". 2: positions,
--                    starters and keeper data were captured where published, and NULL
--                    saves / goals_allowed mean "not reported". `backfill-capture`
--                    re-reads rows below the current version.

ALTER TABLE player_game_stats
    ADD COLUMN position         text,
    ADD COLUMN position_group   text CHECK (position_group IN ('GK', 'DEF', 'MID', 'FWD')),
    ADD COLUMN started          boolean,
    ADD COLUMN goals_allowed    smallint CHECK (goals_allowed >= 0),
    ADD COLUMN capture_version  smallint NOT NULL DEFAULT 1 CHECK (capture_version >= 1);

-- Backfill progress (`WHERE capture_version < n` per season) and positional rankings.
CREATE INDEX player_game_stats_capture_idx ON player_game_stats (season_id, capture_version);
CREATE INDEX player_game_stats_group_idx ON player_game_stats (season_id, position_group)
    WHERE position_group IS NOT NULL;
