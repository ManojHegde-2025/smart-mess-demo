"""FastAPI service. Run from the ml/ folder:  uvicorn api.app:app --port 8000"""
from __future__ import annotations

import logging
import os
from typing import Optional

import pandas as pd
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from src import config as C
from src.feedback import evaluate_forecasts, summarize
from src.history import get_history_provider
from src.predict import InsufficientHistoryError, load_latest, predict_meals
from src.train import run_training

C.setup_logging()
log = logging.getLogger("api")
app = FastAPI(title="Smart Mess ML service", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "").split(",") if os.getenv("CORS_ORIGINS") else [],
                   allow_methods=["*"], allow_headers=["*"])
_state = {"bundle": load_latest(), "history": get_history_provider()}


def require_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    key = os.getenv("ML_API_KEY")  # if unset (local dev) the service is open
    if key and x_api_key != key:
        raise HTTPException(401, "invalid API key")


class PredictRequest(BaseModel):
    mess_id: str
    date: str = Field(description="YYYY-MM-DD")
    meal_type: str
    active_students: Optional[int] = Field(default=None, ge=0)
    approved_leave: Optional[int] = Field(default=None, ge=0)
    is_holiday: Optional[int] = Field(default=None, ge=0, le=1)
    is_event: Optional[int] = Field(default=None, ge=0, le=1)
    safety_buffer: Optional[float] = Field(default=None, ge=0, le=0.5, description="overrides the server default")


class ForecastActual(BaseModel):
    forecast_id: str
    predicted_count: float
    actual_count: float


@app.get("/health")
def health():
    b = _state["bundle"]
    return {"status": "ok", "model_loaded": b is not None, "model_version": b.version if b else None,
            "mode": b.meta.get("mode") if b else "baseline_only_no_model"}


@app.get("/model-info", dependencies=[Depends(require_key)])
def model_info():
    b = _state["bundle"]
    if b is None:
        return {"model_version": None, "mode": "baseline_only_no_model", "note": "No model trained yet; /predict uses the 7-day average."}
    m = b.meta
    return {k: m.get(k) for k in ("version", "mode", "mode_reason", "trained_at", "data_label", "date_min", "date_max",
                                   "n_days", "feature_columns", "metrics", "cv", "default_safety_buffer")}


@app.post("/predict", dependencies=[Depends(require_key)])
def predict(req: PredictRequest):
    try:
        return predict_meals(req.model_dump(exclude={"safety_buffer"}), history=_state["history"].load(),
                             bundle=_state["bundle"], safety_buffer=req.safety_buffer)
    except InsufficientHistoryError as e:
        raise HTTPException(422, str(e))
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(503, f"history source unavailable: {e}")


@app.post("/evaluate-forecasts", dependencies=[Depends(require_key)])
def evaluate(items: list[ForecastActual]):
    """Next.js sends (forecast, actual) pairs; returns per-row errors for the forecast_evaluations table + summary."""
    if not items:
        raise HTTPException(400, "empty list")
    df = evaluate_forecasts(pd.DataFrame([i.model_dump() for i in items]))
    b = _state["bundle"]
    ref = ((b.meta.get("metrics") or {}).get("test", {}).get("XGBoost", {}) or {}).get("mae") if b else None
    return {"rows": df.to_dict("records"), "summary": summarize(df, ref)}


@app.post("/retrain", dependencies=[Depends(require_key)])
def retrain(tune: bool = False):
    """Retrain from the configured history source and hot-swap the new model. Synchronous; fine for hackathon-size data."""
    _state["history"].invalidate()
    meta = run_training(_state["history"].load(), tune=tune, data_label=os.getenv("DATA_LABEL", "real"))
    _state["bundle"] = load_latest()
    return {"version": meta["version"], "mode": meta["mode"], "reason": meta["mode_reason"]}
