#!/usr/bin/env bash
# Starts the four services in dependency order. Logs go to ./logs. Stop with scripts/stop-all.sh
set -euo pipefail
source "$(dirname "$0")/env.sh"
mkdir -p "$LOG_DIR"

start() {  # name, workdir, command...
  local name="$1" dir="$2"; shift 2
  echo "starting $name ..."
  (cd "$dir" && nohup "$@" > "$LOG_DIR/$name.log" 2>&1 < /dev/null &)
}

wait_for() {  # name, url
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 "$2" >/dev/null 2>&1; then echo "  $1 is up"; return 0; fi
    sleep 1
  done
  echo "  $1 did not start. See $LOG_DIR/$1.log"; exit 1
}

# 1. ML service (reads the database through the read-only role)
start ml "$ML_DIR" env HISTORY_SOURCE=postgres DATABASE_URL="$ML_READER_URL" ML_API_KEY="$ML_API_KEY" \
  DATA_LABEL=synthetic "$PY_ML" -m uvicorn api.app:app --port "$ML_PORT"
wait_for ml "http://127.0.0.1:${ML_PORT}/health"

# 2. Backend (Member 2)
start backend "$BACKEND_DIR" env DATABASE_URL="$OWNER_URL" ML_SERVICE_URL="http://127.0.0.1:${ML_PORT}" \
  ML_API_KEY="$ML_API_KEY" JWT_SECRET="$JWT_SECRET" QR_SECRET="$QR_SECRET" \
  "$PY_BACKEND" -m uvicorn app.main:app --port "$BACKEND_PORT"
wait_for backend "http://127.0.0.1:${BACKEND_PORT}/health"

# 3. Manager dashboard (Member 4): static files + /api/v1 proxy to the backend
start dashboard "$DASHBOARD_DIR" env PORT="$DASHBOARD_PORT" BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}" node server.js
wait_for dashboard "http://127.0.0.1:${DASHBOARD_PORT}/"

# 4. Student app (Member 1): Next.js, production build. Build first with: (cd student-app && npm run build)
start student-app "$STUDENT_APP_DIR" env BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}" npx next start -p "$STUDENT_APP_PORT"
wait_for student-app "http://127.0.0.1:${STUDENT_APP_PORT}/login"

echo
echo "All services running:"
echo "  Student app       http://localhost:${STUDENT_APP_PORT}     (log in as STU001 / password123)"
echo "  Manager dashboard http://localhost:${DASHBOARD_PORT}     (choose 'Mess Chief', MGR001 / password123)"
echo "  Backend API       http://localhost:${BACKEND_PORT}/docs"
echo "  ML service        http://localhost:${ML_PORT}/docs"
