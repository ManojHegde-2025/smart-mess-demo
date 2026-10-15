"""Integration upgrade: stable mess codes, scan log, prepared counts, forecasts, ML view.

Only additive changes. Nothing is dropped or renamed, so existing frontends and data keep working.
Every statement is idempotent (IF NOT EXISTS / OR REPLACE).

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-15
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

UPGRADE_SQL = """
ALTER TABLE messes ADD COLUMN IF NOT EXISTS code VARCHAR(32) UNIQUE;

CREATE TABLE IF NOT EXISTS scan_attempts (
    id           SERIAL PRIMARY KEY,
    mess_id      INTEGER REFERENCES messes(id),
    student_ref  VARCHAR(16),
    meal_period  VARCHAR(16),
    code         VARCHAR(32) NOT NULL,
    allowed      BOOLEAN NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_scan_attempts_mess_time ON scan_attempts (mess_id, created_at);

CREATE TABLE IF NOT EXISTS prepared_counts (
    id              SERIAL PRIMARY KEY,
    mess_id         INTEGER NOT NULL REFERENCES messes(id),
    meal_date       DATE NOT NULL,
    meal_period     VARCHAR(16) NOT NULL,
    prepared_count  INTEGER NOT NULL CHECK (prepared_count >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_prepared_per_meal UNIQUE (mess_id, meal_date, meal_period)
);

CREATE TABLE IF NOT EXISTS forecasts (
    id                      SERIAL PRIMARY KEY,
    mess_id                 INTEGER NOT NULL REFERENCES messes(id),
    target_date             DATE NOT NULL,
    meal_period             VARCHAR(16) NOT NULL,
    predicted_meals         INTEGER NOT NULL,
    recommended_preparation INTEGER,
    range_low               INTEGER,
    range_high              INTEGER,
    model_version           VARCHAR(32),
    method                  VARCHAR(32),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_forecasts_mess_date ON forecasts (mess_id, target_date, meal_period);

CREATE TABLE IF NOT EXISTS forecast_evaluations (
    id              SERIAL PRIMARY KEY,
    forecast_id     INTEGER NOT NULL UNIQUE REFERENCES forecasts(id),
    actual_count    INTEGER NOT NULL,
    absolute_error  DOUBLE PRECISION NOT NULL,
    squared_error   DOUBLE PRECISION NOT NULL,
    signed_error    DOUBLE PRECISION NOT NULL,
    evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW mess_usage AS
SELECT ms.code        AS mess_id,
       ml.meal_date   AS date,
       ml.meal_period AS meal_type,
       COUNT(*)       AS served_count
FROM meal_logs ml
JOIN messes ms ON ms.id = ml.mess_id
WHERE ms.code IS NOT NULL
GROUP BY ms.code, ml.meal_date, ml.meal_period;
"""


def upgrade() -> None:
    op.execute(UPGRADE_SQL)


def downgrade() -> None:
    # Keeps data: only the view and the new tables are removed.
    op.execute("DROP VIEW IF EXISTS mess_usage;")
    op.execute("DROP TABLE IF EXISTS forecast_evaluations, forecasts, prepared_counts, scan_attempts;")
    op.execute("ALTER TABLE messes DROP COLUMN IF EXISTS code;")
