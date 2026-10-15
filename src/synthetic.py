"""SYNTHETIC development data. NOT real. Only for testing the code before the real dataset arrives.
Any model trained on this file says nothing about real-world accuracy."""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C

MEAL_RATE = {"breakfast": 0.70, "lunch": 0.88, "dinner": 0.92}


def generate(days: int = 365, seed: int = 0, messes=("south", "north")) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2025-07-01", periods=days, freq="D")
    holidays = set(rng.choice(days, size=max(3, days // 30), replace=False))
    events = set(rng.choice(days, size=max(3, days // 40), replace=False))
    rows = []
    for mi, mess in enumerate(messes):
        base = 800 - 150 * mi
        for i, d in enumerate(dates):
            active = int(base + 0.15 * i + rng.normal(0, 4))
            hol, ev = int(i in holidays), int(i in events)
            leave = int(max(0, rng.normal(0.06 * active, 8) + hol * 0.25 * active + (d.dayofweek == 4) * 0.05 * active))
            for meal, rate in MEAL_RATE.items():
                wk = -0.10 if (d.dayofweek >= 5 and meal == "breakfast") else (0.03 if d.dayofweek == 6 and meal == "dinner" else 0)
                served = (active - leave) * (rate + wk + 0.05 * ev - 0.04 * hol) + rng.normal(0, 9)
                rows.append((d.date().isoformat(), mess, meal, active, leave, hol, ev, int(max(0, round(served)))))
    return pd.DataFrame(rows, columns=[C.DATE, C.MESS, C.MEAL, C.ACTIVE, C.LEAVE, C.HOLIDAY, C.EVENT, C.TARGET])


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--out", default=str(C.DATA_RAW_DIR / "SYNTHETIC_meal_history.csv"))
    a = ap.parse_args()
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    generate(a.days).to_csv(a.out, index=False)
    print(f"Wrote SYNTHETIC data to {a.out} (not real data!)")
