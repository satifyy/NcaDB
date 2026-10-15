-- Team of the Week, precomputed by the worker after each load.
--
-- The API only reads these tables. They are rebuilt from player_game_stats, so they hold
-- nothing that cannot be recomputed: a week whose inputs have not changed is left alone,
-- and one whose inputs changed (a corrected box score, a late one) is replaced whole, in
-- one transaction, with its revision counter raised.
--
-- Privileges come from 002's default privileges for tables the owner creates: the
-- worker reads and writes them, the API reads them, and nothing else changes.

-- The weights and rules each model version ranked by, so a past week stays explainable
-- after the weights move on.
CREATE TABLE totw_model_versions (
    version         text PRIMARY KEY,
    weights         jsonb NOT NULL,
    rules           jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE totw_weeks (
    id                  bigserial PRIMARY KEY,
    season_id           integer NOT NULL REFERENCES seasons(id),
    -- Monday to Sunday by game date, which is already the local calendar date.
    week_start          date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
    week_end            date NOT NULL CHECK (week_end = week_start + 6),
    model_version       text NOT NULL REFERENCES totw_model_versions(version),
    -- in_progress: the week has not ended. provisional: ended, but box scores are still
    -- inside the scrapers' seven-day correction window. final: the window has closed.
    status              text NOT NULL CHECK (status IN ('in_progress', 'provisional', 'final')),
    -- Raised each time the inputs changed after the first computation.
    revision            integer NOT NULL DEFAULT 0,
    inputs_hash         text NOT NULL,
    completeness        jsonb NOT NULL DEFAULT '{}',
    first_computed_at   timestamptz NOT NULL DEFAULT now(),
    computed_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (season_id, week_start, model_version)
);
CREATE INDEX totw_weeks_start_idx ON totw_weeks (week_start DESC);

-- Every eligible player's week, not only the eleven: the positional rankings, the
-- honorable mentions and each player's breakdown all come from here.
CREATE TABLE totw_player_weeks (
    week_id         bigint NOT NULL REFERENCES totw_weeks(id) ON DELETE CASCADE,
    player_id       bigint NOT NULL REFERENCES players(id),
    team_id         integer NOT NULL REFERENCES teams(id),
    position_group  text NOT NULL CHECK (position_group IN ('GK', 'DEF', 'MID', 'FWD')),
    position        text,
    group_rank      integer NOT NULL,
    rating          numeric(3, 1) NOT NULL,
    raw_score       numeric(7, 3) NOT NULL,
    best_game       numeric(7, 3) NOT NULL,
    mean_game       numeric(7, 3) NOT NULL,
    games           smallint NOT NULL,
    minutes         smallint NOT NULL,
    -- Statistics the box scores did not report for at least one of the rated games.
    missing         text[] NOT NULL DEFAULT '{}',
    explanation     text NOT NULL,
    -- The rated games, each with its score components and source game id.
    detail          jsonb NOT NULL,
    PRIMARY KEY (week_id, player_id)
);
CREATE INDEX totw_player_weeks_rank_idx ON totw_player_weeks (week_id, position_group, group_rank);
CREATE INDEX totw_player_weeks_player_idx ON totw_player_weeks (player_id);

-- The XI, slots 1-11 in 4-3-3 order. An empty slot (player_id NULL) is a group with too
-- few eligible players that week; it is never filled from another group.
CREATE TABLE totw_selections (
    week_id         bigint NOT NULL REFERENCES totw_weeks(id) ON DELETE CASCADE,
    slot            smallint NOT NULL CHECK (slot BETWEEN 1 AND 11),
    position_group  text NOT NULL CHECK (position_group IN ('GK', 'DEF', 'MID', 'FWD')),
    player_id       bigint REFERENCES players(id),
    PRIMARY KEY (week_id, slot),
    UNIQUE (week_id, player_id)
);
