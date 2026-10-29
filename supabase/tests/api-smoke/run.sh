#!/usr/bin/env bash
# Runs the dashboard's real queries end to end: scratch Postgres + all migrations + PostgREST + signed JWTs.
# Usage: PGURL=postgres://postgres:postgres@localhost:5432/postgres supabase/tests/api-smoke/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
ADMIN="${PGURL:-postgres://postgres:postgres@localhost:5432/postgres}"
DB="continuum_api_$$"
PORT="${POSTGREST_PORT:-3417}"
SECRET="test-secret-test-secret-test-secret-test-secret"
PGRST_VERSION="${POSTGREST_VERSION:-12.2.3}"
BIN="${POSTGREST_BIN:-/tmp/postgrest-$PGRST_VERSION/postgrest}"
WORK="$(mktemp -d)"
cleanup() { [ -n "${PGRST_PID:-}" ] && kill "$PGRST_PID" 2>/dev/null || true; sleep 1; psql "$ADMIN" -qc "drop database if exists $DB" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

if [ ! -x "$BIN" ]; then
  mkdir -p "$(dirname "$BIN")"
  curl -fsSL "https://github.com/PostgREST/postgrest/releases/download/v$PGRST_VERSION/postgrest-v$PGRST_VERSION-linux-static-x64.tar.xz" | tar -xJ -C "$(dirname "$BIN")"
fi
(cd "$ROOT/apps/web" && { [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null; } && npm install --no-save --no-audit --no-fund pg >/dev/null)

psql "$ADMIN" -qc "create database $DB"
URL="${ADMIN%/*}/$DB"
psql "$URL" -q -v ON_ERROR_STOP=1 -f "$HERE/../supabase_stub.sql" >/dev/null 2>&1
for f in "$ROOT"/supabase/migrations/*.sql; do psql "$URL" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || { echo "migration failed: $f"; exit 1; }; done

cat > "$WORK/pgrst.conf" <<CONF
db-uri = "$URL"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$SECRET"
server-host = "127.0.0.1"
server-port = $PORT
CONF
"$BIN" "$WORK/pgrst.conf" >"$WORK/pgrst.log" 2>&1 &
PGRST_PID=$!
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 1; done

WEB_DIR="$ROOT/apps/web" JWT_SECRET="$SECRET" POSTGREST_URL="http://127.0.0.1:$PORT" DATABASE_URL="$URL" timeout 120 node "$HERE/smoke.mjs"
