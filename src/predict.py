"""Prediction with model versioning and cold-start fallback.

predict_meals({...}) -> dict. Uses the same feature code as training (placeholder row trick)."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
import xgboost as xgb

from . import config as C
from . import baseline as B
from .features import add_category_codes, build_features
from .preprocessing import clean, merge_calendar, standardize_columns

log = logging.getLogger(__name__)
BASELINE_VERSION = "baseline_ma7"


class InsufficientHistoryError(ValueError):
    pass


@dataclass
class ModelBundle:
    version: str
    meta: dict
    model: xgb.XGBRegressor | None

    @classmethod
    def load(cls, model_dir: Path) -> "ModelBundle":
        meta = json.loads((Path(model_dir) / "metadata.json").read_text())
        model = None
        if (Path(model_dir) / "model.json").exists():
            model = xgb.XGBRegressor()
            model.load_model(Path(model_dir) / "model.json")
        return cls(meta["version"], meta, model)


def load_latest(models_dir: Path = C.MODELS_DIR) -> ModelBundle | None:
    models_dir = Path(models_dir)
    ptr = models_dir / "LATEST"
    if not ptr.exists():
        return None
    return ModelBundle.load(models_dir / ptr.read_text().strip())


def _apply_buffer(pred: float, buffer: float) -> int:
    return int(round(round(pred * (1 + buffer), 6)))


def predict_meals(input_data: dict, history: pd.DataFrame | None = None, bundle: ModelBundle | None = None,
                  safety_buffer: float | None = None, calendar: pd.DataFrame | None = None) -> dict:
    """input_data: mess_id, date, meal_type (required); active_students, approved_leave, is_holiday, is_event (optional).
    history: raw or cleaned history; if None it is loaded through the configured provider."""
    for k in ("mess_id", "date", "meal_type"):
        if input_data.get(k) in (None, ""):
            raise ValueError(f"'{k}' is required")
    buffer = C.SAFETY_BUFFER if safety_buffer is None else safety_buffer
    mess, meal = str(input_data["mess_id"]).strip().lower(), str(input_data["meal_type"]).strip().lower()
    target_date = pd.Timestamp(input_data["date"]).normalize()
    warnings: list[str] = []

    if history is None:
        from .history import get_history_provider
        history = get_history_provider().load()
    hist, _ = clean(history, calendar)
    hist = hist[(hist[C.MESS] == mess) & (hist[C.MEAL] == meal) & (hist[C.DATE] < target_date)]
    n_hist = int(hist[C.DATE].nunique())
    if n_hist == 0:
        if C.DEFAULT_PARTICIPATION_RATE is not None and input_data.get("active_students"):
            pred = C.DEFAULT_PARTICIPATION_RATE * float(input_data["active_students"])
            return _result(input_data, mess, meal, target_date, pred, None, buffer,
                           BASELINE_VERSION, "headcount_rate_fallback", ["no history; using DEFAULT_PARTICIPATION_RATE"])
        raise InsufficientHistoryError(f"No history for mess='{mess}' meal='{meal}' before {target_date.date()}")
    if (target_date - hist[C.DATE].max()).days > 1:
        warnings.append(f"latest actual is {hist[C.DATE].max().date()}; forecast is >1 day ahead of known data")

    # placeholder row for the target day: target unknown (NaN), covariates as supplied
    row = {C.DATE: target_date, C.MESS: mess, C.MEAL: meal, C.TARGET: float("nan")}
    for col, key in ((C.ACTIVE, "active_students"), (C.LEAVE, "approved_leave"), (C.HOLIDAY, "is_holiday"), (C.EVENT, "is_event")):
        if col in hist.columns:
            v = input_data.get(key)
            row[col] = v if v is not None else (hist[col].iloc[-1] if col == C.ACTIVE else (0 if col in (C.HOLIDAY, C.EVENT) else float("nan")))
    base_cols = [c for c in hist.columns if c in (C.DATE, *C.KEYS, C.TARGET, *C.OPTIONAL_COLUMNS)]
    frame = pd.concat([hist[base_cols], pd.DataFrame([row])], ignore_index=True)
    feat = build_features(frame)
    feat = feat[feat[C.DATE] == target_date]
    maps = bundle.meta["category_maps"] if bundle else {C.MESS: {}, C.MEAL: {}}
    feat = add_category_codes(feat, maps) if bundle else feat
    base_pred = float(B.moving_average(feat).iloc[0])
    if pd.isna(base_pred):  # history exists but is older than every rolling window
        base_pred = float(hist.sort_values(C.DATE)[C.TARGET].tail(C.BASELINE_WINDOW).mean())
        warnings.append("history is stale (no data in the last 30 days); using the mean of the last 7 known days")

    use_xgb = (bundle is not None and bundle.model is not None and bundle.meta.get("mode") == "xgboost"
               and n_hist >= C.MIN_HISTORY_DAYS and feat["mess_code"].iloc[0] >= 0 and feat["meal_code"].iloc[0] >= 0)
    if bundle is not None and bundle.meta.get("mode") == "baseline":
        warnings.append(f"model {bundle.version} is baseline-only: {bundle.meta.get('mode_reason')}")
    elif bundle is not None and not use_xgb:
        warnings.append(f"only {n_hist} days of history for this mess/meal (or unseen mess) - using baseline")
    if bundle is not None and "synthetic" in str(bundle.meta.get("data_label", "")).lower():
        warnings.append("model was trained on SYNTHETIC data")

    if use_xgb:
        cols = bundle.meta["feature_columns"]
        X = feat.reindex(columns=cols)  # missing optional inputs become NaN, which XGBoost handles
        pred = float(bundle.model.predict(X)[0])
        if pd.isna(pred):
            pred = base_pred
        q = bundle.meta.get("residual_quantiles")
        rng = (pred + q["q10"], pred + q["q90"]) if q else None
        version, method = bundle.version, "xgboost"
    else:
        pred, rng = base_pred, None
        version, method = (bundle.version if bundle else BASELINE_VERSION), "moving_average_7"
    pred = max(pred, 0.0)
    if input_data.get("active_students") and pred > float(input_data["active_students"]):
        warnings.append("prediction exceeds active_students; check inputs")
    return _result(input_data, mess, meal, target_date, pred, rng, buffer, version, method, warnings)


def _result(inp, mess, meal, d, pred, rng, buffer, version, method, warnings) -> dict:
    out = {"mess": inp["mess_id"], "mess_id": mess, "date": str(d.date()), "meal_type": meal,
           "predicted_meals": int(round(pred)), "recommended_preparation": _apply_buffer(pred, buffer),
           "safety_buffer": buffer, "model_version": version, "method": method, "warnings": warnings}
    if rng:
        out["prediction_range"] = {"low": max(0, int(round(rng[0]))), "high": int(round(rng[1])), "coverage": "~80% (validation residuals)"}
    return out


if __name__ == "__main__":
    import argparse
    C.setup_logging()
    ap = argparse.ArgumentParser()
    ap.add_argument("json_input", help='{"mess_id":"south","date":"2026-10-15","meal_type":"lunch"}')
    a = ap.parse_args()
    print(json.dumps(predict_meals(json.loads(a.json_input), bundle=load_latest()), indent=2))
