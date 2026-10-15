#!/usr/bin/env bash
# Runs every test suite. Services must be running for the live and contract tests (scripts/start-all.sh).
set -uo pipefail
source "$(dirname "$0")/env.sh"
fail=0
run() { echo; echo "== $1"; shift; "$@" || fail=1; }

run "backend unit tests (SQLite)" bash -c "cd '$BACKEND_DIR' && '$PY_BACKEND' -m pytest -q --ignore=tests/test_integration_pg.py --ignore=tests/test_contract_live.py"
run "backend PostgreSQL integration" bash -c "cd '$BACKEND_DIR' && TEST_DATABASE_URL='postgresql+psycopg://${DB_OWNER}:${DB_OWNER_PASSWORD}@${DB_HOST}:${DB_PORT}/mess_test' '$PY_BACKEND' -m pytest -q tests/test_integration_pg.py"
run "API contract (live services)" bash -c "cd '$BACKEND_DIR' && CONTRACT_BASE_URL='http://127.0.0.1:${BACKEND_PORT}/api/v1' CONTRACT_ML_URL='http://127.0.0.1:${ML_PORT}' CONTRACT_ML_KEY='$ML_API_KEY' CONTRACT_REQUIRE_ML=1 '$PY_BACKEND' -m pytest -q -rs tests/test_contract_live.py"
run "manager dashboard unit tests" bash -c "cd '$DASHBOARD_DIR' && node --test test/calc.test.js test/api.test.js test/dashboard.test.js test/static.test.js test/ml-adapter.test.js"
run "manager dashboard browser tests (mock)" bash -c "cd '$DASHBOARD_DIR' && node --test --test-concurrency=1 test/e2e.test.js"
run "manager dashboard LIVE browser test (real backend)" bash -c "cd '$DASHBOARD_DIR' && LIVE_BACKEND=1 BACKEND_URL='http://127.0.0.1:${BACKEND_PORT}' node --test test/live-backend.test.js"
run "student app LIVE browser test (real backend)" bash -c "cd '$STUDENT_APP_DIR' && LIVE_BACKEND=1 BACKEND_URL='http://127.0.0.1:${BACKEND_PORT}' APP_URL='http://localhost:${STUDENT_APP_PORT}' node --test test/live-backend.test.js"

echo
if [[ $fail -eq 0 ]]; then echo "ALL SUITES PASSED"; else echo "SOME SUITES FAILED"; fi
exit $fail
