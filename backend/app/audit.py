"""Records every scan decision so rejected scans can be listed as exceptions."""
import hashlib
import logging

from sqlalchemy.orm import Session

from app.config import settings
from app.models import ScanAttempt, Student
from app.scan_service import ScanOutcome

log = logging.getLogger("audit")


def student_ref(student_id: int) -> str:
    """Pseudonymous reference. Not reversible without the server secret, never the roll number."""
    digest = hashlib.sha256(f"{settings.jwt_secret}:{student_id}".encode()).hexdigest()
    return f"S-{digest[:8].upper()}"


def record_attempt(db: Session, student: Student, outcome: ScanOutcome) -> None:
    """Best effort: a logging failure must never change the scan result the student sees."""
    try:
        db.add(
            ScanAttempt(
                mess_id=student.mess_id,
                student_ref=student_ref(student.id),
                meal_period=outcome.meal_period,
                code=outcome.code,
                allowed=outcome.allowed,
            )
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        log.exception("could not record scan attempt")
