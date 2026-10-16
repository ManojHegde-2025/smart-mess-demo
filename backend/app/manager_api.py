"""Manager dashboard API (Member 2). Every route requires a manager Bearer token.

Paths follow docs/API_CONTRACT.md from Member 4, served under /api/v1.
Missing numbers are returned as null, never as 0, unless the value really is zero.
"""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import distinct, func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.db_diagnostics import database_diagnostics
from app.deps import require_manager
from app.ml_client import MlSettings, evaluate_pairs, predict_one
from app.mess import MEAL_PERIODS, normalize_meal, resolve_mess
from app.models import Forecast, ForecastEvaluation, Leave, MealLog, Mess, PreparedCount, ScanAttempt, Student

router = APIRouter()
IST = ZoneInfo("Asia/Kolkata")
MAX_RANGE_DAYS = 366

EXCEPTION_TYPES = {
    "DUPLICATE": ("duplicate_scan", "Second scan attempt for the same meal"),
    "ON_LEAVE": ("leave_rejection", "Student is on approved leave"),
    "INVALID_QR": ("invalid_scan", "QR code not recognised"),
    "QR_EXPIRED": ("invalid_scan", "QR code expired"),
    "MEAL_NOT_OPEN": ("meal_not_open", "Scan outside the meal window"),
    "WRONG_MESS": ("wrong_mess", "Student belongs to a different mess"),
    "INSUFFICIENT_BALANCE": ("insufficient_balance", "Meal balance too low"),
    "ACCOUNT_INACTIVE": ("account_inactive", "Account not active"),
}


# ---------------------------------------------------------------- helpers

@router.get("/manager/diagnostics/database")
def manager_database_diagnostics(
    _: Student = Depends(require_manager),
    db: Session = Depends(get_db),
):
    """Temporary read-only database identity check; manager access required."""
    try:
        return database_diagnostics(db)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

def _today() -> date:
    return datetime.now(IST).date()


def _day_bounds(day: date) -> tuple[datetime, datetime]:
    start = datetime.combine(day, time(0), tzinfo=IST)
    return start, start + timedelta(days=1)


def _parse_range(start: date, end: date) -> None:
    if end < start:
        raise HTTPException(status_code=400, detail="'to' is before 'from'")
    if (end - start).days + 1 > MAX_RANGE_DAYS:
        raise HTTPException(status_code=400, detail=f"range is longer than {MAX_RANGE_DAYS} days")


def _expected_for(db: Session, mess_id: int, day: date) -> int:
    """Expected meals for one day = active students assigned to the mess, minus approved leave covering that day.

    Uses the CURRENT roster (no roster history is stored yet), so past days can drift. Same value for every meal.
    """
    roster = (
        Student.mess_id == mess_id,
        Student.role == "student",
        Student.is_active.is_(True),
    )
    total = db.scalar(select(func.count()).select_from(Student).where(*roster)) or 0
    on_leave = db.scalar(
        select(func.count(distinct(Leave.student_id)))
        .select_from(Leave)
        .join(Student, Student.id == Leave.student_id)
        .where(
            *roster,
            Leave.status == "approved",
            Leave.start_date <= day,
            Leave.end_date >= day,
        )
    ) or 0
    return max(total - on_leave, 0)


def _has_demo_students(db: Session, mess_id: int) -> bool:
    found = db.scalar(
        select(func.count()).select_from(Student).where(
            Student.mess_id == mess_id, Student.roll_no.like("DEMO-%")
        )
    )
    return bool(found)


def _served_by_day_and_meal(db: Session, mess_id: int, start: date, end: date) -> dict[tuple[date, str], int]:
    rows = db.execute(
        select(MealLog.meal_date, MealLog.meal_period, func.count())
        .where(MealLog.mess_id == mess_id, MealLog.meal_date.between(start, end))
        .group_by(MealLog.meal_date, MealLog.meal_period)
    ).all()
    return {(d, p): n for d, p, n in rows}


