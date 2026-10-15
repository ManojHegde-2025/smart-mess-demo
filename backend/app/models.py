from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Mess(Base):
    __tablename__ = "messes"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    # Stable string id used by the ML service and the dashboard, e.g. "south".
    code: Mapped[str | None] = mapped_column(String(32), unique=True)


class Student(Base):
    __tablename__ = "students"

    id: Mapped[int] = mapped_column(primary_key=True)
    roll_no: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16), default="student")  # student | manager
    mess_id: Mapped[int | None] = mapped_column(ForeignKey("messes.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Leave(Base):
    __tablename__ = "leaves"

    id: Mapped[int] = mapped_column(primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"), index=True)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16), default="approved")  # approved | cancelled
    reason: Mapped[str | None] = mapped_column(String(255))


class MealLog(Base):
    __tablename__ = "meal_logs"
    __table_args__ = (
        # Database-level duplicate prevention: one meal per student per period per day.
        UniqueConstraint("student_id", "meal_date", "meal_period", name="uq_one_meal_per_period"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"), index=True)
    mess_id: Mapped[int] = mapped_column(ForeignKey("messes.id"), index=True)
    meal_date: Mapped[date] = mapped_column(Date)
    meal_period: Mapped[str] = mapped_column(String(16))  # breakfast | lunch | dinner
    qr_window: Mapped[int] = mapped_column(Integer)  # QR rotation window that was scanned
    scanned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class LedgerEntry(Base):
    """Append-only balance ledger. Balance = SUM(amount). Credits positive, debits negative."""

    __tablename__ = "ledger_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"), index=True)
    amount: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(32))  # topup | meal | adjustment
    meal_log_id: Mapped[int | None] = mapped_column(ForeignKey("meal_logs.id"), unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ScanAttempt(Base):
    """Every scan decision, allowed or rejected. Feeds the exceptions list and reports."""

    __tablename__ = "scan_attempts"

    id: Mapped[int] = mapped_column(primary_key=True)
    mess_id: Mapped[int | None] = mapped_column(ForeignKey("messes.id"), index=True)
    student_ref: Mapped[str | None] = mapped_column(String(16))  # pseudonymous, never the roll number
    meal_period: Mapped[str | None] = mapped_column(String(16))
    code: Mapped[str] = mapped_column(String(32))
    allowed: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class PreparedCount(Base):
    """How many meals the kitchen cooked for a mess, date and meal. Entered by the manager."""

    __tablename__ = "prepared_counts"
    __table_args__ = (
        UniqueConstraint("mess_id", "meal_date", "meal_period", name="uq_prepared_per_meal"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    mess_id: Mapped[int] = mapped_column(ForeignKey("messes.id"))
    meal_date: Mapped[date] = mapped_column(Date)
    meal_period: Mapped[str] = mapped_column(String(16))
    prepared_count: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Forecast(Base):
    """A forecast returned by the ML service, stored so it can later be compared with actuals."""

    __tablename__ = "forecasts"

    id: Mapped[int] = mapped_column(primary_key=True)
    mess_id: Mapped[int] = mapped_column(ForeignKey("messes.id"), index=True)
    target_date: Mapped[date] = mapped_column(Date, index=True)
    meal_period: Mapped[str] = mapped_column(String(16))
    predicted_meals: Mapped[int] = mapped_column(Integer)
    recommended_preparation: Mapped[int | None] = mapped_column(Integer)
    range_low: Mapped[int | None] = mapped_column(Integer)
    range_high: Mapped[int | None] = mapped_column(Integer)
    model_version: Mapped[str | None] = mapped_column(String(32))
    method: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ForecastEvaluation(Base):
    """Forecast error once the actual served count is known (written by the nightly job)."""

    __tablename__ = "forecast_evaluations"

    id: Mapped[int] = mapped_column(primary_key=True)
    forecast_id: Mapped[int] = mapped_column(ForeignKey("forecasts.id"), unique=True)
    actual_count: Mapped[int] = mapped_column(Integer)
    absolute_error: Mapped[float] = mapped_column(Float)
    squared_error: Mapped[float] = mapped_column(Float)
    signed_error: Mapped[float] = mapped_column(Float)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
