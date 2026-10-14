#!/usr/bin/env bash
# Applies NCADB's Railway service settings, credentials and limits. Idempotent: run it
# again after changing anything below. Requires the Railway CLI, logged in and linked to
# the project (`railway link`), with these services already created:
#
#   railway add --database postgres
#   railway add --service api     --repo satifyy/NcaDB --branch main
#   railway add --service worker  --repo satifyy/NcaDB --branch main
#   railway add --service migrate --repo satifyy/NcaDB --branch main
#
# Credential layout (least privilege):
#   migrate  holds the owner URL (MIGRATION_DATABASE_URL) and the two role passwords.
#            It runs `migrate` then `provision-roles` and exits. Nothing else ever sees
#            owner credentials.
#   api      connects as ncadb_api (SELECT only, 5 s statements).
#   worker   connects as ncadb_worker (data read/write, no DDL).
# Postgres has no public endpoint; all three reach it on the private network.
#
# Settings go through Railway's public GraphQL API (serviceInstanceUpdate) rather than
# railway.json, which is deprecated. Secrets are generated here, never printed, and
# never committed.
#
# Usage: scripts/railway/configure.sh [--cors "https://a.example,https://b-*.vercel.app"]
set -euo pipefail

CORS="${CORS_ALLOWED_ORIGINS:-https://satifyy.com,https://www.satifyy.com,https://ncadb.vercel.app,https://ncadb-*-santy0629-8466s-projects.vercel.app}"
if [[ "${1:-}" == "--cors" ]]; then CORS="$2"; fi

status=$(railway status --json)
env_id=$(jq -r '.environments.edges[] | select(.node.name=="production") | .node.id' <<<"$status")
svc() { jq -r --arg n "$1" '.services.edges[] | select(.node.name==$n) | .node.id' <<<"$status"; }
api_id=$(svc api); worker_id=$(svc worker); migrate_id=$(svc migrate)
[[ -n "$env_id" && -n "$api_id" && -n "$worker_id" && -n "$migrate_id" ]] || { echo "Missing environment or services (api, worker, migrate)" >&2; exit 1; }

update() { # service_id input_json
  railway api 'mutation($s: String!, $e: String, $i: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: $i) }' \
    --raw-var "s=$1" --raw-var "e=$env_id" --var "i=$(jq -c . <<<"$2")" >/dev/null
}
limits() { # service_id vcpus memory_gb
  railway api 'mutation($i: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $i) }' \
    --var "i={\"serviceId\":\"$1\",\"environmentId\":\"$env_id\",\"vCPUs\":$2,\"memoryGB\":$3}" >/dev/null
}

# Watch patterns are listed both relative to the root directory and to the repo root:
# with a root directory set, the repo-root form alone matched nothing.
update "$api_id" '{
  "rootDirectory": "ncaa-soccer",
  "dockerfilePath": "Dockerfile.api",
  "watchPatterns": ["packages/**", "ncaa-soccer/packages/**", "apps/api/**", "ncaa-soccer/apps/api/**", "package-lock.json", "ncaa-soccer/package-lock.json", "Dockerfile.api", "ncaa-soccer/Dockerfile.api"],
  "preDeployCommand": [],
  "startCommand": "npx tsx apps/api/src/server.ts",
  "healthcheckPath": "/health",
  "healthcheckTimeout": 120,
  "restartPolicyType": "ON_FAILURE",
  "restartPolicyMaxRetries": 5,
  "sleepApplication": false
}'

# Cron fires at 08:00 and 09:00 UTC; the worker proceeds only on the one that is 03:00
# in America/Chicago (DST-safe), and runs an overdue night whatever the hour.
update "$worker_id" '{
  "rootDirectory": "ncaa-soccer",
  "dockerfilePath": "Dockerfile.worker",
  "watchPatterns": ["packages/**", "ncaa-soccer/packages/**", "apps/scraper/**", "ncaa-soccer/apps/scraper/**", "apps/worker/**", "ncaa-soccer/apps/worker/**", "data/teams/**", "ncaa-soccer/data/teams/**", "package-lock.json", "ncaa-soccer/package-lock.json", "Dockerfile.worker", "ncaa-soccer/Dockerfile.worker"],
  "startCommand": "npx tsx apps/worker/src/cli.ts nightly --cron",
  "cronSchedule": "0 8,9 * * *",
  "restartPolicyType": "NEVER"
}'

