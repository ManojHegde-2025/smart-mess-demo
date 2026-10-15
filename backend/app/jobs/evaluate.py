"""Nightly feedback job: compare stored forecasts with actual served counts.

    python -m app.jobs.evaluate              # evaluate every finished, not-yet-evaluated forecast
    python -m app.jobs.evaluate --dry-run    # show what would be sent, change nothing

Sends (forecast, actual) pairs to the ML service's /evaluate-forecasts and stores the returned errors.
"""
import argparse
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from app.database import SessionLocal
from app.ml_client import evaluate_pairs
from app.models import Forecast, ForecastEvaluation, MealLog

IST = ZoneInfo("Asia/Kolkata")
log = logging.getLogger("evaluate")


def run(dry_run: bool = False) -> dict:
    db = SessionLocal()
    try:
        today = datetime.now(IST).date()
        evaluated_ids = select(ForecastEvaluation.forecast_id)
        forecasts = db.scalars(
            select(Forecast)
            .where(Forecast.target_date < today, Forecast.id.not_in(evaluated_ids))
            .order_by(Forecast.id)
        ).all()

        pairs = []
        for f in forecasts:
            actual = db.scalar(
                select(func.count()).select_from(MealLog).where(
                    MealLog.mess_id == f.mess_id,
                    MealLog.meal_date == f.target_date,
                    MealLog.meal_period == f.meal_period,
                )
            )
            if actual:
                pairs.append({"forecast_id": str(f.id), "predicted_count": f.predicted_meals, "actual_count": actual})

        if not pairs:
            return {"sent": 0, "stored": 0, "note": "nothing to evaluate"}
        if dry_run:
            return {"sent": len(pairs), "stored": 0, "dry_run": True, "sample": pairs[:3]}

        result = evaluate_pairs(pairs)
        stored = 0
        for row in result.get("rows", []):
            fid = int(row["forecast_id"])
            db.add(
                ForecastEvaluation(
                    forecast_id=fid,
                    actual_count=int(row["actual_count"]),
                    absolute_error=float(row["absolute_error"]),
                    squared_error=float(row["squared_error"]),
                    signed_error=float(row["signed_error"]),
                )
            )
            stored += 1
        db.commit()
        return {"sent": len(pairs), "stored": stored, "summary": result.get("summary")}
    finally:
        db.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(run(dry_run=args.dry_run))
