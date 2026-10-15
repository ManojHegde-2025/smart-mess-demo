"""Contract tests against the RUNNING services. Run after every backend change, before merging.

These check only the fields each consumer reads. Extra fields are allowed, so adding things is safe;
removing or renaming a field fails here.

Environment (defaults in brackets):
  CONTRACT_BASE_URL   backend base incl. /api/v1      [http://localhost:8000/api/v1]
  CONTRACT_ML_URL     ML service base (optional)      [http://localhost:8100]
  CONTRACT_ML_KEY     ML API key (optional)           []
  CONTRACT_MANAGER    manager roll number             [MGR001]
  CONTRACT_STUDENT    student roll number             [STU001]
  CONTRACT_PASSWORD   password for both               [password123]
  CONTRACT_MESS       mess code used in the checks    [south]
Skipped automatically when the backend is not reachable.
"""
import os
from datetime import date, timedelta

import httpx
import pytest

BASE = os.getenv("CONTRACT_BASE_URL", "http://localhost:8000/api/v1").rstrip("/")
ML = os.getenv("CONTRACT_ML_URL", "http://localhost:8100").rstrip("/")
ML_KEY = os.getenv("CONTRACT_ML_KEY", "")
MANAGER = os.getenv("CONTRACT_MANAGER", "MGR001")
STUDENT = os.getenv("CONTRACT_STUDENT", "STU001")
PASSWORD = os.getenv("CONTRACT_PASSWORD", "password123")
MESS = os.getenv("CONTRACT_MESS", "south")


def _reachable(url: str) -> bool:
    try:
        return httpx.get(url, timeout=3).status_code < 500
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(not _reachable(BASE.replace("/api/v1", "") + "/health"),
                                reason="backend not running at CONTRACT_BASE_URL")


def assert_keys(obj: dict, keys: set[str], where: str):
    missing = keys - set(obj)
    assert not missing, f"{where}: missing fields {sorted(missing)}"


@pytest.fixture(scope="module")
def mgr_headers():
    r = httpx.post(f"{BASE}/auth/login", json={"roll_no": MANAGER, "password": PASSWORD}, timeout=10)
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "manager"
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def stu_headers():
    r = httpx.post(f"{BASE}/auth/login", json={"roll_no": STUDENT, "password": PASSWORD}, timeout=10)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ---------------------------------------------------------------- Member 1 (student app)

def test_student_login_and_profile(stu_headers):
    r = httpx.get(f"{BASE}/me", headers=stu_headers, timeout=10)
    assert r.status_code == 200
    assert_keys(r.json(), {"id", "roll_no", "name", "role", "mess_id", "balance"}, "GET /me")
    assert isinstance(r.json()["balance"], int)


def test_student_meal_history_shape(stu_headers):
    r = httpx.get(f"{BASE}/me/meals?limit=5", headers=stu_headers, timeout=10)
    assert r.status_code == 200 and isinstance(r.json(), list)
    for item in r.json():
        assert_keys(item, {"id", "meal_date", "meal_period", "mess_id", "scanned_at"}, "GET /me/meals item")


def test_scan_result_shape_for_green_red_screens(stu_headers):
    r = httpx.post(f"{BASE}/scans", json={"qr_token": "not-a-real-code"}, headers=stu_headers, timeout=10)
    assert r.status_code == 200  # always 200; the app reads allowed/code/message
    assert_keys(r.json(), {"allowed", "code", "message", "meal_period", "meal_log_id", "balance"}, "POST /scans")
    assert r.json()["allowed"] is False and r.json()["code"] == "INVALID_QR"


def test_student_cannot_call_manager_endpoints(stu_headers):
    today = date.today().isoformat()
    r = httpx.get(f"{BASE}/dashboard/summary?mess={MESS}&date={today}", headers=stu_headers, timeout=10)
    assert r.status_code == 403


# ---------------------------------------------------------------- Member 4 (manager dashboard)

def test_summary_shape(mgr_headers):
    today = date.today().isoformat()
    r = httpx.get(f"{BASE}/dashboard/summary?mess={MESS}&date={today}", headers=mgr_headers, timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert_keys(body, {"mess", "date", "generatedAt", "exceptionCount", "meals"}, "summary")
    assert len(body["meals"]) == 3
    for m in body["meals"]:
        assert_keys(m, {"mealType", "expected", "served", "prepared"}, "summary meal")


def test_exceptions_shape(mgr_headers):
    today = date.today().isoformat()
    r = httpx.get(f"{BASE}/exceptions?mess={MESS}&from={today}&to={today}", headers=mgr_headers, timeout=10)
    assert r.status_code == 200 and "exceptions" in r.json()
    for e in r.json()["exceptions"]:
        assert_keys(e, {"id", "timestamp", "type", "description", "subjectRef", "status"}, "exception")


def test_daily_report_shape(mgr_headers):
    start = (date.today() - timedelta(days=2)).isoformat()
    end = date.today().isoformat()
    r = httpx.get(f"{BASE}/reports/daily?mess={MESS}&from={start}&to={end}", headers=mgr_headers, timeout=10)
    assert r.status_code == 200
    rows = r.json()["rows"]
    assert len(rows) == 3 * 3  # 3 days x 3 meals
    for row in rows:
        assert_keys(row, {"date", "mealType", "expected", "served", "prepared", "predictedCount"}, "report row")


def test_forecast_shape_when_ml_is_up(mgr_headers):
    r = httpx.get(f"{BASE}/forecasts?mess={MESS}&date={date.today().isoformat()}", headers=mgr_headers, timeout=30)
    if r.status_code == 503:
        # Skip only when asked to; the full test run sets CONTRACT_REQUIRE_ML=1 so a broken ML link fails loudly.
        if os.getenv("CONTRACT_REQUIRE_ML") == "1":
            pytest.fail(f"backend cannot reach the ML service: {r.text}")
        pytest.skip("ML service not reachable from the backend")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "forecasts" in body and "unavailable" in body
    for f in body["forecasts"]:
        assert_keys(f, {"mess_id", "date", "meal_type", "predicted_meals", "recommended_preparation",
                        "prediction_range", "model_version", "method", "warnings"}, "forecast")
    for u in body["unavailable"]:
        assert_keys(u, {"meal_type", "reason"}, "unavailable")


def test_evaluations_shape(mgr_headers):
    start = (date.today() - timedelta(days=7)).isoformat()
    end = (date.today() - timedelta(days=1)).isoformat()
    r = httpx.get(f"{BASE}/forecasts/evaluations?mess={MESS}&from={start}&to={end}", headers=mgr_headers, timeout=10)
    assert r.status_code == 200 and "records" in r.json()
    for rec in r.json()["records"]:
        assert_keys(rec, {"targetDate", "mealType", "predictedCount", "actualCount", "modelVersion"}, "evaluation")


# ---------------------------------------------------------------- Member 3 (ML service)

@pytest.mark.skipif(not _reachable(ML + "/health"), reason="ML service not running at CONTRACT_ML_URL")
def test_ml_predict_fields_the_backend_reads():
    r = httpx.post(f"{ML}/predict", headers={"X-API-Key": ML_KEY},
                   json={"mess_id": MESS, "date": date.today().isoformat(), "meal_type": "lunch"}, timeout=20)
    assert r.status_code in (200, 422), r.text
    if r.status_code == 200:
        assert_keys(r.json(), {"predicted_meals", "recommended_preparation", "prediction_range",
                               "model_version", "method", "warnings"}, "ML /predict")
