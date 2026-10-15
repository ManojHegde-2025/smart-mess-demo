"""Baselines XGBoost must beat. Both use only information available before the target day."""
from __future__ import annotations

import pandas as pd

from . import config as C

_FALLBACK_CHAIN = [f"roll_mean_{C.BASELINE_WINDOW}", "roll_mean_14", "roll_mean_30", "roll_mean_3", "lag_1"]


def moving_average(feat: pd.DataFrame) -> pd.Series:
    """7-day moving average of the previous 7 days for the same mess x meal (falls back to wider/narrower
    windows when the 7-day window is empty)."""
    pred = pd.Series(float("nan"), index=feat.index)
    for col in _FALLBACK_CHAIN:
        if col in feat.columns:
            pred = pred.fillna(feat[col])
    return pred


def seasonal_naive(feat: pd.DataFrame) -> pd.Series:
    """Same weekday last week."""
    return feat["lag_7"]
