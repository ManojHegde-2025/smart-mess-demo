"""Resolve a mess from whatever the caller sends: numeric id, code ('south'), or name ('South Mess')."""
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Mess

MEAL_PERIODS = ("breakfast", "lunch", "dinner")


def resolve_mess(db: Session, ref: str) -> Mess:
    value = (ref or "").strip()
    if value.isdigit():
        mess = db.get(Mess, int(value))
    else:
        code = value.lower().removesuffix(" mess").strip().replace(" ", "_").replace("-", "_")
        mess = db.scalar(select(Mess).where(Mess.code == code))
        if mess is None:
            mess = db.scalar(select(Mess).where(func.lower(Mess.name) == value.lower()))
    if mess is None:
        raise HTTPException(status_code=404, detail=f"Unknown mess '{ref}'")
    return mess


def normalize_meal(value: str) -> str:
    meal = (value or "").strip().lower()
    if meal not in MEAL_PERIODS:
        raise HTTPException(status_code=400, detail=f"meal must be one of {', '.join(MEAL_PERIODS)}")
    return meal
