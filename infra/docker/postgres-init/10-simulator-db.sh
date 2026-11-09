#!/bin/bash
# Bootstraps the provider-simulator database and its two roles (CONVENTIONS §16).
#
# Runs from the postgres image's /docker-entrypoint-initdb.d, i.e. only on first
# initialisation of an empty data directory, and is also copied into the Testcontainers
# fixture so both paths exercise the same SQL.
#
# Deliberately does NOT create FlowLedger roles: those belong to migration 0200 (P02).
# Deliberately does NOT hardcode the main database name: Testcontainers uses
# POSTGRES_DB=test.
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v sim_pw="$FL_SIMULATOR_PASSWORD" \
  -v truth_pw="$FL_SIMULATOR_TRUTH_PASSWORD" <<'SQL'
CREATE ROLE fl_simulator LOGIN PASSWORD :'sim_pw';
CREATE ROLE fl_simulator_truth LOGIN PASSWORD :'truth_pw';

-- Ground truth is read-only at the session level, not merely by convention.
ALTER ROLE fl_simulator_truth SET default_transaction_read_only = on;

CREATE DATABASE flowledger_sim OWNER fl_simulator;
REVOKE ALL ON DATABASE flowledger_sim FROM PUBLIC;
GRANT CONNECT ON DATABASE flowledger_sim TO fl_simulator, fl_simulator_truth;
SQL

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname flowledger_sim <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO fl_simulator;
GRANT USAGE ON SCHEMA public TO fl_simulator_truth;

-- So tables the simulator creates later are readable by the truth role without a grant
-- per table.
ALTER DEFAULT PRIVILEGES FOR ROLE fl_simulator IN SCHEMA public
  GRANT SELECT ON TABLES TO fl_simulator_truth;
SQL
