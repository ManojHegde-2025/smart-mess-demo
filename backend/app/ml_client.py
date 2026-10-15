"""Server-side client for the ML forecasting service. The API key never reaches the browser."""
import os
from dataclasses import dataclass, field

import httpx
from fastapi import HTTPException


@dataclass
class MlSettings:
    url: str = field(default_factory=lambda: os.getenv("ML_SERVICE_URL", "http://localhost:8100"))
    key: str = field(default_factory=lambda: os.getenv("ML_API_KEY", ""))
    timeout: float = field(default_factory=lambda: float(os.getenv("ML_TIMEOUT_SECONDS", "8")))


def _client(cfg: MlSettings) -> httpx.Client:
    return httpx.Client(base_url=cfg.url, timeout=cfg.timeout, headers={"X-API-Key": cfg.key})


def predict_one(mess_code: str, day: str, meal: str, cfg: MlSettings | None = None) -> tuple[bool, dict]:
    """Returns (True, forecast) or (False, {'reason': ...}) when the ML service has no answer for that meal."""
    cfg = cfg or MlSettings()
    try:
        with _client(cfg) as client:
            res = client.post("/predict", json={"mess_id": mess_code, "date": day, "meal_type": meal})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"ML service unreachable: {exc.__class__.__name__}")
    if res.status_code == 200:
        return True, res.json()
    if res.status_code == 401:
        raise HTTPException(status_code=502, detail="ML service rejected the API key (check ML_API_KEY)")
    detail = res.json().get("detail") if res.headers.get("content-type", "").startswith("application/json") else None
    return False, {"reason": detail or f"ML service returned {res.status_code}"}


def evaluate_pairs(pairs: list[dict], cfg: MlSettings | None = None) -> dict:
    cfg = cfg or MlSettings()
    try:
        with _client(cfg) as client:
            res = client.post("/evaluate-forecasts", json=pairs)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"ML service unreachable: {exc.__class__.__name__}")
    res.raise_for_status()
    return res.json()
