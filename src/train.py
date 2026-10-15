"""Reproducible training: clean -> features -> leakage check -> chronological split -> baseline vs XGBoost
-> save versioned bundle + report. Run: python -m src.train --data data/raw/meal_history.csv"""
from __future__ import annotations

import argparse
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

from . import config as C
from . import baseline as B
from .evaluate import (comparison_markdown, compute_metrics, make_plots, manager_summary, shap_plot)
from .features import (add_category_codes, assert_no_leakage, build_features, feature_columns, make_category_maps)
from .preprocessing import clean, format_report, load_raw

log = logging.getLogger(__name__)


def next_version(models_dir: Path) -> str:
    nums = [int(m.group(1)) for p in models_dir.glob("xgb_v*") if (m := re.fullmatch(r"xgb_v(\d+)", p.name))]
    return f"xgb_v{max(nums, default=0) + 1}"


def chronological_split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    dates = np.sort(df[C.DATE].unique())
    n = len(dates)
    d_val, d_test = dates[int(n * (1 - C.VAL_FRAC - C.TEST_FRAC))], dates[int(n * (1 - C.TEST_FRAC))]
    return (df[df[C.DATE] < d_val], df[(df[C.DATE] >= d_val) & (df[C.DATE] < d_test)], df[df[C.DATE] >= d_test])


def _model(params: dict, early: bool) -> xgb.XGBRegressor:
    p = dict(C.XGB_PARAMS, **params)
    return xgb.XGBRegressor(objective=C.XGB_OBJECTIVE, eval_metric="mae", random_state=C.SEED, n_jobs=-1,
                            early_stopping_rounds=C.EARLY_STOPPING_ROUNDS if early else None, **p)


def _tune(train: pd.DataFrame, feats: list[str], n_iter: int = 15) -> dict:
    """Small random search, time-ordered CV on TRAIN ONLY (validation/test stay untouched)."""
    from sklearn.model_selection import RandomizedSearchCV, TimeSeriesSplit
    train = train.sort_values(C.DATE)
    space = dict(max_depth=[3, 4, 5, 6], min_child_weight=[1, 3, 5, 10], subsample=[0.6, 0.8, 1.0],
                 colsample_bytree=[0.6, 0.8, 1.0], learning_rate=[0.03, 0.05, 0.1], reg_lambda=[1, 5, 10])
    base = xgb.XGBRegressor(objective=C.XGB_OBJECTIVE, n_estimators=300, tree_method="hist",
                            random_state=C.SEED, n_jobs=-1)
    s = RandomizedSearchCV(base, space, n_iter=n_iter, cv=TimeSeriesSplit(3),
                           scoring="neg_mean_absolute_error", random_state=C.SEED)
    s.fit(train[feats], train[C.TARGET])
    log.info("Tuning best params: %s (CV MAE %.2f)", s.best_params_, -s.best_score_)
    return s.best_params_


def _time_cv(sup: pd.DataFrame, feats: list[str], params: dict, n_iter: int, n_splits: int = 4) -> list[dict]:
    """Expanding-window CV over unique dates: train on chunks[:i+1], test on chunk i+1."""
    chunks = np.array_split(np.sort(sup[C.DATE].unique()), n_splits + 1)
    out = []
    for i in range(n_splits):
        tr = sup[sup[C.DATE] <= chunks[i][-1]]
        te = sup[(sup[C.DATE] >= chunks[i + 1][0]) & (sup[C.DATE] <= chunks[i + 1][-1])]
        m = _model(dict(params, n_estimators=n_iter), early=False).fit(tr[feats], tr[C.TARGET])
        out.append({"fold": i + 1, "test_from": str(chunks[i + 1][0])[:10], "n_test": int(len(te)),
                    "xgb_mae": compute_metrics(te[C.TARGET], m.predict(te[feats]))["mae"],
                    "baseline_mae": compute_metrics(te[C.TARGET], B.moving_average(te))["mae"]})
    return out