# Runs once per deploy and exits: schema migrations, then role passwords.
update "$migrate_id" '{
  "rootDirectory": "ncaa-soccer",
  "dockerfilePath": "Dockerfile.api",
  "watchPatterns": ["packages/database/**", "ncaa-soccer/packages/database/**"],
  "startCommand": "sh -c \"npx tsx apps/worker/src/cli.ts migrate && npx tsx apps/worker/src/cli.ts provision-roles\"",
  "restartPolicyType": "NEVER"
}'

# Caps: a runaway scrape or a flood of API traffic cannot run up the bill unbounded.
limits "$api_id" 1 1
limits "$worker_id" 2 3
limits "$migrate_id" 0.5 0.5

# Role passwords: generated once, stored only on the migrate service, never printed.
have() { railway variable list --service "$1" --json | jq -e --arg k "$2" 'has($k)' >/dev/null; }
for key in NCADB_API_DB_PASSWORD NCADB_WORKER_DB_PASSWORD; do
  if ! have migrate "$key"; then
    openssl rand -hex 32 | railway variable set "$key" --stdin --service migrate --skip-deploys >/dev/null
  fi
done
railway variable set --service migrate --skip-deploys \
  'MIGRATION_DATABASE_URL=${{Postgres.DATABASE_URL}}' NODE_ENV=production LOG_LEVEL=info >/dev/null

db_url() { # role password_reference
  echo "postgresql://$1:\${{migrate.$2}}@\${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/\${{Postgres.PGDATABASE}}"
}

railway variable set --service api --skip-deploys \
  "DATABASE_URL=$(db_url ncadb_api NCADB_API_DB_PASSWORD)" \
  NODE_ENV=production LOG_LEVEL=info DATABASE_POOL_MAX=10 DATABASE_STATEMENT_TIMEOUT_MS=5000 \
  RATE_LIMIT_PER_MINUTE=300 API_CACHE_SECONDS=300 "CORS_ALLOWED_ORIGINS=$CORS" >/dev/null

# Generated once and never printed. Read it with: railway variable list --service api --kv
if ! have api ADMIN_API_TOKEN; then
  openssl rand -hex 24 | railway variable set ADMIN_API_TOKEN --stdin --service api --skip-deploys >/dev/null
fi

railway variable set --service worker --skip-deploys \
  "DATABASE_URL=$(db_url ncadb_worker NCADB_WORKER_DB_PASSWORD)" \
  NODE_ENV=production LOG_LEVEL=info DATABASE_POOL_MAX=4 \
  INGESTION_MODE=incremental INGESTION_LOOKBACK_DAYS=7 INGESTION_ACTIVE_MONTHS=8-12 INGESTION_MAX_DROP_PCT=3 \
  NIGHTLY_TIMEZONE=America/Chicago NIGHTLY_LOCAL_HOUR=3 NIGHTLY_RECOVERY_AFTER_HOURS=26 STALE_AFTER_HOURS=36 \
  ANALYTICS_ENABLED=true WORK_DIR=/tmp/ncadb-work \
  SCRAPER_CONCURRENCY=3 SCRAPER_REQUEST_DELAY_MS=1500 SCRAPER_HOST_DELAY_MS=30000 SCRAPER_MAX_RETRIES=3 >/dev/null

echo "Configured api, worker and migrate in production ($env_id). Deploy order: migrate, then api and worker."
echo "Set ALERT_WEBHOOK_URL on the worker to receive failure alerts:"
echo "  railway variable set ALERT_WEBHOOK_URL=https://hooks.slack.com/... --service worker"
