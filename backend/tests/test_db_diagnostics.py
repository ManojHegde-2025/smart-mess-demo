from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from app.db_diagnostics import database_diagnostics


class FakeResult:
    def __init__(self, row=None, scalar=None):
        self.row, self.scalar = row, scalar

    def one(self):
        return self.row

    def one_or_none(self):
        return self.row

    def scalar_one(self):
        return self.scalar

    def scalar_one_or_none(self):
        return self.scalar


class FakeConnection:
    dialect = SimpleNamespace(
        name="postgresql",
        identifier_preparer=SimpleNamespace(
            quote_schema=lambda value: f'"{value}"', quote=lambda value: f'"{value}"'
        ),
    )

    @contextmanager
    def begin_nested(self):
        yield

    def execute(self, statement, params=None):
        sql = str(statement)
        if "current_database()" in sql:
            return FakeResult(("mess_attendance", "public", "api_user", ["pg_catalog", "public"]))
        if "inet_server_addr()" in sql:
            return FakeResult(scalar="10.0.0.4")
        if "inet_server_port()" in sql:
            return FakeResult(scalar=5432)
        if "pg_postmaster_start_time()" in sql:
            return FakeResult(scalar="2026-10-16 00:00:00+00")
        if "to_regclass" in sql:
            relation = params["relation"]
            return FakeResult((relation, "public", "r"))
        if sql.startswith("SELECT COUNT(*)"):
            return FakeResult(scalar=84321 if "meal_logs" in sql else 2)
        raise AssertionError(f"Unexpected SQL: {sql}")


class FakeSession:
    def __init__(self):
        self.connection_instance = FakeConnection()

    def connection(self):
        return self.connection_instance


def test_database_diagnostics_reports_identity_and_resolved_aggregate_counts():
    result = database_diagnostics(FakeSession())
    assert result["current_database"] == "mess_attendance"
    assert result["current_schema"] == "public"
    assert result["current_user"] == "api_user"
    assert result["current_schemas"] == ["pg_catalog", "public"]
    assert result["inet_server_addr"] == "10.0.0.4"
    assert result["inet_server_port"] == 5432
    assert result["pg_postmaster_start_time"].startswith("2026-10-16")
    assert result["relations"]["meal_logs"] == {
        "resolved": True, "schema": "public", "relation_type": "table", "row_count": 84321,
    }
    assert result["relations"]["messes"]["row_count"] == 2
    assert "DATABASE_URL" not in str(result)


def test_optional_server_metadata_failure_does_not_break_diagnostics():
    connection = FakeConnection()
    original_execute = connection.execute

    def execute(statement, params=None):
        if "pg_postmaster_start_time()" in str(statement):
            from sqlalchemy.exc import DBAPIError
            raise DBAPIError("statement", {}, Exception("not permitted"))
        return original_execute(statement, params)

    connection.execute = execute
    session = FakeSession()
    session.connection_instance = connection
    result = database_diagnostics(session)
    assert result["pg_postmaster_start_time"] is None


def test_non_postgres_database_is_rejected():
    connection = FakeConnection()
    connection.dialect.name = "sqlite"
    session = FakeSession()
    session.connection_instance = connection
    with pytest.raises(ValueError, match="require PostgreSQL"):
        database_diagnostics(session)
