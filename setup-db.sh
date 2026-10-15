#!/usr/bin/env bash
# One-time database setup: creates the database and users, applies migrations, seeds the two messes.
# Optional: DEMO_HISTORY=1 loads SYNTHETIC history (needed for forecasts and a non-empty dashboard).
# Needs: the PostgreSQL client (psql), the backend virtualenv, and superuser access (sudo or su postgres).
set -euo pipefail
source "$(dirname "$0")/env.sh"

echo "== creating database and owner role (as postgres superuser)"
pg_su -v ON_ERROR_STOP=1 -q -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_OWNER}'" | grep -q 1 \
  || pg_su -v ON_ERROR_STOP=1 -q -c "CREATE USER ${DB_OWNER} WITH PASSWORD '${DB_OWNER_PASSWORD}'"
pg_su -v ON_ERROR_STOP=1 -q -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || pg_su -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_OWNER}"

echo "== applying migrations"
(cd "$BACKEND_DIR" && DATABASE_URL="$OWNER_URL" "$(dirname "$PY_BACKEND")/alembic" upgrade head)

echo "== creating the read-only ML role"
pg_su -v ON_ERROR_STOP=1 -q -d "$DB_NAME" -v ml_pw="'${ML_READER_PASSWORD}'" -f "$BACKEND_DIR/scripts/create_ml_reader.sql"

echo "== seeding messes, manager and test student"
(cd "$BACKEND_DIR" && DATABASE_URL="$OWNER_URL" "$PY_BACKEND" seed.py)

if [[ "${DEMO_HISTORY:-0}" == "1" ]]; then
  echo "== loading SYNTHETIC demo history (development only)"
  CSV="$ML_DIR/data/raw/SYNTHETIC_meal_history.csv"
  if [[ ! -f "$CSV" ]]; then
    (cd "$ML_DIR" && "$PY_ML" -m src.synthetic)
  fi
  (cd "$BACKEND_DIR" && "$PY_BACKEND" scripts/load_demo_history.py --csv "$CSV" --days 240 --dsn "$OWNER_URL_PLAIN")
  echo "== exporting history and training the forecast model"
  pg_su -d "$DB_NAME" -q -c "\copy (select mess_id, date, meal_type, served_count from mess_usage order by mess_id, date, meal_type) to '/tmp/mess_usage_export.csv' csv header"
  cp /tmp/mess_usage_export.csv "$ML_DIR/data/raw/db_mess_usage.csv"
  (cd "$ML_DIR" && "$PY_ML" -m src.train --data data/raw/db_mess_usage.csv --data-label synthetic)
fi
echo "Database ready."
