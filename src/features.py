"""Leakage-safe feature engineering.

Rule: a feature for row (mess, meal, date D) may use
  * the target of days strictly BEFORE D (via shift(1) before any rolling window), and
  * covariates that are known before the meal on D (calendar, active students, approved leave).
It may never use the target of D or later.

Training and serving share this exact function: at prediction time a placeholder row (target = NaN)
is appended to the history and run through `build_features`, so there is no train/serve skew.

Feature rationale (kept deliberately small):
  lag_1/lag_2/lag_7       yesterday, day before, same weekday last week - strongest short-term signals
  roll_mean_3/7/14/30     smoothed recent level at several horizons; roll_std_7 = recent volatility
  momentum_7_30           short-vs-long level: captures trend (term start, exams, semester end)
  same_wd_mean_4          mean of the same weekday over the last 4 weeks (weekly seasonality)
  dow/is_weekend/month/day_of_month   calendar effects (weekend skipping, month-end homecoming)
  is_holiday/is_event     known-in-advance demand shocks (optional columns)
  active_students, approved_leave, present_students, leave_ratio   capacity for today (optional)
  part_rate_roll_7, rate_est   recent served/active ratio and ratio*active_students (optional)
  mess_code, meal_code    group identity so one model can serve all messes/meals
Not included on purpose: raw date/year (cannot extrapolate), long lags >30 days, anything built from
same-day served counts, per-student data.
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from . import config as C

log = logging.getLogger(__name__)

_FLAGS = (C.HOLIDAY, C.EVENT)


def _group_features(g: pd.DataFrame, optional: list[str]) -> pd.DataFrame:
    g = g.sort_values(C.DATE).set_index(C.DATE)
    g["_real"] = True
    full = pd.date_range(g.index.min(), g.index.max(), freq="D", name=C.DATE)
    g = g.reindex(full)  # missing calendar days become NaN so shifts mean "N calendar days ago"
    g["_real"] = g["_real"].fillna(False).astype(bool)
    g[[C.MESS, C.MEAL]] = g[[C.MESS, C.MEAL]].ffill().bfill()

    y = g[C.TARGET].astype(float)
    past = y.shift(1)  # everything below sees only data up to D-1
    out = pd.DataFrame(index=g.index)
    out[C.MESS], out[C.MEAL], out[C.TARGET], out["_real"] = g[C.MESS], g[C.MEAL], y, g["_real"]
    for c in optional:
        out[c] = g[c]

    out["lag_1"], out["lag_2"], out["lag_7"] = y.shift(1), y.shift(2), y.shift(7)
    for w in C.ROLL_WINDOWS:
        out[f"roll_mean_{w}"] = past.rolling(w, min_periods=max(1, w // 2)).mean()
    out["roll_std_7"] = past.rolling(7, min_periods=3).std()
    out["momentum_7_30"] = out["roll_mean_7"] - out["roll_mean_30"]
    same_wd = pd.concat([y.shift(7 * k) for k in range(1, C.SAME_WEEKDAY_WEEKS + 1)], axis=1)
    out["same_wd_mean_4"] = same_wd.mean(axis=1)

    idx = g.index
    out["dow"], out["is_weekend"] = idx.dayofweek, (idx.dayofweek >= 5).astype(int)
    out["month"], out["day_of_month"] = idx.month, idx.day

    if C.ACTIVE in optional:
        act = g[C.ACTIVE]
        rate = (y / act.replace(0, np.nan)).shift(1)
        out["part_rate_roll_7"] = rate.rolling(7, min_periods=3).mean()
        out["rate_est"] = out["part_rate_roll_7"] * act
        if C.LEAVE in optional:
            out["present_students"] = act - g[C.LEAVE]
            out["leave_ratio"] = g[C.LEAVE] / act.replace(0, np.nan)
    out = out.reset_index()
    return out[out["_real"]].drop(columns="_real")


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """df: cleaned data (see preprocessing.clean). Rows with NaN target are allowed (prediction placeholders)."""
    optional = [c for c in C.OPTIONAL_COLUMNS if c in df.columns]
    cols = [C.DATE, *C.KEYS, C.TARGET, *optional]
    parts = [_group_features(g[cols], optional) for _, g in df.groupby(C.KEYS, sort=False)]
    feat = pd.concat(parts, ignore_index=True)
    for c in _FLAGS:
        if c in feat.columns:
            feat[c] = feat[c].fillna(0).astype(int)
    return feat.sort_values([C.DATE, *C.KEYS]).reset_index(drop=True)


def make_category_maps(df: pd.DataFrame) -> dict[str, dict[str, int]]:
    return {c: {v: i for i, v in enumerate(sorted(df[c].unique()))} for c in C.KEYS}


def add_category_codes(feat: pd.DataFrame, maps: dict[str, dict[str, int]]) -> pd.DataFrame:
    feat = feat.copy()
    feat["mess_code"] = feat[C.MESS].map(maps[C.MESS]).fillna(-1).astype(int)
    feat["meal_code"] = feat[C.MEAL].map(maps[C.MEAL]).fillna(-1).astype(int)
    return feat


def feature_columns(feat: pd.DataFrame) -> list[str]:
    base = ["mess_code", "meal_code", "dow", "is_weekend", "month", "day_of_month",
            "lag_1", "lag_2", "lag_7", *[f"roll_mean_{w}" for w in C.ROLL_WINDOWS],
            "roll_std_7", "momentum_7_30", "same_wd_mean_4"]
    optional = [C.ACTIVE, C.LEAVE, "present_students", "leave_ratio", "part_rate_roll_7", "rate_est", *_FLAGS]
    return base + [c for c in optional if c in feat.columns]


def assert_no_leakage(df: pd.DataFrame, sentinel: float = 1e9) -> None:
    """Perturbation test: overwrite every target on/after date D with a huge value and rebuild.
    Features of all rows dated <= D must be unchanged; otherwise something peeks at the present/future."""
    dates = np.sort(df[C.DATE].unique())
    if len(dates) < 10:
        return
    base = build_features(df)
    cols = [c for c in feature_columns(add_category_codes(base, make_category_maps(df)))
            if c not in ("mess_code", "meal_code")]
    for q in (0.3, 0.5, 0.7):
        d = dates[int(len(dates) * q)]
        pert = df.copy()
        pert.loc[pert[C.DATE] >= d, C.TARGET] = sentinel
        other = build_features(pert)
        m = base[C.DATE] <= d
        a, b = base.loc[m, cols].to_numpy(float), other.loc[m, cols].to_numpy(float)
        if not np.allclose(a, b, equal_nan=True):
            bad = [c for i, c in enumerate(cols) if not np.allclose(a[:, i], b[:, i], equal_nan=True)]
            raise AssertionError(f"Target leakage detected in features: {bad}")
    log.info("Leakage check passed (%d features, 3 perturbation points).", len(cols))
