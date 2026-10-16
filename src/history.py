"""Where historical meal data comes from. Swap CSV for PostgreSQL/Supabase with HISTORY_SOURCE=postgres."""
from __future__ import annotations

import logging
import os
import time
from typing import Protocol

import pandas as pd

from . import config as C
from .preprocessing import load_raw

log = logging.getLogger(__name__)


class HistoryProvider(Protocol):
    def load(self) -> pd.DataFrame: ...


class CsvHistoryProvider:
    def __init__(self, path: str = C.HISTORY_CSV):
        self.path = path

    def load(self) -> pd.DataFrame:
        return load_raw(self.path)


class PostgresHistoryProvider:
    """Reads aggregated meal-log attendance via SQL into the model's canonical columns.

    Attendance scans are a proxy for demand, not a verified count of meals cooked/served.
    """

    def __init__(self, dsn: str | None = None, sql: str = C.HISTORY_SQL):
        self.dsn, self.sql = dsn or os.environ["DATABASE_URL"], sql

    def load(self) -> pd.DataFrame:
        from sqlalchemy import create_engine, text
        eng = create_engine(self.dsn, pool_pre_ping=True)
        with eng.connect() as con:
            return pd.read_sql(text(self.sql), con)

    def source_diagnostics(self) -> dict:
        """Read-only source/join counts that localize empty results without exposing records."""
        from sqlalchemy import create_engine, text

        statements = {
            "meal_logs_count": "SELECT COUNT(*) FROM meal_logs",
            "messes_count": "SELECT COUNT(*) FROM messes",
            "join_count": "SELECT COUNT(*) FROM meal_logs ml JOIN messes m ON m.id = ml.mess_id",
            "unmatched_meal_logs_count": "SELECT COUNT(*) FROM meal_logs ml LEFT JOIN messes m ON m.id = ml.mess_id WHERE m.id IS NULL",
            "null_mess_code_join_count": "SELECT COUNT(*) FROM meal_logs ml JOIN messes m ON m.id = ml.mess_id WHERE m.code IS NULL",
        }
        eng = create_engine(self.dsn, pool_pre_ping=True)
        with eng.connect() as con:
            result = {name: int(con.execute(text(sql)).scalar_one()) for name, sql in statements.items()}
            result["grouped_counts"] = [
                {"mess_id": row[0], "meal_type": row[1], "row_count": int(row[2])}
                for row in con.execute(text(
                    "SELECT LOWER(BTRIM(m.code)), LOWER(BTRIM(ml.meal_period)), COUNT(*) "
                    "FROM meal_logs ml JOIN messes m ON m.id = ml.mess_id "
                    "WHERE m.code IS NOT NULL "
                    "GROUP BY LOWER(BTRIM(m.code)), LOWER(BTRIM(ml.meal_period)) "
                    "ORDER BY 1, 2"
                ))
            ]
            result["date_min"], result["date_max"] = con.execute(text(
                "SELECT MIN(ml.meal_date), MAX(ml.meal_date) "
                "FROM meal_logs ml JOIN messes m ON m.id = ml.mess_id WHERE m.code IS NOT NULL"
            )).one()
        result["date_min"] = str(result["date_min"]) if result["date_min"] is not None else None
        result["date_max"] = str(result["date_max"]) if result["date_max"] is not None else None
        return result


class CachedProvider:
    def __init__(self, inner: HistoryProvider, ttl: int = C.HISTORY_CACHE_SECONDS):
        self.inner, self.ttl, self._at, self._df = inner, ttl, 0.0, None

    def load(self) -> pd.DataFrame:
        if self._df is None or time.time() - self._at > self.ttl:
            self._df, self._at = self.inner.load(), time.time()
            try:
                summary = _history_summary(self._df)
            except Exception as exc:  # keep data-loading behavior independent of optional diagnostics
                log.warning("History refreshed: %d rows; aggregate diagnostics unavailable (%s)",
                            len(self._df), type(exc).__name__)
                return self._df
            log.info(
                "History refreshed: %d rows; columns=%s date_range=%s..%s groups=%s",
                summary["row_count"], summary["columns"], summary["date_min"],
                summary["date_max"], summary["groups"],
            )
        return self._df

    def invalidate(self) -> None:
        self._df = None

    def diagnostics(self) -> dict:
        """Return aggregate-only metadata for operators; never expose rows or connection details."""
        df = self.load()
        result = _history_summary(df)
        if isinstance(self.inner, PostgresHistoryProvider):
            result["source"] = self.inner.source_diagnostics()
        return result


def get_history_provider() -> CachedProvider:
    inner = PostgresHistoryProvider() if C.HISTORY_SOURCE == "postgres" else CsvHistoryProvider()
    return CachedProvider(inner)


def _history_summary(df: pd.DataFrame) -> dict:
    """Summarize rows using only canonical columns; malformed schemas remain diagnosable."""
    columns = [str(column) for column in df.columns]
    missing = [column for column in C.REQUIRED_COLUMNS if column not in df.columns]
    if missing:
        return {"row_count": int(len(df)), "columns": columns, "date_min": None,
                "date_max": None, "groups": [], "missing_columns": missing}

    from .preprocessing import clean

    cleaned, _ = clean(df)
    by_group = (
        cleaned.groupby([C.MESS, C.MEAL], dropna=False)[C.TARGET]
        .agg(row_count="size", total_count="sum")
        .reset_index()
    )
    return {
        "row_count": int(len(df)), "columns": columns,
        "date_min": str(cleaned[C.DATE].min().date()) if len(cleaned) else None,
        "date_max": str(cleaned[C.DATE].max().date()) if len(cleaned) else None,
        "groups": [
            {"mess_id": str(row[C.MESS]), "meal_type": str(row[C.MEAL]),
             "row_count": int(row["row_count"]), "total_count": int(row["total_count"])}
            for _, row in by_group.iterrows()
        ],
    }
