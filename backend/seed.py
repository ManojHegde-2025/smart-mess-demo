"""Create the two messes, a manager and a test student for local development.

Run from the project root after migrations:  python seed.py
Safe to run more than once.
"""
from sqlalchemy import select

from app import models  # noqa: F401
from app.database import SessionLocal
from app.models import LedgerEntry, Mess, Student
from app.security import hash_password

PASSWORD = "password123"
MESSES = [(1, "South Mess", "south"), (2, "North Mess", "north")]


def main() -> None:
    db = SessionLocal()
    for mess_id, name, code in MESSES:
        mess = db.get(Mess, mess_id)
        if mess is None:
            db.add(Mess(id=mess_id, name=name, code=code))
        else:
            mess.name, mess.code = name, code
    db.flush()

    if db.scalar(select(Student).where(Student.roll_no == "MGR001")) is None:
        db.add(Student(roll_no="MGR001", name="Mess Manager", role="manager",
                       password_hash=hash_password(PASSWORD), mess_id=1))

    if db.scalar(select(Student).where(Student.roll_no == "STU001")) is None:
        student = Student(roll_no="STU001", name="Test Student", role="student",
                          password_hash=hash_password(PASSWORD), mess_id=1)
        db.add(student)
        db.flush()
        db.add(LedgerEntry(student_id=student.id, amount=30, reason="topup"))

    db.commit()
    db.close()
    print(f"Seeded messes south/north. Logins: STU001 (student), MGR001 (manager). Password: {PASSWORD}")


if __name__ == "__main__":
    main()
