"""Loading, validation and cleaning. Nothing is silently dropped: every removal is counted."""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C

log = logging.getLogger(__name__)


class DataValidationError(ValueError):
    pass


def load_raw(path: str | Path) -> pd.DataFrame:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Dataset not found: {path}")
    if path.suffix.lower() == ".parquet":
        return pd.read_parquet(path)
    return pd.read_csv(path)


def standardize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
    rename = {a: c for a, c in C.COLUMN_ALIASES.items() if a in df.columns and c not in df.columns}
    return df.rename(columns=rename)


def _flag_outliers(df: pd.DataFrame) -> pd.Series:
    """Flag points far from a centred 15-day rolling median (robust to trends). Flag only, never delete."""
    def f(s: pd.Series) -> pd.Series:
        resid = s - s.rolling(15, center=True, min_periods=5).median()
        mad = resid.abs().median()
        if not mad or np.isnan(mad):
            return pd.Series(False, index=s.index)
        return resid.abs() > C.OUTLIER_MAD_MULT * 1.4826 * mad
    return df.groupby(C.KEYS, group_keys=False)[C.TARGET].apply(f).reindex(df.index).fillna(False)


def merge_calendar(df: pd.DataFrame, cal: pd.DataFrame) -> pd.DataFrame:
    """Optional calendar file: date, is_holiday, is_event. Overrides flags already in df."""
    cal = standardize_columns(cal)
    cal[C.DATE] = pd.to_datetime(cal[C.DATE], errors="coerce").dt.normalize()
    cols = [c for c in (C.HOLIDAY, C.EVENT) if c in cal.columns]
    cal = cal.dropna(subset=[C.DATE]).drop_duplicates(C.DATE, keep="last")[[C.DATE] + cols]
    df = df.drop(columns=[c for c in cols if c in df.columns]).merge(cal, on=C.DATE, how="left")
    return df


