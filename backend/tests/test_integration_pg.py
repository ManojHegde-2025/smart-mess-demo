"""Integration tests on a REAL PostgreSQL database (not SQLite).

Set TEST_DATABASE_URL to a throwaway database, e.g.
    TEST_DATABASE_URL=postgresql+psycopg://mess:mess@localhost:5432/mess_test pytest tests/test_integration_pg.py
Without it these tests are skipped. The database is wiped at the start of the session.
"""
import os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

TEST_DB = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not TEST_DB, reason="set TEST_DATABASE_URL to run PostgreSQL integration tests")

IST = ZoneInfo("Asia/Kolkata")


@pytest.fixture(scope="session")
def app_module():
    os.environ["DATABASE_URL"] = TEST_DB
    os.environ.setdefault("JWT_SECRET", "test-jwt")
    os.environ.setdefault("QR_SECRET", "test-qr")
    from fastapi.testclient import TestClient  # noqa: F401
    import app.database as database
    from app import models  # noqa: F401
    from app.main import app as fastapi_app

    database.Base.metadata.drop_all(bind=database.engine)
    database.Base.metadata.create_all(bind=database.engine)
    return fastapi_app


@pytest.fixture(scope="session")
def seeded(app_module):
    from sqlalchemy import select
    from app.database import SessionLocal
    from app.models import Mess, Student
    from app.security import hash_password

    db = SessionLocal()
    db.add(Mess(id=1, name="South Mess", code="south"))
    db.add(Mess(id=2, name="North Mess", code="north"))
    db.flush()
    pw = hash_password("password123")
    db.add(Student(roll_no="MGR001", name="Manager", role="manager", password_hash=pw, mess_id=1))
    from app.models import LedgerEntry
    for i in range(1, 6):
        st = Student(roll_no=f"T{i:03d}", name=f"Student {i}", role="student", password_hash=pw, mess_id=1)
        db.add(st)
        db.flush()
        db.add(LedgerEntry(student_id=st.id, amount=10, reason="topup"))
    db.commit()
    db.close()
    return True


@pytest.fixture(scope="session")
def client(app_module, seeded):
    from fastapi.testclient import TestClient
    return TestClient(app_module)


