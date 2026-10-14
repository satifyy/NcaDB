-- User accounts: profiles, favorites, preferences and an audit trail.
--
-- Authentication itself (passwords, OAuth, email verification, sessions) is Clerk's; this
-- schema stores none of it. A profile is keyed by the provider's stable user id (the
-- `sub` claim of its session token), never by an email address, and nothing here holds
-- a password, a provider secret or a token.
--
-- Everything lives in its own schema, `accounts`, rather than `public`: migration 002
-- set default privileges on `public` that grant every new table to ncadb_api (SELECT)
-- and ncadb_worker (DML), and neither of them may see or touch user data. Neither role
-- gets USAGE on this schema, so they cannot even name these tables.
--
--   ncadb_accounts  the API's identity for signed-in requests. Reads and writes profile
--                   data through column-level grants that leave out `role`, so not even a
--                   compromised API process can make anyone an administrator. Reads the
--                   two sports tables a favorite points at. Cannot create, alter or drop
--                   anything, cannot read or change the audit trail it appends to.
--   owner           the only identity that changes `role`, via `npm run worker -- set-role`,
--                   which records who did it and why in the audit trail.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ncadb_accounts') THEN
        CREATE ROLE ncadb_accounts LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 10;
    END IF;
END
$$;

ALTER ROLE ncadb_accounts SET statement_timeout = '5s';
ALTER ROLE ncadb_accounts SET idle_in_transaction_session_timeout = '30s';

CREATE SCHEMA accounts;
REVOKE ALL ON SCHEMA accounts FROM PUBLIC;

CREATE TABLE accounts.user_profiles (
    id              bigserial PRIMARY KEY,
    -- Which provider issued `auth_subject`. One today; the pair is the identity, so a
    -- second provider could never collide with the first one's ids.
    auth_provider   text NOT NULL DEFAULT 'clerk' CHECK (auth_provider IN ('clerk')),
    -- The provider's stable user id (`user_2abc…`). Not an email: emails change.
    auth_subject    text NOT NULL CHECK (auth_subject ~ '^[A-Za-z0-9_-]{1,128}$'),
    display_name    text CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 80),
    -- Authorization lives here, not in the token or the client. Changed only by the owner.
    role            text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (auth_provider, auth_subject)
);

CREATE TABLE accounts.user_favorite_teams (
    user_id     bigint NOT NULL REFERENCES accounts.user_profiles(id) ON DELETE CASCADE,
    team_id     integer NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- One row per (user, team): saving a favorite twice is a no-op, not a duplicate.
    PRIMARY KEY (user_id, team_id)
);
CREATE INDEX user_favorite_teams_team_idx ON accounts.user_favorite_teams (team_id);

CREATE TABLE accounts.user_favorite_players (
    user_id     bigint NOT NULL REFERENCES accounts.user_profiles(id) ON DELETE CASCADE,
    player_id   bigint NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, player_id)
);
CREATE INDEX user_favorite_players_player_idx ON accounts.user_favorite_players (player_id);

CREATE TABLE accounts.user_preferences (
    user_id         bigint PRIMARY KEY REFERENCES accounts.user_profiles(id) ON DELETE CASCADE,
    -- The season the dashboard opens on; NULL means "the latest".
    default_season  smallint CHECK (default_season IS NULL OR default_season BETWEEN 2000 AND 2100),
    -- The view the dashboard opens on; NULL means the site default.
    default_view    text CHECK (default_view IS NULL OR default_view ~ '^[a-z-]{1,40}$'),
    favorites_first boolean NOT NULL DEFAULT true,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Append-only record of account activity: sign-ins, profile and favorite changes,
-- deletions, admin access and role changes. `user_id` is nulled, not cascaded, when a
-- profile is deleted, so the trail of the deletion itself survives.
CREATE TABLE accounts.user_activity_audit (
    id              bigserial PRIMARY KEY,
    user_id         bigint REFERENCES accounts.user_profiles(id) ON DELETE SET NULL,
    auth_subject    text,
    action          text NOT NULL CHECK (action ~ '^[a-z_.]{1,60}$'),
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
    request_id      text,
    ip              text,
    -- Who performed it when not the user themself (an operator changing a role).
    actor           text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_activity_audit_user_idx ON accounts.user_activity_audit (user_id, created_at DESC);
CREATE INDEX user_activity_audit_action_idx ON accounts.user_activity_audit (action, created_at DESC);

-- ---------------------------------------------------------------------------------------
-- Grants. Nothing in this schema is granted to PUBLIC, ncadb_api or ncadb_worker.

GRANT USAGE ON SCHEMA accounts TO ncadb_accounts;
-- The sports tables a favorite references, read-only, for lookups and listing.
GRANT USAGE ON SCHEMA public TO ncadb_accounts;
GRANT SELECT ON public.teams, public.players TO ncadb_accounts;

-- Profiles: create one's own, read, rename, touch last_seen_at, delete. Not `role`.
GRANT SELECT, DELETE ON accounts.user_profiles TO ncadb_accounts;
GRANT INSERT (auth_provider, auth_subject, display_name) ON accounts.user_profiles TO ncadb_accounts;
GRANT UPDATE (display_name, updated_at, last_seen_at) ON accounts.user_profiles TO ncadb_accounts;
GRANT USAGE ON SEQUENCE accounts.user_profiles_id_seq TO ncadb_accounts;

GRANT SELECT, INSERT, DELETE ON accounts.user_favorite_teams, accounts.user_favorite_players TO ncadb_accounts;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts.user_preferences TO ncadb_accounts;

-- The audit trail: append only. No SELECT, UPDATE or DELETE, so the API cannot read,
-- rewrite or erase it.
GRANT INSERT (user_id, auth_subject, action, detail, request_id, ip) ON accounts.user_activity_audit TO ncadb_accounts;
GRANT USAGE ON SEQUENCE accounts.user_activity_audit_id_seq TO ncadb_accounts;
