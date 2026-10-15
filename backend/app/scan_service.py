"""
Scan validation pipeline. Every check runs in one transaction while the
student row is locked, so two rapid scans cannot both pass the balance check.

Order of checks:
  1. account active
  2. QR signature and freshness
  3. meal period is open right now and matches the QR
  4. student belongs to this mess
  5. no approved leave covering today
  6. no meal already logged for this period today (duplicate prevention)
  7. enough balance in the ledger
  8. write meal_log + ledger debit atomically
"""

from dataclasses import dataclass
from datetime import datetime, time
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models import LedgerEntry, Leave, MealLog, Student
from app.qr import QRError, verify_qr_token

IST = ZoneInfo("Asia/Kolkata")

MEAL_WINDOWS: dict[str, tuple[time, time]] = {
    "breakfast": (time(7, 0), time(9, 30)),
    "lunch": (time(12, 0), time(14, 30)),
    "dinner": (time(19, 0), time(21, 30)),
}


@dataclass
class ScanOutcome:
    allowed: bool
    code: str
    message: str
    meal_period: str | None = None
    meal_log_id: int | None = None
    balance: int | None = None


def current_meal_period(now: datetime) -> str | None:
    local_time = now.astimezone(IST).time()
    for period, (start, end) in MEAL_WINDOWS.items():
        if start <= local_time <= end:
            return period
    return None


def get_balance(db: Session, student_id: int) -> int:
    total = db.scalar(
        select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(
            LedgerEntry.student_id == student_id
        )
    )
    return int(total)


def _on_leave(db: Session, student_id: int, day) -> bool:
    row = db.scalar(
        select(Leave.id)
        .where(
            Leave.student_id == student_id,
            Leave.status == "approved",
            Leave.start_date <= day,
            Leave.end_date >= day,
        )
        .limit(1)
    )
    return row is not None


def _deny(code: str, message: str, **extra) -> ScanOutcome:
    return ScanOutcome(allowed=False, code=code, message=message, **extra)


def process_scan(db: Session, student_id: int, qr_token: str, now: datetime | None = None) -> ScanOutcome:
    now = now or datetime.now(IST)
    today = now.astimezone(IST).date()

    student = db.scalar(
        select(Student).where(Student.id == student_id).with_for_update()
    )
    if student is None or not student.is_active:
        return _deny("ACCOUNT_INACTIVE", "Your account is not active. Contact the mess office.")

    try:
        mess_id, qr_period, window = verify_qr_token(qr_token, now.timestamp())
    except QRError as err:
        return _deny(err.code, err.message)

    if current_meal_period(now) != qr_period:
        return _deny("MEAL_NOT_OPEN", "This meal is not being served right now.", meal_period=qr_period)

    if student.mess_id != mess_id:
        return _deny("WRONG_MESS", "This QR code belongs to a different mess.", meal_period=qr_period)

    if _on_leave(db, student.id, today):
        return _deny("ON_LEAVE", "You are on approved leave today.", meal_period=qr_period)

    already_logged = db.scalar(
        select(MealLog.id).where(
            MealLog.student_id == student.id,
            MealLog.meal_date == today,
            MealLog.meal_period == qr_period,
        )
    )
    if already_logged is not None:
        return _deny("DUPLICATE", f"You have already had {qr_period} today.", meal_period=qr_period)

    balance = get_balance(db, student.id)
    if balance < settings.meal_cost:
        return _deny(
            "INSUFFICIENT_BALANCE",
            "Not enough meal balance. Please top up.",
            meal_period=qr_period,
            balance=balance,
        )

    try:
        meal = MealLog(
            student_id=student.id,
            mess_id=mess_id,
            meal_date=today,
            meal_period=qr_period,
            qr_window=window,
        )
        db.add(meal)
        db.flush()
        db.add(
            LedgerEntry(
                student_id=student.id,
                amount=-settings.meal_cost,
                reason="meal",
                meal_log_id=meal.id,
            )
        )
        db.commit()
    except IntegrityError:
        # Backstop for a race that slipped past the lock: the unique constraint wins.
        db.rollback()
        return _deny("DUPLICATE", f"You have already had {qr_period} today.", meal_period=qr_period)

    return ScanOutcome(
        allowed=True,
        code="OK",
        message="Meal recorded. Enjoy your meal!",
        meal_period=qr_period,
        meal_log_id=meal.id,
        balance=balance - settings.meal_cost,
    )
