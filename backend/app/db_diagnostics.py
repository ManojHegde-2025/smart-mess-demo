"""Temporary read-only database identity diagnostic for authorized operators."""
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session


def database_diagnostics(db: Session) -> dict:
    """Inspect identity and resolved source relations on the active backend Session connection."""
    connection = db.connection()
    dialect = connection.dialect
    if dialect.name != "postgresql":
        raise ValueError("Database identity diagnostics require PostgreSQL")

    identity = connection.execute(text(
        "SELECT current_database(), current_schema(), current_user, current_schemas(true)"
    )).one()

    def optional_scalar(statement: str):
        try:
            with connection.begin_nested():
                return connection.execute(text(statement)).scalar_one_or_none()
        except SQLAlchemyError:
            return None

    result = {
        "current_database": identity[0],
        "current_schema": identity[1],
        "current_user": identity[2],
        "current_schemas": list(identity[3] or []),
        "inet_server_addr": optional_scalar("SELECT inet_server_addr()::text"),
        "inet_server_port": optional_scalar("SELECT inet_server_port()"),
        "pg_postmaster_start_time": None,
        "relations": {},
    }
    postmaster = optional_scalar("SELECT pg_postmaster_start_time()")
    result["pg_postmaster_start_time"] = str(postmaster) if postmaster is not None else None
    for relation in ("meal_logs", "messes"):
        resolved = connection.execute(text(
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
        prep = dialect.identifier_preparer
        qualified = f"{prep.quote_schema(schema)}.{prep.quote(relname)}"
        count = connection.execute(text(f"SELECT COUNT(*) FROM {qualified}")).scalar_one()
        result["relations"][relation] = {
            "resolved": True,
            "schema": schema,
            "relation_type": {"r": "table", "p": "partitioned_table", "v": "view",
                              "m": "materialized_view", "f": "foreign_table"}.get(relkind, "other"),
            "row_count": int(count),
        }
    return result