def clean(raw: pd.DataFrame, calendar: pd.DataFrame | None = None) -> tuple[pd.DataFrame, dict]:
    """Return (clean_df, quality_report). Raises DataValidationError if required columns are missing."""
    df = standardize_columns(raw)
    missing = [c for c in C.REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise DataValidationError(
            f"Missing required columns {missing}. Found: {list(df.columns)}. "
            f"Add aliases in config.COLUMN_ALIASES or rename the columns."
        )
    rep: dict = {
        "rows_raw": int(len(df)), "columns_raw": int(df.shape[1]), "columns": list(df.columns),
        "missing_values_raw": {k: int(v) for k, v in df.isna().sum().items()},
    }

    n = len(df)
    df = df.drop_duplicates()
    rep["exact_duplicate_rows_dropped"] = n - len(df)

    parsed = pd.to_datetime(df[C.DATE], errors="coerce")
    if getattr(parsed.dt, "tz", None) is not None:
        parsed = parsed.dt.tz_localize(None)
    bad = parsed.isna()
    rep["invalid_dates_dropped"] = int(bad.sum())
    df = df.loc[~bad].copy()
    df[C.DATE] = parsed[~bad].dt.normalize()

    for c in (C.MESS, C.MEAL):
        df[c] = df[c].astype("string").str.strip().str.lower()
    bad = df[C.MESS].isna() | df[C.MEAL].isna() | df[C.MESS].isin(["", "nan", "none"]) | df[C.MEAL].isin(["", "nan", "none"])
    rep["missing_mess_or_meal_dropped"] = int(bad.sum())
    df = df.loc[~bad].copy()
    df[[C.MESS, C.MEAL]] = df[[C.MESS, C.MEAL]].astype(str)

    coerced = 0
    for c in (C.TARGET, C.ACTIVE, C.LEAVE):
        if c in df.columns:
            before = df[c].isna().sum()
            df[c] = pd.to_numeric(df[c], errors="coerce")
            coerced += int(df[c].isna().sum() - before)
    rep["non_numeric_values_coerced_to_nan"] = coerced

    bad = df[C.TARGET].isna() | (df[C.TARGET] < 0)
    rep["missing_or_negative_target_dropped"] = int(bad.sum())
    df = df.loc[~bad].copy()

    n = len(df)
    dup_key = df.duplicated(C.KEYS + [C.DATE], keep=False)
    df = df.drop_duplicates(C.KEYS + [C.DATE], keep="last")
    rep["conflicting_key_rows_resolved_keep_last"] = int(n - len(df))

    if calendar is not None:
        df = merge_calendar(df, calendar)
    for c in (C.HOLIDAY, C.EVENT):  # absent flag == ordinary day (documented assumption)
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0).clip(0, 1).astype(int)

    df = df.sort_values(C.KEYS + [C.DATE]).reset_index(drop=True)
    if C.ACTIVE in df.columns:  # headcount is a slowly-changing state: carry forward within a mess
        df[C.ACTIVE] = df.groupby(C.KEYS)[C.ACTIVE].ffill()
    df["is_outlier"] = _flag_outliers(df)

    gaps = {}
    for key, g in df.groupby(C.KEYS):
        span = (g[C.DATE].max() - g[C.DATE].min()).days + 1
        gaps["/".join(key)] = int(span - len(g))
    rep.update(
        rows_clean=int(len(df)),
        rows_removed_total=rep["rows_raw"] - int(len(df)),
        date_min=str(df[C.DATE].min().date()) if len(df) else None,
        date_max=str(df[C.DATE].max().date()) if len(df) else None,
        n_messes=int(df[C.MESS].nunique()), n_meal_types=int(df[C.MEAL].nunique()),
        messes=sorted(df[C.MESS].unique().tolist()), meal_types=sorted(df[C.MEAL].unique().tolist()),
        missing_calendar_days_per_group=gaps,
        outliers_flagged_not_removed=int(df["is_outlier"].sum()),
        zero_target_rows=int((df[C.TARGET] == 0).sum()),
        target_distribution={k: float(v) for k, v in df[C.TARGET].describe().items()},
        optional_columns_present=[c for c in C.OPTIONAL_COLUMNS if c in df.columns],
        optional_columns_missing=[c for c in C.OPTIONAL_COLUMNS if c not in df.columns],
    )
    if rep["rows_raw"] and rep["rows_removed_total"] / rep["rows_raw"] > 0.05:
        log.warning("More than 5%% of rows removed during cleaning (%d of %d) - inspect the report.",
                    rep["rows_removed_total"], rep["rows_raw"])
    return df, rep


def format_report(rep: dict) -> str:
    d = rep["target_distribution"]
    lines = [
        "DATA QUALITY REPORT",
        f"  rows (raw -> clean): {rep['rows_raw']} -> {rep['rows_clean']}   columns: {rep['columns_raw']}",
        f"  date range: {rep['date_min']} .. {rep['date_max']}",
        f"  messes: {rep['n_messes']} {rep['messes']}   meal types: {rep['n_meal_types']} {rep['meal_types']}",
        f"  exact duplicates dropped: {rep['exact_duplicate_rows_dropped']}   conflicting-key rows resolved: {rep['conflicting_key_rows_resolved_keep_last']}",
        f"  invalid dates dropped: {rep['invalid_dates_dropped']}   missing/negative target dropped: {rep['missing_or_negative_target_dropped']}",
        f"  missing values (raw): { {k: v for k, v in rep['missing_values_raw'].items() if v} or 'none' }",
        f"  outliers flagged (kept): {rep['outliers_flagged_not_removed']}   zero-meal rows: {rep['zero_target_rows']}",
        f"  missing calendar days per mess/meal: {rep['missing_calendar_days_per_group']}",
        f"  target: mean={d['mean']:.1f} std={d['std']:.1f} min={d['min']:.0f} 50%={d['50%']:.0f} max={d['max']:.0f}",
        f"  optional columns present: {rep['optional_columns_present']}  missing: {rep['optional_columns_missing']}",
    ]
    return "\n".join(lines)
