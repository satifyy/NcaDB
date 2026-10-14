-- Maintenance an administrator asked for from the admin dashboard.
--
-- The API never runs ingestion itself (no HTTP request can make the service scrape source
-- sites). An administrator records a request here instead, with a reason; the worker
-- carries it out after its next scheduled run, using the same code as the `retry` and
-- `analytics` CLI commands, and records the outcome. Every request is also written to
-- accounts.user_activity_audit by the API.
--
-- In `public`, so migration 002's default privileges give ncadb_worker DML (to claim and
-- finish requests) and ncadb_api SELECT (to list them). ncadb_accounts can only insert.

CREATE TABLE maintenance_requests (
    id              bigserial PRIMARY KEY,
    action          text NOT NULL CHECK (action IN ('retry_run', 'rebuild_analytics')),
    -- The failed or abandoned run to retry; NULL for actions that take no target.
    target_run_id   bigint REFERENCES ingestion_runs(id) ON DELETE SET NULL,
    reason          text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
    -- The provider user id of the administrator who asked (not a foreign key: user data
    -- lives in the accounts schema, which the worker cannot see).
    requested_by    text NOT NULL CHECK (requested_by ~ '^[A-Za-z0-9_-]{1,128}$'),
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'rejected')),
    result_run_id   bigint REFERENCES ingestion_runs(id) ON DELETE SET NULL,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    finished_at     timestamptz,
    CHECK ((action = 'retry_run') = (target_run_id IS NOT NULL))
);
CREATE INDEX maintenance_requests_pending_idx ON maintenance_requests (created_at) WHERE status = 'pending';
-- At most one open request per target, so repeated clicks queue one retry, not many.
CREATE UNIQUE INDEX maintenance_requests_open_target_idx
    ON maintenance_requests (action, coalesce(target_run_id, 0))
    WHERE status IN ('pending', 'running');

GRANT INSERT (action, target_run_id, reason, requested_by) ON maintenance_requests TO ncadb_accounts;
GRANT SELECT ON maintenance_requests TO ncadb_accounts;
GRANT USAGE ON SEQUENCE maintenance_requests_id_seq TO ncadb_accounts;
-- ON DELETE SET NULL / the target check read ingestion_runs as the table owner, but the
-- API validates a target before inserting, which needs to read it.
GRANT SELECT (id, kind, status) ON ingestion_runs TO ncadb_accounts;