def _prepared_by_day_and_meal(db: Session, mess_id: int, start: date, end: date) -> dict[tuple[date, str], int]:
    rows = db.execute(
        select(PreparedCount.meal_date, PreparedCount.meal_period, PreparedCount.prepared_count)
        .where(PreparedCount.mess_id == mess_id, PreparedCount.meal_date.between(start, end))
    ).all()
    return {(d, p): n for d, p, n in rows}


def _latest_forecasts(db: Session, mess_id: int, start: date, end: date) -> dict[tuple[date, str], Forecast]:
    rows = db.scalars(
        select(Forecast)
        .where(Forecast.mess_id == mess_id, Forecast.target_date.between(start, end))
        .order_by(Forecast.id.desc())
    ).all()
    latest: dict[tuple[date, str], Forecast] = {}
    for f in rows:  # newest first, so the first one seen per key is the latest
        latest.setdefault((f.target_date, f.meal_period), f)
    return latest


# ---------------------------------------------------------------- schemas

class PreparedIn(BaseModel):
    mess: str
    date: date
    meal: str
    prepared: int = Field(ge=0, le=100000)


# ---------------------------------------------------------------- endpoints

@router.get("/dashboard/summary")
def dashboard_summary(
    mess: str = Query(...),
    date_: date = Query(..., alias="date"),
    _: Student = Depends(require_manager),
    db: Session = Depends(get_db),
):
    m = resolve_mess(db, mess)
    expected = _expected_for(db, m.id, date_)
    served = _served_by_day_and_meal(db, m.id, date_, date_)
    prepared = _prepared_by_day_and_meal(db, m.id, date_, date_)
    start, end = _day_bounds(date_)
    exceptions = db.scalar(
        select(func.count()).select_from(ScanAttempt).where(
            ScanAttempt.mess_id == m.id,
            ScanAttempt.allowed.is_(False),
            ScanAttempt.created_at >= start,
            ScanAttempt.created_at < end,
        )
    ) or 0
    meals = [
        {
            "mealType": p.capitalize(),
            "expected": expected,
            "served": served.get((date_, p), 0),
            "prepared": prepared.get((date_, p)),  # None until the manager enters it
        }
        for p in MEAL_PERIODS
    ]
    return {
        "mess": m.name,
        "messId": m.code,
        "date": date_.isoformat(),
        "generatedAt": datetime.now(IST).isoformat(),
        "exceptionCount": exceptions,
        # True when this mess contains demo students (loaded by scripts/load_demo_history.py).
        "synthetic": _has_demo_students(db, m.id),
        "meals": meals,
    }


@router.post("/mess-usage/prepared", status_code=201)
def set_prepared(body: PreparedIn, _: Student = Depends(require_manager), db: Session = Depends(get_db)):
    m = resolve_mess(db, body.mess)
    meal = normalize_meal(body.meal)
    row = db.scalar(
        select(PreparedCount).where(
            PreparedCount.mess_id == m.id,
            PreparedCount.meal_date == body.date,
            PreparedCount.meal_period == meal,
        )
    )
    if row is None:
        row = PreparedCount(mess_id=m.id, meal_date=body.date, meal_period=meal, prepared_count=body.prepared)
        db.add(row)
    else:
        row.prepared_count = body.prepared
        row.updated_at = datetime.now(IST)
    db.commit()
    return {"mess": m.code, "date": body.date.isoformat(), "meal": meal, "prepared": body.prepared}


@router.get("/exceptions")
def exceptions(
    mess: str = Query(...),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    _: Student = Depends(require_manager),
    db: Session = Depends(get_db),
):
    m = resolve_mess(db, mess)
    _parse_range(date_from, date_to)
    start = _day_bounds(date_from)[0]
    end = _day_bounds(date_to)[1]
    rows = db.scalars(
        select(ScanAttempt)
        .where(
            ScanAttempt.mess_id == m.id,
            ScanAttempt.allowed.is_(False),
            ScanAttempt.created_at >= start,
            ScanAttempt.created_at < end,
        )
        .order_by(ScanAttempt.created_at.desc())
        .limit(500)
    ).all()
    out = []
    for r in rows:
        kind, text = EXCEPTION_TYPES.get(r.code, (r.code.lower(), r.code.replace("_", " ").capitalize()))
        out.append(
            {
                "id": f"e{r.id}",
                "timestamp": r.created_at.astimezone(IST).replace(tzinfo=None).isoformat(timespec="seconds"),
                "type": kind,
                "description": text,
                "subjectRef": r.student_ref,
                "status": "rejected",
            }
        )
    return {"exceptions": out}