def login(client, roll):
    r = client.post("/api/v1/auth/login", json={"roll_no": roll, "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="session")
def mgr(client):
    return login(client, "MGR001")


def lunch_at_today():
    now = datetime.now(IST)
    return now.replace(hour=12, minute=30, second=0, microsecond=0)


def test_scan_flow_allowed_duplicate_and_dashboard(client, mgr, monkeypatch, app_module):
    """Real HTTP path: a valid lunch scan is allowed, a repeat is a duplicate, both are logged and visible."""
    from app import routes
    from app.qr import issue_qr_token
    from app.scan_service import process_scan

    when = lunch_at_today()
    original = process_scan
    monkeypatch.setattr(routes, "process_scan", lambda db, sid, tok: original(db, sid, tok, now=when))

    token = issue_qr_token(1, "lunch", when.timestamp())
    stu = login(client, "T001")

    r1 = client.post("/api/v1/scans", json={"qr_token": token}, headers=stu)
    assert r1.status_code == 200
    body = r1.json()
    assert body["allowed"] is True and body["code"] == "OK"
    assert body["balance"] == 9  # 10 meals topped up, 1 debited

    r2 = client.post("/api/v1/scans", json={"qr_token": token}, headers=stu)
    assert r2.json()["code"] == "DUPLICATE"

    day = when.date().isoformat()
    summary = client.get(f"/api/v1/dashboard/summary?mess=South%20Mess&date={day}", headers=mgr).json()
    lunch = next(m for m in summary["meals"] if m["mealType"] == "Lunch")
    assert lunch["served"] == 1
    assert summary["exceptionCount"] == 1

    exc = client.get(f"/api/v1/exceptions?mess=south&from={day}&to={day}", headers=mgr).json()["exceptions"]
    assert [e["type"] for e in exc] == ["duplicate_scan"]
    assert exc[0]["subjectRef"].startswith("S-") and "T001" not in str(exc)  # no roll number leaks


def test_student_cannot_read_manager_data(client):
    stu = login(client, "T002")
    today = date.today().isoformat()
    for path in [
        f"/api/v1/dashboard/summary?mess=south&date={today}",
        f"/api/v1/exceptions?mess=south&from={today}&to={today}",
        f"/api/v1/reports/daily?mess=south&from={today}&to={today}",
    ]:
        assert client.get(path, headers=stu).status_code == 403
    assert client.get(f"/api/v1/dashboard/summary?mess=south&date={today}").status_code in (401, 403)


def test_leave_reduces_expected_and_blocks_scan(client, mgr, monkeypatch):
    from app import routes
    from app.qr import issue_qr_token
    from app.scan_service import process_scan

    when = lunch_at_today()
    day = when.date()
    t002 = client.post("/api/v1/auth/login", json={"roll_no": "T002", "password": "password123"}).json()
    from app.database import SessionLocal
    from app.models import Student
    from sqlalchemy import select
    db = SessionLocal()
    sid = db.scalar(select(Student.id).where(Student.roll_no == "T002"))
    db.close()

    before = client.get(f"/api/v1/dashboard/summary?mess=south&date={day.isoformat()}", headers=mgr).json()
    expected_before = before["meals"][0]["expected"]

    r = client.post("/api/v1/manager/leaves", headers=mgr,
                    json={"student_id": sid, "start_date": day.isoformat(), "end_date": day.isoformat(), "reason": "test"})
    assert r.status_code == 201

    after = client.get(f"/api/v1/dashboard/summary?mess=south&date={day.isoformat()}", headers=mgr).json()
    assert after["meals"][0]["expected"] == expected_before - 1

    original = process_scan
    monkeypatch.setattr(routes, "process_scan", lambda db, s, tok: original(db, s, tok, now=when))
    token = issue_qr_token(1, "lunch", when.timestamp())
    out = client.post("/api/v1/scans", json={"qr_token": token},
                      headers={"Authorization": f"Bearer {t002['access_token']}"}).json()
    assert out["code"] == "ON_LEAVE"


def test_prepared_counts_appear_in_report(client, mgr):
    day = (date.today() - timedelta(days=3)).isoformat()
    r = client.post("/api/v1/mess-usage/prepared", headers=mgr,
                    json={"mess": "South Mess", "date": day, "meal": "Dinner", "prepared": 800})
    assert r.status_code == 201
    r2 = client.post("/api/v1/mess-usage/prepared", headers=mgr,
                     json={"mess": "South Mess", "date": day, "meal": "Dinner", "prepared": 810})
    assert r2.status_code == 201  # upsert, not a duplicate error
    rep = client.get(f"/api/v1/reports/daily?mess=south&from={day}&to={day}", headers=mgr).json()
    dinner = next(x for x in rep["rows"] if x["mealType"] == "Dinner")
    assert dinner["prepared"] == 810


def test_forecast_stored_and_evaluated_with_fake_ml(client, mgr, monkeypatch):
    from app import manager_api
    from app.database import SessionLocal
    from app.models import Forecast, MealLog, Mess
    from sqlalchemy import select
    from app.jobs import evaluate as evaluate_job

    yesterday = date.today() - timedelta(days=1)

    def fake_predict(mess_code, day, meal, cfg=None):
        return True, {"mess_id": mess_code, "date": day, "meal_type": meal, "predicted_meals": 500,
                      "recommended_preparation": 510, "model_version": "xgb_test", "method": "xgboost",
                      "warnings": ["model was trained on SYNTHETIC data"],
                      "prediction_range": {"low": 480, "high": 520}}

    monkeypatch.setattr(manager_api, "predict_one", fake_predict)
    r = client.get(f"/api/v1/forecasts?mess=south&date={yesterday.isoformat()}", headers=mgr)
    assert r.status_code == 200
    body = r.json()
    assert len(body["forecasts"]) == 3 and body["unavailable"] == []
    assert body["forecasts"][0]["recommended_preparation"] == 510

    db = SessionLocal()
    mess_id = db.scalar(select(Mess.id).where(Mess.code == "south"))
    assert db.scalar(select(Forecast).where(Forecast.mess_id == mess_id).limit(1)) is not None
    # Actual served rows for yesterday so the forecast can be scored.
    db.add(MealLog(student_id=db.scalar(select(MealLog.student_id).limit(1)) or 1, mess_id=mess_id,
                   meal_date=yesterday, meal_period="lunch", qr_window=0))
    db.commit()
    db.close()

    ev = client.get(f"/api/v1/forecasts/evaluations?mess=south&from={yesterday.isoformat()}&to={yesterday.isoformat()}",
                    headers=mgr).json()
    assert any(rec["mealType"] == "Lunch" and rec["predictedCount"] == 500 for rec in ev["records"])
    assert all(rec["targetDate"] != date.today().isoformat() for rec in ev["records"])


def test_ml_unavailable_is_a_clear_error(client, mgr, monkeypatch):
    from app import manager_api
    from fastapi import HTTPException

    def down(*a, **k):
        raise HTTPException(status_code=503, detail="ML service unreachable: ConnectError")
    monkeypatch.setattr(manager_api, "predict_one", down)
    r = client.get(f"/api/v1/forecasts?mess=south&date={date.today().isoformat()}", headers=mgr)
    assert r.status_code == 503
    assert "unreachable" in r.json()["detail"]


def test_unknown_mess_and_bad_range_are_rejected(client, mgr):
    today = date.today().isoformat()
    assert client.get(f"/api/v1/dashboard/summary?mess=Nowhere&date={today}", headers=mgr).status_code == 404
    assert client.get(f"/api/v1/reports/daily?mess=south&from={today}&to=2000-01-01", headers=mgr).status_code == 400
    assert client.get(f"/api/v1/reports/daily?mess=south&from=2000-01-01&to=2010-01-01", headers=mgr).status_code == 400
