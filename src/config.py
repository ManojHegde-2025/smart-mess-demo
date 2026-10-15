"""Central configuration. Everything tunable lives here or in environment variables."""
from __future__ import annotations

import logging
import os
from pathlib import Path

ROOT = Path(os.getenv("ML_ROOT", Path(__file__).resolve().parents[1]))
DATA_RAW_DIR = Path(os.getenv("ML_DATA_RAW_DIR", ROOT / "data" / "raw"))
DATA_PROCESSED_DIR = Path(os.getenv("ML_DATA_PROCESSED_DIR", ROOT / "data" / "processed"))
MODELS_DIR = Path(os.getenv("ML_MODELS_DIR", ROOT / "models"))
REPORTS_DIR = Path(os.getenv("ML_REPORTS_DIR", ROOT / "reports"))

# ---- Column names (rename here if your dataset differs) -------------------
DATE, MESS, MEAL, TARGET = "date", "mess_id", "meal_type", "served_meals"
ACTIVE, LEAVE = "active_students", "approved_leave"
HOLIDAY, EVENT = "is_holiday", "is_event"

REQUIRED_COLUMNS = [DATE, MESS, MEAL, TARGET]
OPTIONAL_COLUMNS = [ACTIVE, LEAVE, HOLIDAY, EVENT]
KEYS = [MESS, MEAL]

# Accepted alternative column names -> canonical name (e.g. PRD's mess_usage.served_count)
COLUMN_ALIASES = {
    "served_count": TARGET, "served": TARGET, "meals_served": TARGET,
    "mess": MESS, "mess_name": MESS, "meal": MEAL, "meal_period": MEAL,
    "dt": DATE, "target_date": DATE,
    "active_count": ACTIVE, "active_student_count": ACTIVE,
    "leave_count": LEAVE, "approved_leaves": LEAVE,
    "holiday": HOLIDAY, "event": EVENT, "college_event": EVENT, "is_college_event": EVENT,
}

# ---- Business rules --------------------------------------------------------
SAFETY_BUFFER = float(os.getenv("SAFETY_BUFFER", "0.02"))  # 2 % extra on top of the forecast
# Optional cold-start rule when a mess has NO history at all: served = rate * active_students.
# Left unset on purpose: it is a business assumption, not something the ML should invent.
_rate = os.getenv("DEFAULT_PARTICIPATION_RATE")
DEFAULT_PARTICIPATION_RATE = float(_rate) if _rate else None

# ---- Feature engineering ---------------------------------------------------
ROLL_WINDOWS = (3, 7, 14, 30)
SAME_WEEKDAY_WEEKS = 4
BASELINE_WINDOW = 7
OUTLIER_MAD_MULT = float(os.getenv("OUTLIER_MAD_MULT", "6"))

# ---- Training --------------------------------------------------------------
SEED = 42
VAL_FRAC, TEST_FRAC = 0.15, 0.15          # chronological, by unique date
MIN_TRAIN_DAYS = int(os.getenv("MIN_TRAIN_DAYS", "90"))   # below this: baseline only
MIN_HISTORY_DAYS = int(os.getenv("MIN_HISTORY_DAYS", "14"))  # per mess x meal at predict time
CV_MIN_DAYS = 180
XGB_OBJECTIVE = os.getenv("XGB_OBJECTIVE", "reg:squarederror")
XGB_PARAMS = dict(
    n_estimators=1000, learning_rate=0.05, max_depth=4, min_child_weight=5,
    subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0, tree_method="hist",
)
EARLY_STOPPING_ROUNDS = 50
# If XGBoost does not beat the baseline on the untouched test set, serve the baseline.
REQUIRE_XGB_BEATS_BASELINE = os.getenv("REQUIRE_XGB_BEATS_BASELINE", "1") == "1"

# ---- Serving ---------------------------------------------------------------
HISTORY_SOURCE = os.getenv("HISTORY_SOURCE", "csv")  # csv | postgres
HISTORY_CSV = os.getenv("HISTORY_CSV", str(DATA_RAW_DIR / "meal_history.csv"))
CALENDAR_CSV = os.getenv("CALENDAR_CSV", "")
HISTORY_SQL = os.getenv(
    "HISTORY_SQL",
    "SELECT mess_id, date, meal_type, served_count AS served_meals "
    "FROM mess_usage WHERE served_count IS NOT NULL",
)
HISTORY_CACHE_SECONDS = int(os.getenv("HISTORY_CACHE_SECONDS", "300"))


def setup_logging(level: str | None = None) -> None:
    logging.basicConfig(
        level=getattr(logging, (level or os.getenv("LOG_LEVEL", "INFO")).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
