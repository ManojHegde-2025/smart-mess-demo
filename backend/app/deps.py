from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWTError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Student
from app.security import decode_access_token

bearer = HTTPBearer(auto_error=False)


def current_student(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> Student:
    if creds is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_access_token(creds.credentials)
    except PyJWTError:
        raise HTTPException(status_code=401, detail="Session expired or invalid")

    student = db.get(Student, int(payload["sub"]))
    if student is None or not student.is_active:
        raise HTTPException(status_code=401, detail="Account not found or inactive")
    return student


def require_manager(student: Student = Depends(current_student)) -> Student:
    if student.role != "manager":
        raise HTTPException(status_code=403, detail="Managers only")
    return student
