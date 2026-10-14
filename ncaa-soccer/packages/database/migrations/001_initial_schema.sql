-- NCADB initial schema.
--
-- Two layers, kept apart on purpose:
--
--   * Provenance — `game_sources` holds every schedule row exactly as a school published
--     it. Each school in a fixture publishes its own row, so one game usually has two.
--     The worker exports these rows back to CSV so the existing scrapers can merge
--     against them, which keeps the round trip lossless.
--   * Normalised — `games`, `players`, `player_game_stats` and friends are what the API
--     reads. A fixture is one `games` row however many sources describe it, keyed on the
--     two resolved teams and the date (a team plays at most one game a day).
--
-- Player names are never a global identity. A player is (team, normalised name), and a
-- transfer is a second player row. The data carries no source player id, and joining
-- careers on a bare name welds strangers together (see apps/scraper/src/analytics/careers.ts).

CREATE TABLE sports (
    id          smallserial PRIMARY KEY,
    code        text NOT NULL UNIQUE,
    name        text NOT NULL
);

CREATE TABLE competitions (
    id          serial PRIMARY KEY,
    sport_id    smallint NOT NULL REFERENCES sports(id),
    code        text NOT NULL,
    name        text NOT NULL,
    division    text NOT NULL,
    UNIQUE (sport_id, code)
);

CREATE TABLE seasons (
    id              serial PRIMARY KEY,
    competition_id  integer NOT NULL REFERENCES competitions(id),
    year            smallint NOT NULL CHECK (year BETWEEN 1990 AND 2100),
    label           text NOT NULL,
    UNIQUE (competition_id, year)
);

CREATE TABLE conferences (
    id          serial PRIMARY KEY,
    sport_id    smallint NOT NULL REFERENCES sports(id),
    name        text NOT NULL,
    UNIQUE (sport_id, name)
);

CREATE TABLE teams (
    id                      serial PRIMARY KEY,
    sport_id                smallint NOT NULL REFERENCES sports(id),
    -- URL-safe stable identifier derived from the canonical name: `nc-state`.
    slug                    text NOT NULL,
    name                    text NOT NULL,
    -- Inventory id (`NC_STATE`) for Division I programs the scrapers know; NULL for
    -- opponents only ever seen in someone else's schedule (D2, D3, NAIA, ...).
    inventory_id            text UNIQUE,
    is_division_one         boolean NOT NULL DEFAULT false,
    -- Current alignment, as the inventory records it. Per-season membership lives in
    -- team_seasons.
    conference_id           integer REFERENCES conferences(id),
    schedule_url            text,
    platform                text,
    timezone                text,
    aliases                 text[] NOT NULL DEFAULT '{}',
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (sport_id, slug)
);
CREATE INDEX teams_name_lower_idx ON teams (lower(name));
CREATE INDEX teams_conference_idx ON teams (conference_id);

-- Every spelling a source has used for a team, so a lookup by raw name is one index hit
-- and a reviewer can see which spellings were folded into which school.
CREATE TABLE source_identifiers (
    id              bigserial PRIMARY KEY,
    entity_type     text NOT NULL CHECK (entity_type IN ('team', 'player')),
    entity_id       bigint NOT NULL,
    source          text NOT NULL,
    source_key      text NOT NULL,
    first_seen_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (entity_type, source, source_key)
);
CREATE INDEX source_identifiers_entity_idx ON source_identifiers (entity_type, entity_id);

CREATE TABLE team_seasons (
    team_id             integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    season_id           integer NOT NULL REFERENCES seasons(id),
    conference_id       integer REFERENCES conferences(id),
    -- Where the conference came from. The inventory records current alignment only, so
    -- for past seasons this is an approximation and is labelled as one.
    conference_source   text NOT NULL DEFAULT 'inventory_current',
    PRIMARY KEY (team_id, season_id)
);
CREATE INDEX team_seasons_season_idx ON team_seasons (season_id, conference_id);