@router.get("/reports/daily")
def daily_report(
    mess: str = Query(...),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    _: Student = Depends(require_manager),
    db: Session = Depends(get_db),
):
    m = resolve_mess(db, mess)
    _parse_range(date_from, date_to)
    served = _served_by_day_and_meal(db, m.id, date_from, date_to)
    prepared = _prepared_by_day_and_meal(db, m.id, date_from, date_to)
    forecasts = _latest_forecasts(db, m.id, date_from, date_to)
    today = _today()
    rows = []
    day = date_from
    while day <= date_to:
        expected = _expected_for(db, m.id, day)
        for p in MEAL_PERIODS:
            f = forecasts.get((day, p))
            rows.append(
                {
                    "date": day.isoformat(),
                    "mealType": p.capitalize(),
                    "expected": expected,
                    # Future meals have no served count yet, so return null rather than 0.
                    "served": served.get((day, p), 0) if day <= today else None,
                    "prepared": prepared.get((day, p)),
                    "predictedCount": f.predicted_meals if f else None,
                }
            )
        day += timedelta(days=1)
    return {"mess": m.code, "from": date_from.isoformat(), "to": date_to.isoformat(), "rows": rows}


@router.get("/forecasts")
def forecasts(
    mess: str = Query(...),
    date_: date = Query(..., alias="date"),
    _: Student = Depends(require_manager),
    db: Session = Depends(get_db),
):
    m = resolve_mess(db, mess)
    if not m.code:
        raise HTTPException(status_code=409, detail="This mess has no code yet; set messes.code (e.g. 'south')")
    cfg = MlSettings()
    out, unavailable = [], []
    for p in MEAL_PERIODS:
        ok, body = predict_one(m.code, date_.isoformat(), p, cfg)
        if not ok:
            unavailable.append({"meal_type": p.capitalize(), "reason": body["reason"]})
            continue
        db.add(
            Forecast(
                mess_id=m.id,
                target_date=date_,
                meal_period=p,
                predicted_meals=int(round(body["predicted_meals"])),
                recommended_preparation=body.get("recommended_preparation"),
                range_low=(body.get("prediction_range") or {}).get("low"),
                range_high=(body.get("prediction_range") or {}).get("high"),
                model_version=body.get("model_version"),
                method=body.get("method"),
            )
        )
        out.append(body)
    db.commit()
    return {
        "mess": m.code,
        "date": date_.isoformat(),
        "forecasts": out,
        "unavailable": unavailable,
    }


@router.get("/forecasts/evaluations")
def forecast_evaluations(
    mess: str = Query(...),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    meal: str | None = Query(default=None),
    _: Student = Depends(require_manager),
    db: Session = Depends(get_db),
):
    """Predicted vs actual for finished meals. Today is excluded because meals are still in service."""
    m = resolve_mess(db, mess)
    _parse_range(date_from, date_to)
    today = _today()
    end = min(date_to, today - timedelta(days=1))
    if end < date_from:
        return {"records": []}
    served = _served_by_day_and_meal(db, m.id, date_from, end)
    latest = _latest_forecasts(db, m.id, date_from, end)
    wanted = normalize_meal(meal) if meal else None
    records = []
    for (day, p), f in sorted(latest.items()):
        if wanted and p != wanted:
            continue
        if (day, p) not in served:
            continue  # no actual yet, nothing to compare
        records.append(
            {
                "targetDate": day.isoformat(),
                "mealType": p.capitalize(),
                "predictedCount": f.predicted_meals,
                "actualCount": served[(day, p)],
                "modelVersion": f.model_version,
            }
        )
    return {"records": records}
