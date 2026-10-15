-- Mess attendance schema (PostgreSQL 14+). Full schema for a FRESH database.
-- Existing databases are upgraded with Alembic (migrations/). Keep this file in sync with app/models.py.
-- Apply on a new database:   psql mess_attendance -f schema.sql

CREATE TABLE IF NOT EXISTS messes (
    id    SERIAL PRIMARY KEY,
    name  VARCHAR(120) NOT NULL,
    code  VARCHAR(32) UNIQUE            -- stable id, e.g. 'south' (used by the ML service and dashboard)
);

CREATE TABLE IF NOT EXISTS students (
    id             SERIAL PRIMARY KEY,
    roll_no        VARCHAR(32)  NOT NULL UNIQUE,
    name           VARCHAR(120) NOT NULL,
    password_hash  VARCHAR(255) NOT NULL,
    role           VARCHAR(16)  NOT NULL DEFAULT 'student'
                   CHECK (role IN ('student', 'manager')),
    mess_id        INTEGER REFERENCES messes(id),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leaves (
    id          SERIAL PRIMARY KEY,
    student_id  INTEGER NOT NULL REFERENCES students(id),
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    status      VARCHAR(16) NOT NULL DEFAULT 'approved'
                CHECK (status IN ('approved', 'cancelled')),
    reason      VARCHAR(255),
    CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS ix_leaves_student_dates ON leaves (student_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS meal_logs (
    id           SERIAL PRIMARY KEY,
    student_id   INTEGER NOT NULL REFERENCES students(id),
    mess_id      INTEGER NOT NULL REFERENCES messes(id),
    meal_date    DATE NOT NULL,
    meal_period  VARCHAR(16) NOT NULL CHECK (meal_period IN ('breakfast', 'lunch', 'dinner')),
    qr_window    INTEGER NOT NULL,
    scanned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_one_meal_per_period UNIQUE (student_id, meal_date, meal_period)
);
CREATE INDEX IF NOT EXISTS ix_meal_logs_mess_date ON meal_logs (mess_id, meal_date, meal_period);

-- Append-only. Balance is SUM(amount) per student.
CREATE TABLE IF NOT EXISTS ledger_entries (
    id            SERIAL PRIMARY KEY,
    student_id    INTEGER NOT NULL REFERENCES students(id),
    amount        INTEGER NOT NULL,
    reason        VARCHAR(32) NOT NULL CHECK (reason IN ('topup', 'meal', 'adjustment')),
    meal_log_id   INTEGER UNIQUE REFERENCES meal_logs(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ledger_student ON ledger_entries (student_id);

-- Every scan decision, allowed or rejected (feeds the exceptions list).
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

-- Cooked quantities entered by the manager (waste calculation).
CREATE TABLE IF NOT EXISTS prepared_counts (
    id              SERIAL PRIMARY KEY,
    mess_id         INTEGER NOT NULL REFERENCES messes(id),
    meal_date       DATE NOT NULL,
    meal_period     VARCHAR(16) NOT NULL,
    prepared_count  INTEGER NOT NULL CHECK (prepared_count >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_prepared_per_meal UNIQUE (mess_id, meal_date, meal_period)
);

-- Forecasts returned by the ML service, stored for later comparison.
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

-- Aggregate view read by the ML service (HISTORY_SQL default: SELECT ... FROM mess_usage).
-- Served count is derived from successful meal logs. It does NOT include active_students or
-- approved_leave: those must be recorded as they were before each meal, which is not stored yet.
CREATE OR REPLACE VIEW mess_usage AS
SELECT ms.code        AS mess_id,
       ml.meal_date   AS date,
       ml.meal_period AS meal_type,
       COUNT(*)       AS served_count
FROM meal_logs ml
JOIN messes ms ON ms.id = ml.mess_id
WHERE ms.code IS NOT NULL
GROUP BY ms.code, ml.meal_date, ml.meal_period;
