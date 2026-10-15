"""Metrics, comparison table and plots."""
from __future__ import annotations

import logging
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from . import config as C

log = logging.getLogger(__name__)


def compute_metrics(y_true, y_pred) -> dict:
    y_true, y_pred = np.asarray(y_true, float), np.asarray(y_pred, float)
    err = y_pred - y_true
    ss_tot = float(((y_true - y_true.mean()) ** 2).sum())
    out = {
        "n": int(len(y_true)),
        "mae": float(np.abs(err).mean()),
        "rmse": float(np.sqrt((err ** 2).mean())),
        "bias": float(err.mean()),  # >0 = over-forecast
        "r2": float(1 - (err ** 2).sum() / ss_tot) if ss_tot > 0 else None,
        # MAPE is only meaningful when no actual is (near) zero
        "mape_pct": float(np.abs(err / y_true).mean() * 100) if (y_true > 0).all() else None,
    }
    return out


def comparison_table(results: dict[str, dict]) -> pd.DataFrame:
    return pd.DataFrame(
        [{"Model": k, "MAE": v["mae"], "RMSE": v["rmse"], "R2": v["r2"], "MAPE %": v["mape_pct"], "n": v["n"]}
         for k, v in results.items()]
    )


def comparison_markdown(results: dict[str, dict]) -> str:
    return comparison_table(results).round(2).to_markdown(index=False) if _has_tabulate() else \
        comparison_table(results).round(2).to_string(index=False)


def _has_tabulate() -> bool:
    try:
        import tabulate  # noqa: F401
        return True
    except ImportError:
        return False


def manager_summary(xgb: dict, base: dict, mean_actual: float) -> str:
    gain = (base["mae"] - xgb["mae"]) / base["mae"] * 100 if base["mae"] else 0.0
    s = (f"On the held-out test period the model is off by about {xgb['mae']:.0f} meals on average per "
         f"meal period (about {xgb['mae'] / mean_actual * 100:.1f}% of a typical {mean_actual:.0f}-meal service). "
         f"The simple 7-day average is off by {base['mae']:.0f}. ")
    if gain > 0:
        s += f"XGBoost reduces the average error by {gain:.0f}%."
    else:
        s += "XGBoost did NOT beat the 7-day average on this data, so the baseline should be used."
    return s


# ---------------------------------------------------------------- plots
def _save(fig, path: Path) -> Path:
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)
    return path


def make_plots(pred: pd.DataFrame, importance: pd.Series | None, out_dir: Path) -> list[Path]:
    """pred columns: date, mess_id, meal_type, actual, xgb, baseline."""
    out_dir.mkdir(parents=True, exist_ok=True)
    pred = pred.copy()
    pred["err"] = pred["xgb"] - pred["actual"]
    pred["base_err"] = pred["baseline"] - pred["actual"]
    paths = []

    top = pred.groupby(C.KEYS).size().idxmax()
    sub = pred[(pred[C.MESS] == top[0]) & (pred[C.MEAL] == top[1])].sort_values(C.DATE)
    fig, ax = plt.subplots(1, 2, figsize=(13, 4.5))
    ax[0].plot(sub[C.DATE], sub["actual"], label="Actual", lw=1.6)
    ax[0].plot(sub[C.DATE], sub["xgb"], label="XGBoost", lw=1.2)
    ax[0].plot(sub[C.DATE], sub["baseline"], label="7-day avg", lw=1, alpha=.6, ls="--")
    ax[0].set(title=f"Actual vs predicted - {top[0]} / {top[1]}", ylabel="meals"); ax[0].legend()
    ax[0].tick_params(axis="x", rotation=30)
    lim = [pred["actual"].min(), pred["actual"].max()]
    ax[1].scatter(pred["actual"], pred["xgb"], s=8, alpha=.5); ax[1].plot(lim, lim, "k--", lw=1)
    ax[1].set(title="Predicted vs actual (all test rows)", xlabel="actual", ylabel="predicted")
    paths.append(_save(fig, out_dir / "1_actual_vs_predicted.png"))

    daily = pred.groupby(C.DATE)[["err", "base_err"]].mean()
    fig, ax = plt.subplots(figsize=(9, 4))
    ax.bar(daily.index, daily["err"], width=0.8, alpha=.5, label="XGBoost daily mean error")
    ax.plot(daily.index, daily["err"].rolling(7, min_periods=1).mean(), color="C3", label="7-day rolling")
    ax.axhline(0, color="k", lw=.8); ax.set(title="Prediction error over time (pred - actual)", ylabel="meals")
    ax.legend(); ax.tick_params(axis="x", rotation=30)
    paths.append(_save(fig, out_dir / "2_error_over_time.png"))

    if importance is not None and len(importance):
        imp = importance.sort_values()
        fig, ax = plt.subplots(figsize=(7, max(3, .3 * len(imp))))
        ax.barh(imp.index, imp.values); ax.set(title="XGBoost feature importance (gain)\n(influence on predictions, not causation)")
        paths.append(_save(fig, out_dir / "3_feature_importance.png"))

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.hist(pred["err"], bins=40, alpha=.7, label="XGBoost"); ax.hist(pred["base_err"], bins=40, alpha=.4, label="7-day avg")
    ax.axvline(0, color="k", lw=.8); ax.set(title="Residual distribution (pred - actual)", xlabel="meals"); ax.legend()
    paths.append(_save(fig, out_dir / "4_residual_distribution.png"))

    meals = sorted(pred[C.MEAL].unique())
    fig, axes = plt.subplots(1, len(meals), figsize=(5 * len(meals), 4), squeeze=False, sharey=False)
    for ax, m in zip(axes[0], meals):
        d = pred[pred[C.MEAL] == m].groupby(C.DATE)[["actual", "xgb"]].mean()
        ax.plot(d.index, d["actual"], label="Actual"); ax.plot(d.index, d["xgb"], label="XGBoost")
        ax.set_title(f"{m} (mean over messes)"); ax.tick_params(axis="x", rotation=30)
    axes[0][0].legend()
    paths.append(_save(fig, out_dir / "5_forecast_vs_actual_by_meal.png"))

    ae = pred.assign(ax_=pred["err"].abs(), ab_=pred["base_err"].abs()).groupby(C.DATE)[["ax_", "ab_"]].mean()
    fig, ax = plt.subplots(figsize=(9, 4))
    ax.plot(ae.index, ae["ax_"].rolling(7, min_periods=1).mean(), label="XGBoost")
    ax.plot(ae.index, ae["ab_"].rolling(7, min_periods=1).mean(), label="7-day avg", ls="--")
    ax.set(title="Forecast accuracy over time (7-day rolling MAE)", ylabel="MAE (meals)"); ax.legend()
    ax.tick_params(axis="x", rotation=30)
    paths.append(_save(fig, out_dir / "6_accuracy_over_time.png"))
    return paths


def shap_plot(model, X: pd.DataFrame, out_dir: Path) -> Path | None:
    """Optional: only runs if `shap` is installed."""
    try:
        import shap
    except ImportError:
        log.info("shap not installed - skipping SHAP plot (pip install shap).")
        return None
    sv = shap.TreeExplainer(model).shap_values(X)
    shap.summary_plot(sv, X, show=False)
    path = out_dir / "7_shap_summary.png"
    plt.gcf().savefig(path, dpi=130, bbox_inches="tight"); plt.close()
    return path
