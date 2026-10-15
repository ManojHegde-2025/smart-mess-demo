-- Run ONCE as the database owner (e.g. postgres). Gives the ML service read-only access to the
-- mess_usage view and nothing else. Change the password before use.
--   psql -U postgres -d mess_attendance -v ml_pw="'a-strong-password'" -f scripts/create_ml_reader.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ml_readonly') THEN
    CREATE ROLE ml_readonly LOGIN PASSWORD 'change-me';
  END IF;
END $$;
ALTER ROLE ml_readonly PASSWORD :ml_pw;
GRANT CONNECT ON DATABASE mess_attendance TO ml_readonly;
GRANT USAGE ON SCHEMA public TO ml_readonly;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ml_readonly;
GRANT SELECT ON mess_usage TO ml_readonly;
