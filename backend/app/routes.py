from dataclasses import asdict
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.audit import record_attempt
from app.deps import current_student, require_manager
from app.models import Leave, LedgerEntry, MealLog, Mess, Student
from app.qr import issue_qr_token
from app.scan_service import IST, MEAL_WINDOWS, current_meal_period, get_balance, process_scan
from app.schemas import (
    LeaveIn,
    LoginIn,
    MealOut,
    ScanIn,
    ScanOut,
    StudentOut,
    TokenOut,
    TopupIn,
)
from app.security import create_access_token, verify_password

router = APIRouter()


# ---------------------------------------------------------------- auth

@router.post("/auth/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    student = db.scalar(select(Student).where(Student.roll_no == body.roll_no))
    if student is None or not student.is_active or not verify_password(body.password, student.password_hash):
        raise HTTPException(status_code=401, detail="Invalid roll number or password")
    return TokenOut(access_token=create_access_token(student.id, student.role), role=student.role)


# ---------------------------------------------------------------- student

@router.get("/me", response_model=StudentOut)
def me(student: Student = Depends(current_student), db: Session = Depends(get_db)):
    return StudentOut(
        id=student.id,
        roll_no=student.roll_no,
        name=student.name,
        role=student.role,
        mess_id=student.mess_id,
        balance=get_balance(db, student.id),
    )


@router.get("/me/balance")
def my_balance(student: Student = Depends(current_student), db: Session = Depends(get_db)):
    return {"student_id": student.id, "balance": get_balance(db, student.id)}


@router.get("/me/meals", response_model=list[MealOut])
def my_meals(
    limit: int = Query(50, ge=1, le=200),
    student: Student = Depends(current_student),
    db: Session = Depends(get_db),
):
    return db.scalars(
        select(MealLog)
        .where(MealLog.student_id == student.id)
        .order_by(MealLog.scanned_at.desc())
        .limit(limit)
    ).all()


@router.post("/scans", response_model=ScanOut)
def scan(body: ScanIn, student: Student = Depends(current_student), db: Session = Depends(get_db)):
    # Always 200: the frontend renders green or red from the `allowed` flag and `code`.
    outcome = process_scan(db, student.id, body.qr_token)
    record_attempt(db, student, outcome)  # keeps the response shape unchanged
    return ScanOut(**asdict(outcome))


# ---------------------------------------------------------------- manager

@router.get("/manager/qr")
def current_qr(
    mess_id: int = Query(...),
    _: Student = Depends(require_manager),
    db: Session = Depends(get_db),
):
    """Current rotating QR token for the mess terminal screen."""
    if db.get(Mess, mess_id) is None:
        raise HTTPException(status_code=404, detail="Mess not found")
    period = current_meal_period(datetime.now(IST))
    if period is None:
        raise HTTPException(status_code=409, detail="No meal is being served right now")
    return {
        "mess_id": mess_id,
        "meal_period": period,
        "qr_token": issue_qr_token(mess_id, period),
        "rotate_seconds": settings.qr_rotate_seconds,
    }


@router.post("/manager/leaves", status_code=201)
def create_leave(body: LeaveIn, _: Student = Depends(require_manager), db: Session = Depends(get_db)):
    if body.end_date < body.start_date:
        raise HTTPException(status_code=400, detail="end_date is before start_date")
    if db.get(Student, body.student_id) is None:
        raise HTTPException(status_code=404, detail="Student not found")
    leave = Leave(
        student_id=body.student_id,
        start_date=body.start_date,
        end_date=body.end_date,
        reason=body.reason,
    )
    db.add(leave)
    db.commit()
    db.refresh(leave)
    return {"id": leave.id, "status": leave.status}


@router.post("/manager/topups", status_code=201)
def topup(body: TopupIn, _: Student = Depends(require_manager), db: Session = Depends(get_db)):
    if db.get(Student, body.student_id) is None:
        raise HTTPException(status_code=404, detail="Student not found")
    db.add(LedgerEntry(student_id=body.student_id, amount=body.meals, reason="topup"))
    db.commit()
    return {"student_id": body.student_id, "balance": get_balance(db, body.student_id)}


@router.get("/manager/meal-counts")
def meal_counts(
    mess_id: int = Query(...),
    day: date | None = None,
    _: Student = Depends(require_manager),
    db: Session = Depends(get_db),
):
    """Live counts per meal period for one day. Feeds the manager's live cards."""
    day = day or datetime.now(IST).date()
    rows = db.execute(
        select(MealLog.meal_period, func.count())
        .where(MealLog.mess_id == mess_id, MealLog.meal_date == day)
        .group_by(MealLog.meal_period)
    ).all()
    counts = {period: 0 for period in MEAL_WINDOWS}
    for period, n in rows:
        counts[period] = n
    return {"mess_id": mess_id, "date": day, "counts": counts, "total": sum(counts.values())}


@router.get("/manager/meal-history")
def meal_history(
    mess_id: int = Query(...),
    start: date = Query(...),
    end: date = Query(...),
    _: Student = Depends(require_manager),
    db: Session = Depends(get_db),
):
    """Daily aggregates per meal period. This is the training data for the ML team."""
    if end < start:
        raise HTTPException(status_code=400, detail="end is before start")
    rows = db.execute(
        select(
            MealLog.meal_date,
            MealLog.meal_period,
            func.count().label("meals"),
        )
        .where(MealLog.mess_id == mess_id, MealLog.meal_date.between(start, end))
        .group_by(MealLog.meal_date, MealLog.meal_period)
        .order_by(MealLog.meal_date, MealLog.meal_period)
    ).all()
    return [
        {"date": r.meal_date, "meal_period": r.meal_period, "count": r.meals}
        for r in rows
    ]
