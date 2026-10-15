"""Feedback loop: compare stored forecasts with actual served counts."""
from __future__ import annotations

import pandas as pd


def evaluate_forecasts(df: pd.DataFrame) -> pd.DataFrame:
    """df needs predicted_count and actual_count. Adds absolute_error / squared_error / signed_error
    (matches the forecast_evaluations table in the PRD)."""
    out = df.copy()
    err = out["predicted_count"].astype(float) - out["actual_count"].astype(float)
    out["signed_error"], out["absolute_error"], out["squared_error"] = err, err.abs(), err ** 2
    return out


def summarize(evals: pd.DataFrame, reference_mae: float | None = None, drift_factor: float = 1.5) -> dict:
    mae = float(evals["absolute_error"].mean())
    rmse = float(evals["squared_error"].mean() ** 0.5)
    out = {"n": int(len(evals)), "mae": mae, "rmse": rmse, "bias": float(evals["signed_error"].mean())}
    if reference_mae:
        out["reference_test_mae"] = reference_mae
        out["retrain_recommended"] = bool(len(evals) >= 14 and mae > drift_factor * reference_mae)
    return out