CREATE TABLE games (
    id                  bigserial PRIMARY KEY,
    season_id           integer NOT NULL REFERENCES seasons(id),
    game_date           date NOT NULL,
    home_team_id        integer NOT NULL REFERENCES teams(id),
    away_team_id        integer NOT NULL REFERENCES teams(id),
    -- The fixture's identity, orientation-free: two schools list the same game in
    -- opposite home/away order.
    team_low_id         integer GENERATED ALWAYS AS (LEAST(home_team_id, away_team_id)) STORED,
    team_high_id        integer GENERATED ALWAYS AS (GREATEST(home_team_id, away_team_id)) STORED,
    home_team_ranked    boolean,
    away_team_ranked    boolean,
    home_score          smallint CHECK (home_score >= 0),
    away_score          smallint CHECK (away_score >= 0),
    status              text NOT NULL CHECK (status IN ('scheduled', 'live', 'final', 'postponed', 'canceled', 'unknown')),
    location_type       text NOT NULL CHECK (location_type IN ('home', 'away', 'neutral', 'unknown')),
    game_type           text CHECK (game_type IN ('exhibition', 'ncaa_tournament', 'conference_tournament', 'regular')),
    schedule_url        text,
    boxscore_url        text,
    boxscore_url_alt    text,
    -- 'none' | 'partial' (one side) | 'complete' (both sides), maintained by the loader.
    boxscore_status     text NOT NULL DEFAULT 'none' CHECK (boxscore_status IN ('none', 'partial', 'complete')),
    -- Set when the merged sources disagree on something that matters (the score).
    quality_flags       text[] NOT NULL DEFAULT '{}',
    content_hash        text NOT NULL,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    last_verified_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (home_team_id <> away_team_id),
    CHECK (status <> 'final' OR (home_score IS NOT NULL AND away_score IS NOT NULL)),
    UNIQUE (season_id, game_date, team_low_id, team_high_id)
);
CREATE INDEX games_date_idx ON games (game_date DESC);
CREATE INDEX games_season_date_idx ON games (season_id, game_date DESC);
CREATE INDEX games_home_idx ON games (home_team_id, game_date DESC);
CREATE INDEX games_away_idx ON games (away_team_id, game_date DESC);
CREATE INDEX games_status_idx ON games (status, game_date DESC);

CREATE TABLE game_sources (
    id                  bigserial PRIMARY KEY,
    game_id             bigint NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    season_id           integer NOT NULL REFERENCES seasons(id),
    -- The scraper's own keys: `dedupe_key` is how it merges a fixture's two rows,
    -- `source_game_id` is what its box-score rows point at.
    dedupe_key          text NOT NULL,
    source_game_id      text NOT NULL,
    -- The row exactly as it was written to games.csv, every column a string.
    payload             jsonb NOT NULL,
    content_hash        text NOT NULL,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (season_id, dedupe_key)
);
CREATE INDEX game_sources_game_idx ON game_sources (game_id);
CREATE INDEX game_sources_source_id_idx ON game_sources (season_id, source_game_id);

