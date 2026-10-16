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
        """Read-only database identity, relation resolution, and aggregate counts."""
        from sqlalchemy import create_engine, text

        relation_types = {"r": "table", "p": "partitioned_table", "v": "view",
                          "m": "materialized_view", "f": "foreign_table"}
        eng = create_engine(self.dsn, pool_pre_ping=True)
        with eng.connect() as con:
            identity = con.execute(text(
                "SELECT current_database(), current_schema(), current_user, current_schemas(true)"
            )).one()
            result = {
                "current_database": identity[0],
                "current_schema": identity[1],
                "current_user": identity[2],
                "current_schemas": list(identity[3] or []),
                "relations": {},
            }
            for relation in ("meal_logs", "messes"):
                resolved = con.execute(text(
                    "SELECT c.relname, n.nspname, c.relkind "
                    "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                    "WHERE c.oid = to_regclass(:relation)::oid"
                ), {"relation": relation}).one_or_none()
                if resolved is None:
                    result["relations"][relation] = {
                        "resolved": False, "schema": None, "relation_type": None, "row_count": None,
                    }
                    continue
                relname, schema, relkind = resolved
                preparer = con.dialect.identifier_preparer
                qualified = f"{preparer.quote_schema(schema)}.{preparer.quote(relname)}"
                count = con.execute(text(f"SELECT COUNT(*) FROM {qualified}")).scalar_one()
                result["relations"][relation] = {
                    "resolved": True, "schema": schema,
                    "relation_type": relation_types.get(relkind, "other"),
                    "row_count": int(count),
                }

            # Preserve the earlier summary fields while sourcing counts from resolved relations.
            result["meal_logs_count"] = result["relations"]["meal_logs"]["row_count"]
            result["messes_count"] = result["relations"]["messes"]["row_count"]
            result["join_count"] = int(con.execute(text(
                "SELECT COUNT(*) FROM meal_logs ml JOIN messes m ON m.id = ml.mess_id"
            )).scalar_one())
            result["unmatched_meal_logs_count"] = int(con.execute(text(
                "SELECT COUNT(*) FROM meal_logs ml LEFT JOIN messes m ON m.id = ml.mess_id WHERE m.id IS NULL"
            )).scalar_one())
            result["null_mess_code_join_count"] = int(con.execute(text(
                "SELECT COUNT(*) FROM meal_logs ml JOIN messes m ON m.id = ml.mess_id WHERE m.code IS NULL"
            )).scalar_one())
            result["grouped_counts"] = [
                {"mess_id": row[0], "meal_type": row[1], "row_count": int(row[2])}
                for row in con.execute(text(
                    "SELECT LOWER(TRIM(m.code)), LOWER(TRIM(ml.meal_period)), COUNT(*) "
                    "FROM meal_logs ml JOIN messes m ON m.id = ml.mess_id "
                    "WHERE m.code IS NOT NULL "
                    "GROUP BY LOWER(TRIM(m.code)), LOWER(TRIM(ml.meal_period)) "
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
