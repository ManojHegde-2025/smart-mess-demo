"""
QR token format:  v1.<mess_id>.<meal_period>.<window>.<signature>

- window = floor(unix_time / QR_ROTATE_SECONDS). The mess terminal shows a fresh
  token every rotation, so a photographed or forwarded QR goes stale quickly.
- signature = HMAC-SHA256 over "<mess_id>.<meal_period>.<window>", so students
  cannot forge tokens for other messes or meal periods.
"""

import hmac
import time

from app.config import settings
from app.security import sign_qr_body


class QRError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def qr_window(ts: float) -> int:
    return int(ts // settings.qr_rotate_seconds)


def issue_qr_token(mess_id: int, meal_period: str, ts: float | None = None) -> str:
    ts = time.time() if ts is None else ts
    body = f"{mess_id}.{meal_period}.{qr_window(ts)}"
    return f"v1.{body}.{sign_qr_body(body)}"


def verify_qr_token(token: str, ts: float) -> tuple[int, str, int]:
    """Return (mess_id, meal_period, window) or raise QRError."""
    parts = token.strip().split(".")
    if len(parts) != 5 or parts[0] != "v1":
        raise QRError("INVALID_QR", "Unrecognised QR code.")

    _, mess_raw, period, window_raw, signature = parts
    body = f"{mess_raw}.{period}.{window_raw}"
    if not hmac.compare_digest(signature, sign_qr_body(body)):
        raise QRError("INVALID_QR", "QR code signature is invalid.")

    try:
        mess_id = int(mess_raw)
        window = int(window_raw)
    except ValueError:
        raise QRError("INVALID_QR", "Unrecognised QR code.")

    current = qr_window(ts)
    if window < current - 1 or window > current:
        raise QRError("QR_EXPIRED", "This QR code has expired. Scan the one on the screen.")

    return mess_id, period, window
