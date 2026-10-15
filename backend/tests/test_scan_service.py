from datetime import date, datetime

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import models  # noqa: F401
from app.database import Base
from app.models import LedgerEntry, Leave, MealLog, Mess, Student
from app.qr import issue_qr_token
from app.scan_service import IST, process_scan
from app.security import hash_password

LUNCH_TIME = datetime(2026, 10, 12, 12, 30, tzinfo=IST)
TODAY = date(2026, 10, 12)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()

    session.add(Mess(id=1, name="Main Mess"))
    session.flush()
    session.add(
        Student(
            id=1,
            roll_no="S1",
            name="Asha",
            password_hash=hash_password("x"),
            mess_id=1,
        )
    )
    session.flush()
    session.add(LedgerEntry(student_id=1, amount=5, reason="topup"))
    session.commit()

    yield session
    session.close()


def lunch_token(mess_id: int = 1, at: datetime = LUNCH_TIME) -> str:
    return issue_qr_token(mess_id, "lunch", at.timestamp())


def test_valid_scan_is_allowed_and_debits_balance(db):
    outcome = process_scan(db, 1, lunch_token(), now=LUNCH_TIME)

    assert outcome.allowed is True
    assert outcome.code == "OK"
    assert outcome.balance == 4
    assert db.scalar(select(MealLog.id)) is not None


def test_second_scan_same_period_is_duplicate(db):
    process_scan(db, 1, lunch_token(), now=LUNCH_TIME)
    outcome = process_scan(db, 1, lunch_token(), now=LUNCH_TIME)

    assert outcome.allowed is False
    assert outcome.code == "DUPLICATE"
    assert len(db.scalars(select(MealLog)).all()) == 1


def test_scan_outside_meal_window_is_rejected(db):
    afternoon = datetime(2026, 10, 12, 15, 0, tzinfo=IST)
    outcome = process_scan(db, 1, lunch_token(at=afternoon), now=afternoon)

    assert outcome.code == "MEAL_NOT_OPEN"


def test_breakfast_token_at_lunch_is_rejected(db):
    breakfast = issue_qr_token(1, "breakfast", LUNCH_TIME.timestamp())
    outcome = process_scan(db, 1, breakfast, now=LUNCH_TIME)

    assert outcome.code == "MEAL_NOT_OPEN"


def test_tampered_token_is_invalid(db):
    token = lunch_token().replace(".1.lunch", ".2.lunch")
    outcome = process_scan(db, 1, token, now=LUNCH_TIME)

    assert outcome.code == "INVALID_QR"


def test_expired_token_is_rejected(db):
    old = LUNCH_TIME.timestamp() - 120  # several rotation windows old
    token = issue_qr_token(1, "lunch", old)
    outcome = process_scan(db, 1, token, now=LUNCH_TIME)

    assert outcome.code == "QR_EXPIRED"


def test_student_on_leave_is_rejected(db):
    db.add(Leave(student_id=1, start_date=TODAY, end_date=TODAY, status="approved"))
    db.commit()
    outcome = process_scan(db, 1, lunch_token(), now=LUNCH_TIME)

    assert outcome.code == "ON_LEAVE"


def test_cancelled_leave_does_not_block(db):
    db.add(Leave(student_id=1, start_date=TODAY, end_date=TODAY, status="cancelled"))
    db.commit()
    outcome = process_scan(db, 1, lunch_token(), now=LUNCH_TIME)

    assert outcome.allowed is True


def test_insufficient_balance_is_rejected(db):
    db.add(LedgerEntry(student_id=1, amount=-5, reason="adjustment"))
    db.commit()
    outcome = process_scan(db, 1, lunch_token(), now=LUNCH_TIME)

    assert outcome.code == "INSUFFICIENT_BALANCE"
    assert outcome.balance == 0


def test_student_from_other_mess_is_rejected(db):
    outcome = process_scan(db, 1, lunch_token(mess_id=2), now=LUNCH_TIME)

    assert outcome.code == "WRONG_MESS"
