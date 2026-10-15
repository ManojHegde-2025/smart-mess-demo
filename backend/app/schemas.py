from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginIn(BaseModel):
    roll_no: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=128)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str


class StudentOut(BaseModel):
    id: int
    roll_no: str
    name: str
    role: str
    mess_id: int | None
    balance: int


class ScanIn(BaseModel):
    qr_token: str = Field(min_length=1, max_length=256)


class ScanOut(BaseModel):
    allowed: bool
    code: str
    message: str
    meal_period: str | None = None
    meal_log_id: int | None = None
    balance: int | None = None


class MealOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    meal_date: date
    meal_period: str
    mess_id: int
    scanned_at: datetime


class LeaveIn(BaseModel):
    student_id: int
    start_date: date
    end_date: date
    reason: str | None = Field(default=None, max_length=255)


class TopupIn(BaseModel):
    student_id: int
    meals: int = Field(gt=0, le=500)
