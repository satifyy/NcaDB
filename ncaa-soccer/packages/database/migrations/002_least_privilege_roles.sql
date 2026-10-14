-- Least-privilege database roles.
--
-- Until now the API and the worker connected as the database owner (on Railway, the
-- `postgres` superuser). After this migration:
--
--   ncadb_api     SELECT only. Cannot write, cannot create, short statement timeout.
--   ncadb_worker  reads and writes data, cannot create, alter or drop anything.
--                 Maintenance that needs ownership (refreshing read models,
--                 ANALYZE) goes through two narrow SECURITY DEFINER functions.
--   owner         (whoever runs migrations) keeps DDL. Only the migrate step uses it.
--
-- The roles are created without passwords, so nothing can log in as them until an
-- operator sets one (`npm run worker -- provision-roles`, which reads the passwords from
-- the environment). Role names are cluster-wide, hence the existence checks.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ncadb_api') THEN
        CREATE ROLE ncadb_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 20;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ncadb_worker') THEN
        CREATE ROLE ncadb_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 10;
    END IF;
END
$$;

-- A runaway query from the public API is cut off quickly; the worker loads a season per
-- transaction and needs longer.
ALTER ROLE ncadb_api SET statement_timeout = '5s';
ALTER ROLE ncadb_api SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE ncadb_api SET default_transaction_read_only = on;
ALTER ROLE ncadb_worker SET statement_timeout = '10min';
ALTER ROLE ncadb_worker SET idle_in_transaction_session_timeout = '10min';

-- Nobody but the owner creates objects in the schema (PostgreSQL < 15 grants this to all).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ncadb_api, ncadb_worker;

-- API: read everything it serves, including the migration ledger for /api/v1/status.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ncadb_api;

-- Worker: data in, data out. No TRUNCATE, no REFERENCES, no TRIGGER, no DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ncadb_worker;
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ncadb_worker;
-- Reference data is written only by migrations.
REVOKE INSERT, UPDATE, DELETE ON sports, competitions FROM ncadb_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ncadb_worker;

-- Tables later migrations create get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ncadb_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ncadb_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ncadb_worker;

-- Ownership-only maintenance, exposed as two functions that do exactly one thing each.
CREATE OR REPLACE FUNCTION ncadb_refresh_read_models() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY player_season_stats;
    REFRESH MATERIALIZED VIEW CONCURRENTLY team_season_records;
END
$$;

CREATE OR REPLACE FUNCTION ncadb_analyze_ingestion_tables() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    ANALYZE games;
    ANALYZE player_game_stats;
    ANALYZE team_game_stats;
END
$$;

REVOKE ALL ON FUNCTION ncadb_refresh_read_models() FROM PUBLIC;
REVOKE ALL ON FUNCTION ncadb_analyze_ingestion_tables() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ncadb_refresh_read_models() TO ncadb_worker;
GRANT EXECUTE ON FUNCTION ncadb_analyze_ingestion_tables() TO ncadb_worker;