def _jsonable(o):
    if isinstance(o, (np.integer,)): return int(o)
    if isinstance(o, (np.floating,)): return float(o)
    if isinstance(o, (np.ndarray,)): return o.tolist()
    raise TypeError(type(o))


def run_training(raw: pd.DataFrame, *, calendar: pd.DataFrame | None = None, tune: bool = False,
                 out_root: Path = C.MODELS_DIR, reports_root: Path = C.REPORTS_DIR,
                 data_label: str = "unspecified", version: str | None = None, run_cv: bool = True) -> dict:
    out_root, reports_root = Path(out_root), Path(reports_root)
    out_root.mkdir(parents=True, exist_ok=True)
    version = version or next_version(out_root)
    model_dir, report_dir = out_root / version, reports_root / version
    model_dir.mkdir(parents=True, exist_ok=True); report_dir.mkdir(parents=True, exist_ok=True)

    df, quality = clean(raw, calendar)
    log.info("\n%s", format_report(quality))
    (report_dir / "data_quality.json").write_text(json.dumps(quality, indent=2, default=_jsonable))

    assert_no_leakage(df)
    maps = make_category_maps(df)
    feat = add_category_codes(build_features(df), maps)
    feats = feature_columns(feat)
    sup = feat.dropna(subset=[C.TARGET, "roll_mean_7"]).copy()  # first days of each series have no history
    n_days = int(df[C.DATE].nunique())
    meta = {"version": version, "trained_at": datetime.now(timezone.utc).isoformat(), "data_label": data_label,
            "feature_columns": feats, "category_maps": maps, "n_days": n_days, "n_supervised_rows": int(len(sup)),
            "date_min": quality["date_min"], "date_max": quality["date_max"],
            "default_safety_buffer": C.SAFETY_BUFFER, "objective": C.XGB_OBJECTIVE,
            "optional_columns_used": quality["optional_columns_present"]}

    def finish(mode: str, reason: str, extra: dict | None = None) -> dict:
        meta.update(mode=mode, mode_reason=reason, **(extra or {}))
        (model_dir / "metadata.json").write_text(json.dumps(meta, indent=2, default=_jsonable))
        (out_root / "LATEST").write_text(version)
        log.info("Saved %s (mode=%s): %s", version, mode, reason)
        return meta

    if n_days < C.MIN_TRAIN_DAYS or len(sup) < 200:
        return finish("baseline", f"cold start: only {n_days} days / {len(sup)} usable rows "
                      f"(need >= {C.MIN_TRAIN_DAYS} days). Serving the 7-day moving average; XGBoost not trained.")

    train, val, test = chronological_split(sup)
    log.info("Split by date  train: %s..%s (%d rows) | val: %s..%s (%d) | test: %s..%s (%d)",
             train[C.DATE].min().date(), train[C.DATE].max().date(), len(train),
             val[C.DATE].min().date(), val[C.DATE].max().date(), len(val),
             test[C.DATE].min().date(), test[C.DATE].max().date(), len(test))

    params = _tune(train, feats) if tune else {}
    model = _model(params, early=True).fit(train[feats], train[C.TARGET],
                                           eval_set=[(val[feats], val[C.TARGET])], verbose=False)
    best_n = int(model.best_iteration) + 1
    log.info("Early stopping: best_iteration=%d", best_n)

    val_pred, test_pred = model.predict(val[feats]), model.predict(test[feats])
    results = {
        "val": {"7-Day Average": compute_metrics(val[C.TARGET], B.moving_average(val)),
                "Seasonal naive (lag 7)": compute_metrics(val[C.TARGET].loc[val["lag_7"].notna()], val["lag_7"].dropna()),
                "XGBoost": compute_metrics(val[C.TARGET], val_pred)},
        "test": {"7-Day Average": compute_metrics(test[C.TARGET], B.moving_average(test)),
                 "Seasonal naive (lag 7)": compute_metrics(test[C.TARGET].loc[test["lag_7"].notna()], test["lag_7"].dropna()),
                 "XGBoost": compute_metrics(test[C.TARGET], test_pred)},
    }
    cv = _time_cv(sup, feats, params, best_n) if run_cv and n_days >= C.CV_MIN_DAYS else None

    xg, bl = results["test"]["XGBoost"], results["test"]["7-Day Average"]
    beats = xg["mae"] < bl["mae"]
    mode = "xgboost" if (beats or not C.REQUIRE_XGB_BEATS_BASELINE) else "baseline"
    reason = (f"XGBoost test MAE {xg['mae']:.2f} vs 7-day average {bl['mae']:.2f}" +
              ("" if beats else " - XGBoost did not beat the baseline; serving the baseline."))

    # prediction range from validation residuals (empirical 80% interval, honest about its limits)
    resid = val[C.TARGET].to_numpy() - val_pred
    q = {"q10": float(np.quantile(resid, 0.10)), "q90": float(np.quantile(resid, 0.90))}

    # production model: same hyper-parameters & iteration count, refit on ALL data (train+val+test)
    final = _model(dict(params, n_estimators=best_n), early=False).fit(sup[feats], sup[C.TARGET])
    final.save_model(model_dir / "model.json")

    pred_df = test[[C.DATE, *C.KEYS]].assign(actual=test[C.TARGET].to_numpy(), xgb=test_pred,
                                             baseline=B.moving_average(test).to_numpy())
    imp = pd.Series(model.get_booster().get_score(importance_type="gain")).reindex(feats).fillna(0)
    make_plots(pred_df, imp, report_dir / "plots")
    shap_plot(model, test[feats], report_dir / "plots")
    pred_df.to_csv(report_dir / "test_predictions.csv", index=False)

    summary = manager_summary(xg, bl, float(test[C.TARGET].mean()))
    md = [f"# Model report {version}", f"Data label: **{data_label}**", "",
          "## Test set (newest, never used for fitting/early stopping)",
          comparison_markdown(results["test"]), "", "## Validation set", comparison_markdown(results["val"]), "",
          "## In plain words", summary, ""]
    if cv:
        md += ["## Time-series CV (expanding window)", pd.DataFrame(cv).round(2).to_string(index=False), ""]
    md += ["## Top features (gain; influence on predictions, not causes)",
           imp.sort_values(ascending=False).head(10).round(1).to_string(), ""]
    if "synthetic" in data_label.lower():
        md.insert(2, "> **SYNTHETIC DATA - these numbers say nothing about real-world accuracy.**\n")
    (report_dir / "report.md").write_text("\n".join(md))
    (report_dir / "metrics.json").write_text(json.dumps({"results": results, "cv": cv}, indent=2, default=_jsonable))
    log.info("\n%s", summary)

    meta.update(params=dict(C.XGB_PARAMS, **params), best_iteration=best_n, metrics=results, cv=cv,
                residual_quantiles=q, split={"train_rows": len(train), "val_rows": len(val), "test_rows": len(test)})
    return finish(mode, reason)


def main() -> None:
    C.setup_logging()
    ap = argparse.ArgumentParser(description="Train the Smart Mess meal-demand model")
    ap.add_argument("--data", required=True, help="CSV/Parquet with at least date, mess_id, meal_type, served_meals")
    ap.add_argument("--calendar", help="optional CSV: date,is_holiday,is_event")
    ap.add_argument("--tune", action="store_true", help="small time-series-CV random search")
    ap.add_argument("--data-label", default="real", help="use 'synthetic' for fake data; stored in metadata")
    ap.add_argument("--version")
    ap.add_argument("--no-cv", action="store_true")
    a = ap.parse_args()
    cal = load_raw(a.calendar) if a.calendar else None
    meta = run_training(load_raw(a.data), calendar=cal, tune=a.tune, data_label=a.data_label,
                        version=a.version, run_cv=not a.no_cv)
    print(f"\nversion={meta['version']} mode={meta['mode']}\n{meta['mode_reason']}")


if __name__ == "__main__":
    main()
