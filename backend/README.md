# Mess Attendance Backend (Member 2)

FastAPI + PostgreSQL. Owns auth, QR validation, duplicate prevention, meal logs,
leave status, the balance ledger, and the database schema.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # then set JWT_SECRET and QR_SECRET
createdb mess_attendance           # or create it in pgAdmin / psql
psql mess_attendance -f schema.sql
python seed.py                     # creates a manager (MGR001) and student (STU001), password password123
uvicorn app.main:app --reload
```

Interactive docs: http://localhost:8000/docs

## Run tests

```bash
pytest
```

Tests use in-memory SQLite for the rules. Run the API against PostgreSQL for
real locking behaviour.

## API contract

Base path: `/api/v1`. Send `Authorization: Bearer <token>` after login.

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/auth/login` | anyone | `{roll_no, password}` → `{access_token, role}` |
| GET | `/me` | student | Profile and current balance |
| GET | `/me/balance` | student | Balance only |
| GET | `/me/meals?limit=50` | student | Meal history, newest first |
| POST | `/scans` | student | `{qr_token}` → result (always HTTP 200, see below) |
| GET | `/manager/qr?mess_id=1` | manager | Current rotating QR token for the mess terminal |
| POST | `/manager/leaves` | manager | `{student_id, start_date, end_date, reason}` |
| POST | `/manager/topups` | manager | `{student_id, meals}` |
| GET | `/manager/meal-counts?mess_id=1&day=2026-10-12` | manager | Live counts per period (Member 4) |
| GET | `/manager/meal-history?mess_id=1&start=...&end=...` | manager | Daily aggregates (Member 3, ML training data) |

### Scan result (what the student app renders)

```json
{ "allowed": true,  "code": "OK",                   "message": "Meal recorded. Enjoy your meal!", "meal_period": "lunch", "meal_log_id": 42, "balance": 29 }
{ "allowed": false, "code": "DUPLICATE",            "message": "You have already had lunch today.", ... }
```

Green screen when `allowed` is true, red screen otherwise. Show `message`.

| code | Meaning |
|---|---|
| `OK` | Meal logged and 1 meal debited |
| `INVALID_QR` | Not a token from this system, or signature mismatch |
| `QR_EXPIRED` | Token older than about one rotation window |
| `MEAL_NOT_OPEN` | Token's meal period is not being served now |
| `WRONG_MESS` | Student belongs to a different mess |
| `ON_LEAVE` | Approved leave covers today |
| `DUPLICATE` | Already logged this period today |
| `INSUFFICIENT_BALANCE` | Balance below meal cost |
| `ACCOUNT_INACTIVE` | Account disabled |

## How the QR works

The mess terminal (manager screen) calls `GET /manager/qr` every few seconds and
renders `qr_token` as a QR code. The token rotates every `QR_ROTATE_SECONDS`
(default 30), so a photo or screenshot goes stale fast. A token is accepted for
its own window and the previous one.

Token format: `v1.<mess_id>.<meal_period>.<window>.<hmac>`

## Duplicate prevention (three layers)

1. Application check in `scan_service.py` for a clear error message.
2. Row lock on the student (`SELECT ... FOR UPDATE`) so two scans cannot race past the balance check.
3. Unique constraint `(student_id, meal_date, meal_period)` in the database as the final guard.

## Balance ledger

`ledger_entries` is append-only. Balance is `SUM(amount)`. Top-ups are positive,
meal debits are `-MEAL_COST`. Corrections are new `adjustment` rows, never edits.

## Notes for teammates

- Member 1 (student frontend): send the scanned QR string as-is in `qr_token`.
- Member 4 (manager dashboard): poll `/manager/meal-counts` for live cards. Use `/manager/meal-history` for the waste and reports pages.
- Member 3 (ML): `/manager/meal-history` returns one row per (date, period) with a count. Missing days mean zero meals.
- Times use Asia/Kolkata. Meal windows are in `scan_service.MEAL_WINDOWS`.

## Before a demo

- Replace the default `JWT_SECRET` and `QR_SECRET`.
- Put the API behind HTTPS if it is reachable from phones on a network.
- Consider Alembic migrations once the schema starts changing.
