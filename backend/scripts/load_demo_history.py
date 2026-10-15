"""DEVELOPMENT ONLY: fill meal_logs with SYNTHETIC history so the dashboard and ML have data to work with.

    python scripts/load_demo_history.py --csv /path/SYNTHETIC_meal_history.csv --days 240

The CSV comes from the ML project (python -m src.synthetic). Every student created here is fake
(roll numbers DEMO-S-*) and the data is labelled synthetic in the API responses.
Never run this against the real database.
"""
import argparse
import csv
import io
import os
import sys
from datetime import date, datetime, timedelta

import psycopg

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.security import hash_password  # noqa: E402

MESS_CODE_TO_ID = {"south": 1, "north": 2}
MEAL_CODE = {"breakfast": "breakfast", "lunch": "lunch", "dinner": "dinner"}
STUDENTS_PER_MESS = 900


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--days", type=int, default=240)
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL", "").replace("+psycopg", ""))
    args = ap.parse_args()

    with open(args.csv, newline="") as fh:
        rows = list(csv.DictReader(fh))
    dates = sorted({r["date"] for r in rows})
    keep = set(dates[-args.days:])
    rows = [r for r in rows if r["date"] in keep]
    # Shift the synthetic calendar so the history ends YESTERDAY (IST). Otherwise the forecast
    # service reports the history as stale, which is correct behaviour but makes the demo useless.
    from zoneinfo import ZoneInfo
    yesterday = datetime.now(ZoneInfo("Asia/Kolkata")).date() - timedelta(days=1)
    shift = yesterday - date.fromisoformat(max(keep))
    for r in rows:
        r["date"] = (date.fromisoformat(r["date"]) + shift).isoformat()
    print(f"Loading {len(rows)} SYNTHETIC rows covering {len(keep)} days")

    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM messes")
        known = {r[0] for r in cur.fetchall()}
        assert {1, 2} <= known, "run seed.py first (messes south and north must exist)"

        cur.execute("DELETE FROM ledger_entries WHERE meal_log_id IN (SELECT id FROM meal_logs WHERE qr_window = -1)")
        cur.execute("DELETE FROM meal_logs WHERE qr_window = -1")  # previous demo load, idempotent

        pw = hash_password("password123")
        for mess_id in (1, 2):
            cur.execute(
                "INSERT INTO students (roll_no, name, password_hash, role, mess_id, is_active) "
                "SELECT %s || lpad(g::text, 4, '0'), 'Demo student ' || g, %s, 'student', %s, TRUE "
                "FROM generate_series(1, %s) g "
                "ON CONFLICT (roll_no) DO NOTHING",
                (f"DEMO-S{mess_id}-", pw, mess_id, STUDENTS_PER_MESS),
            )
        cur.execute("SELECT id, mess_id, roll_no FROM students WHERE roll_no LIKE 'DEMO-S%%' ORDER BY roll_no")
        pool: dict[int, list[int]] = {1: [], 2: []}
        for sid, mid, _ in cur.fetchall():
            pool[mid].append(sid)

        buf = io.StringIO()
        writer = csv.writer(buf)
        for r in rows:
            mess_id = MESS_CODE_TO_ID.get(r["mess_id"].strip().lower())
            if mess_id is None:
                continue
            meal = MEAL_CODE.get(r["meal_type"].strip().lower())
            served = int(float(r["served_meals"]))
            if not meal or served <= 0:
                continue
            if served > len(pool[mess_id]):
                served = len(pool[mess_id])
            for sid in pool[mess_id][:served]:
                writer.writerow([sid, mess_id, r["date"], meal, -1])
        buf.seek(0)

        cur.execute("CREATE TEMP TABLE _demo_load (student_id int, mess_id int, meal_date date, meal_period text, qr_window int)")
        with cur.copy("COPY _demo_load FROM STDIN (FORMAT csv)") as copy:
            copy.write(buf.getvalue())
        cur.execute(
            "INSERT INTO meal_logs (student_id, mess_id, meal_date, meal_period, qr_window, scanned_at) "
            "SELECT student_id, mess_id, meal_date, meal_period, qr_window, now() FROM _demo_load "
            "ON CONFLICT ON CONSTRAINT uq_one_meal_per_period DO NOTHING"
        )
        print(f"Inserted {cur.rowcount} meal_logs rows")
        conn.commit()


if __name__ == "__main__":
    main()