CREATE TABLE players (
    id                  bigserial PRIMARY KEY,
    sport_id            smallint NOT NULL REFERENCES sports(id),
    -- `<team slug>:<letters of the name>`. Stable across seasons at one school; a
    -- transfer is a different identity because nothing in a box score proves otherwise.
    identity_key        text NOT NULL,
    name                text NOT NULL,
    display_name        text NOT NULL,
    team_id             integer NOT NULL REFERENCES teams(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (sport_id, identity_key)
);
CREATE INDEX players_team_idx ON players (team_id);
CREATE INDEX players_display_lower_idx ON players (lower(display_name) text_pattern_ops);

CREATE TABLE player_team_seasons (
    player_id           bigint NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    team_id             integer NOT NULL REFERENCES teams(id),
    season_id           integer NOT NULL REFERENCES seasons(id),
    jersey_number       text,
    PRIMARY KEY (player_id, team_id, season_id)
);
CREATE INDEX player_team_seasons_team_idx ON player_team_seasons (team_id, season_id);

CREATE TABLE player_game_stats (
    id                  bigserial PRIMARY KEY,
    game_id             bigint NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id           bigint NOT NULL REFERENCES players(id),
    team_id             integer NOT NULL REFERENCES teams(id),
    season_id           integer NOT NULL REFERENCES seasons(id),
    jersey_number       text,
    -- Part of the key: one name at two numbers in one box score is two people.
    jersey_key          text NOT NULL DEFAULT '',
    -- NULL means the box score did not say. It is never coerced to zero here.
    minutes             smallint CHECK (minutes BETWEEN 0 AND 200),
    goals               smallint CHECK (goals >= 0),
    assists             smallint CHECK (assists >= 0),
    shots               smallint CHECK (shots >= 0),
    shots_on_goal       smallint CHECK (shots_on_goal >= 0),
    saves               smallint CHECK (saves >= 0),
    -- Provenance, enough to write the row back out exactly as the scraper produced it.
    source_game_id      text NOT NULL,
    source_team_name    text NOT NULL,
    source_player_name  text NOT NULL,
    source_player_key   text NOT NULL,
    content_hash        text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (game_id, player_id, jersey_key)
);
CREATE INDEX player_game_stats_player_idx ON player_game_stats (player_id, season_id);
CREATE INDEX player_game_stats_team_idx ON player_game_stats (team_id, season_id);
CREATE INDEX player_game_stats_season_idx ON player_game_stats (season_id);

-- Per-team box-score totals, recomputed by the loader for every game it touches.
CREATE TABLE team_game_stats (
    game_id             bigint NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    team_id             integer NOT NULL REFERENCES teams(id),
    players             smallint NOT NULL,
    minutes             integer,
    goals               smallint,
    assists             smallint,
    shots               smallint,
    shots_on_goal       smallint,
    saves               smallint,
    -- The score the schedule reported for this side, to reconcile against.
    reported_score      smallint,
    -- 'ok', 'unattributed' (fewer player goals than the score: own goals happen),
    -- 'excess' (more player goals than the score: something is wrong), or 'unknown'.
    goals_reconciliation text NOT NULL DEFAULT 'unknown',
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (game_id, team_id)
);
CREATE INDEX team_game_stats_team_idx ON team_game_stats (team_id);

-- ---------------------------------------------------------------------------------------
-- Ingestion bookkeeping
-- ---------------------------------------------------------------------------------------

CREATE TABLE ingestion_runs (
    id              bigserial PRIMARY KEY,
    kind            text NOT NULL,
    trigger         text NOT NULL DEFAULT 'manual',
    status          text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped', 'abandoned')),
    params          jsonb NOT NULL DEFAULT '{}',
    stats           jsonb NOT NULL DEFAULT '{}',
    error           text,
    host            text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    heartbeat_at    timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz
);
CREATE INDEX ingestion_runs_started_idx ON ingestion_runs (started_at DESC);
CREATE INDEX ingestion_runs_kind_status_idx ON ingestion_runs (kind, status, started_at DESC);

CREATE TABLE ingestion_tasks (
    id              bigserial PRIMARY KEY,
    run_id          bigint NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
    season          smallint,
    stage           text NOT NULL,
    status          text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
    params          jsonb NOT NULL DEFAULT '{}',
    stats           jsonb NOT NULL DEFAULT '{}',
    error           text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz
);
CREATE INDEX ingestion_tasks_run_idx ON ingestion_tasks (run_id);
CREATE INDEX ingestion_tasks_status_idx ON ingestion_tasks (status, started_at DESC);

CREATE TABLE ingestion_errors (
    id              bigserial PRIMARY KEY,
    run_id          bigint REFERENCES ingestion_runs(id) ON DELETE CASCADE,
    task_id         bigint REFERENCES ingestion_tasks(id) ON DELETE CASCADE,
    category        text NOT NULL CHECK (category IN ('source', 'parse', 'validation', 'reconciliation', 'database', 'internal')),
    severity        text NOT NULL DEFAULT 'error' CHECK (severity IN ('warning', 'error')),
    code            text NOT NULL,
    message         text NOT NULL,
    count           integer NOT NULL DEFAULT 1,
    context         jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingestion_errors_run_idx ON ingestion_errors (run_id);
CREATE INDEX ingestion_errors_created_idx ON ingestion_errors (created_at DESC);

CREATE TABLE data_sync_state (
    scope               text PRIMARY KEY,
    last_success_at     timestamptz,
    last_success_run_id bigint REFERENCES ingestion_runs(id) ON DELETE SET NULL,
    last_attempt_at     timestamptz,
    last_attempt_run_id bigint REFERENCES ingestion_runs(id) ON DELETE SET NULL,
    last_status         text,
    details             jsonb NOT NULL DEFAULT '{}',
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Files the analytics stages derive from the tables above (ratings, forecasts, impact,
-- per-season player totals), stored as the JSON text the dashboard reads. Text rather
-- than jsonb so the API can serve the bytes as written, with the hash as its ETag.
CREATE TABLE derived_artifacts (
    key             text PRIMARY KEY,
    content         text NOT NULL,
    content_hash    text NOT NULL,
    byte_size       integer NOT NULL,
    run_id          bigint REFERENCES ingestion_runs(id) ON DELETE SET NULL,
    generated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------
-- Read models, refreshed after each load.
-- ---------------------------------------------------------------------------------------

CREATE MATERIALIZED VIEW player_season_stats AS
SELECT
    s.player_id,
    s.team_id,
    s.season_id,
    count(DISTINCT s.game_id)::int          AS games_played,
    sum(s.minutes)::int                     AS minutes,
    sum(s.goals)::int                       AS goals,
    sum(s.assists)::int                     AS assists,
    sum(s.shots)::int                       AS shots,
    sum(s.shots_on_goal)::int               AS shots_on_goal,
    sum(s.saves)::int                       AS saves
FROM player_game_stats s
GROUP BY s.player_id, s.team_id, s.season_id;
CREATE UNIQUE INDEX player_season_stats_pk ON player_season_stats (player_id, team_id, season_id);
CREATE INDEX player_season_stats_season_goals_idx ON player_season_stats (season_id, goals DESC);
CREATE INDEX player_season_stats_team_idx ON player_season_stats (team_id, season_id);

CREATE MATERIALIZED VIEW team_season_records AS
WITH sides AS (
    SELECT season_id, home_team_id AS team_id, home_score AS gf, away_score AS ga, game_type
    FROM games WHERE status = 'final'
    UNION ALL
    SELECT season_id, away_team_id, away_score, home_score, game_type
    FROM games WHERE status = 'final'
)
SELECT
    team_id,
    season_id,
    count(*)::int                                   AS played,
    count(*) FILTER (WHERE gf > ga)::int            AS wins,
    count(*) FILTER (WHERE gf = ga)::int            AS draws,
    count(*) FILTER (WHERE gf < ga)::int            AS losses,
    sum(gf)::int                                    AS goals_for,
    sum(ga)::int                                    AS goals_against,
    count(*) FILTER (WHERE game_type = 'exhibition')::int AS exhibitions
FROM sides
GROUP BY team_id, season_id;
CREATE UNIQUE INDEX team_season_records_pk ON team_season_records (team_id, season_id);

INSERT INTO sports (code, name) VALUES ('msoc', 'Men''s Soccer');
INSERT INTO competitions (sport_id, code, name, division)
SELECT id, 'ncaa-d1-msoc', 'NCAA Division I Men''s Soccer', 'I' FROM sports WHERE code = 'msoc';
