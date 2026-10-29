#!/usr/bin/env bash
# Applies stubs + all migrations to a scratch Postgres database and runs the SQL tests.
# Usage: PGURL=postgres://postgres@localhost/postgres bash supabase/tests/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ADMIN="${PGURL:-postgres://postgres:postgres@localhost:5432/postgres}"
DB="continuum_test_$$"
psql "$ADMIN" -qc "create database $DB"
trap 'psql "$ADMIN" -qc "drop database if exists $DB" >/dev/null' EXIT
URL="${ADMIN%/*}/$DB"
psql "$URL" -q -v ON_ERROR_STOP=1 -f "$HERE/supabase_stub.sql" >/dev/null 2>&1
for f in "$HERE"/../migrations/*.sql; do psql "$URL" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || { echo "migration failed: $f"; exit 1; }; done
for t in "$HERE"/*.test.sql; do echo "== $(basename "$t")"; psql "$URL" -q -v ON_ERROR_STOP=1 -f "$t"; done
