#!/usr/bin/env bash
# Applies NCADB's Railway service settings and variables. Idempotent: run it again after
# changing anything below. Requires the Railway CLI, logged in and linked to the project
# (`railway link`), with services named Postgres, api and worker already created:
#
#   railway add --database postgres
#   railway add --service api    --repo satifyy/NcaDB --branch main
#   railway add --service worker --repo satifyy/NcaDB --branch main
#
# Settings go through Railway's public GraphQL API (serviceInstanceUpdate) rather than
# railway.json: config-as-code files are deprecated, and the settings here (cron, root
# directory, Dockerfile path, pre-deploy) are all first-class fields on the service.
#
# Usage: scripts/railway/configure.sh [--cors "https://a.vercel.app,https://b-*.vercel.app"]
set -euo pipefail

CORS="${CORS_ALLOWED_ORIGINS:-http://localhost:5173}"
if [[ "${1:-}" == "--cors" ]]; then CORS="$2"; fi

status=$(railway status --json)
env_id=$(jq -r '.environments.edges[] | select(.node.name=="production") | .node.id' <<<"$status")
svc() { jq -r --arg n "$1" '.services.edges[] | select(.node.name==$n) | .node.id' <<<"$status"; }
api_id=$(svc api); worker_id=$(svc worker)
[[ -n "$env_id" && -n "$api_id" && -n "$worker_id" ]] || { echo "Missing environment or services" >&2; exit 1; }

update() { # service_id input_json
  railway api 'mutation($s: String!, $e: String, $i: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: $i) }' \
    --raw-var "s=$1" --raw-var "e=$env_id" --var "i=$(jq -c . <<<"$2")" >/dev/null
}

# Watch patterns are listed both relative to the root directory and to the repo root:
# with a root directory set, the repo-root form alone matched nothing and pushes did not
# redeploy.

# API: always on, health-checked, migrates before each deploy is switched in.
update "$api_id" '{
  "rootDirectory": "ncaa-soccer",
  "dockerfilePath": "Dockerfile.api",
  "watchPatterns": ["packages/**", "ncaa-soccer/packages/**", "apps/api/**", "ncaa-soccer/apps/api/**", "apps/worker/**", "ncaa-soccer/apps/worker/**", "package-lock.json", "ncaa-soccer/package-lock.json", "Dockerfile.api", "ncaa-soccer/Dockerfile.api"],
  "preDeployCommand": ["npx tsx apps/worker/src/cli.ts migrate"],
  "startCommand": "npx tsx apps/api/src/server.ts",
  "healthcheckPath": "/health",
  "healthcheckTimeout": 120,
  "restartPolicyType": "ON_FAILURE",
  "restartPolicyMaxRetries": 5,
  "sleepApplication": false
}'

# Worker: a cron service. Fires at 08:00 and 09:00 UTC; the worker itself lets through
# only the firing that is 03:00 in America/Chicago (DST-safe), and runs an overdue night
# whatever the hour. It exits when done, so it is never restarted.
update "$worker_id" '{
  "rootDirectory": "ncaa-soccer",
  "dockerfilePath": "Dockerfile.worker",
  "watchPatterns": ["packages/**", "ncaa-soccer/packages/**", "apps/scraper/**", "ncaa-soccer/apps/scraper/**", "apps/worker/**", "ncaa-soccer/apps/worker/**", "data/teams/**", "ncaa-soccer/data/teams/**", "package-lock.json", "ncaa-soccer/package-lock.json", "Dockerfile.worker", "ncaa-soccer/Dockerfile.worker"],
  "startCommand": "npx tsx apps/worker/src/cli.ts nightly --cron",
  "cronSchedule": "0 8,9 * * *",
  "restartPolicyType": "NEVER"
}'

# Private-network URL: neither service talks to Postgres over the public internet.
common=(
  'DATABASE_URL=${{Postgres.DATABASE_URL}}'
  NODE_ENV=production
  LOG_LEVEL=info
)
railway variable set --service api --skip-deploys "${common[@]}" \
  DATABASE_POOL_MAX=10 RATE_LIMIT_PER_MINUTE=300 API_CACHE_SECONDS=300 \
  "CORS_ALLOWED_ORIGINS=$CORS" >/dev/null

# Generated once and never printed. Read it with: railway variable list --service api --kv
if ! railway variable list --service api --json | jq -e 'has("ADMIN_API_TOKEN")' >/dev/null; then
  openssl rand -hex 24 | railway variable set ADMIN_API_TOKEN --stdin --service api --skip-deploys >/dev/null
fi

railway variable set --service worker --skip-deploys "${common[@]}" \
  DATABASE_POOL_MAX=4 \
  INGESTION_MODE=incremental INGESTION_LOOKBACK_DAYS=7 INGESTION_ACTIVE_MONTHS=8-12 INGESTION_MAX_DROP_PCT=3 \
  NIGHTLY_TIMEZONE=America/Chicago NIGHTLY_LOCAL_HOUR=3 NIGHTLY_RECOVERY_AFTER_HOURS=26 STALE_AFTER_HOURS=36 \
  ANALYTICS_ENABLED=true WORK_DIR=/tmp/ncadb-work \
  SCRAPER_CONCURRENCY=3 SCRAPER_REQUEST_DELAY_MS=1500 SCRAPER_HOST_DELAY_MS=30000 SCRAPER_MAX_RETRIES=3 >/dev/null

echo "Configured api ($api_id) and worker ($worker_id) in production ($env_id)."
echo "Set ALERT_WEBHOOK_URL on the worker to receive failure alerts:"
echo "  railway variable set ALERT_WEBHOOK_URL=https://hooks.slack.com/... --service worker"
