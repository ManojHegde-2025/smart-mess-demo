"""Baseline: the original schema (idempotent, safe on an existing database).

Revision ID: 0001
Revises:
Create Date: 2026-10-15
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

BASELINE_SQL = "-- Mess attendance schema (PostgreSQL). Keep in sync with app/models.py.\n\nCREATE TABLE IF NOT EXISTS messes (\n    id    SERIAL PRIMARY KEY,\n    name  VARCHAR(120) NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS students (\n    id             SERIAL PRIMARY KEY,\n    roll_no        VARCHAR(32)  NOT NULL UNIQUE,\n    name           VARCHAR(120) NOT NULL,\n    password_hash  VARCHAR(255) NOT NULL,\n    role           VARCHAR(16)  NOT NULL DEFAULT 'student'\n                   CHECK (role IN ('student', 'manager')),\n    mess_id        INTEGER REFERENCES messes(id),\n    is_active      BOOLEAN NOT NULL DEFAULT TRUE,\n    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()\n);\n\nCREATE TABLE IF NOT EXISTS leaves (\n    id          SERIAL PRIMARY KEY,\n    student_id  INTEGER NOT NULL REFERENCES students(id),\n    start_date  DATE NOT NULL,\n    end_date    DATE NOT NULL,\n    status      VARCHAR(16) NOT NULL DEFAULT 'approved'\n                CHECK (status IN ('approved', 'cancelled')),\n    reason      VARCHAR(255),\n    CHECK (end_date >= start_date)\n);\nCREATE INDEX IF NOT EXISTS ix_leaves_student_dates ON leaves (student_id, start_date, end_date);\n\nCREATE TABLE IF NOT EXISTS meal_logs (\n    id           SERIAL PRIMARY KEY,\n    student_id   INTEGER NOT NULL REFERENCES students(id),\n    mess_id      INTEGER NOT NULL REFERENCES messes(id),\n    meal_date    DATE NOT NULL,\n    meal_period  VARCHAR(16) NOT NULL CHECK (meal_period IN ('breakfast', 'lunch', 'dinner')),\n    qr_window    INTEGER NOT NULL,\n    scanned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),\n    CONSTRAINT uq_one_meal_per_period UNIQUE (student_id, meal_date, meal_period)\n);\nCREATE INDEX IF NOT EXISTS ix_meal_logs_mess_date ON meal_logs (mess_id, meal_date, meal_period);\n\n-- Append-only. Balance is SUM(amount) per student.\nCREATE TABLE IF NOT EXISTS ledger_entries (\n    id            SERIAL PRIMARY KEY,\n    student_id    INTEGER NOT NULL REFERENCES students(id),\n    amount        INTEGER NOT NULL,\n    reason        VARCHAR(32) NOT NULL CHECK (reason IN ('topup', 'meal', 'adjustment')),\n    meal_log_id   INTEGER UNIQUE REFERENCES meal_logs(id),\n    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()\n);\nCREATE INDEX IF NOT EXISTS ix_ledger_student ON ledger_entries (student_id);\n"


def upgrade() -> None:
    op.execute(BASELINE_SQL)


def downgrade() -> None:
    # Destructive; intentionally not provided for the baseline.
    pass
