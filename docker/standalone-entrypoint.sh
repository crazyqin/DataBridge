#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" == "--hash-password" ]]; then
  exec java -jar /app/app.jar --hash-password
fi
if (( $# != 0 )); then
  echo "unsupported argument: $1" >&2
  exit 2
fi

data_dir=/var/lib/postgresql/data
db_password_file="$data_dir/.db_password"
secret_key_file="$data_dir/.app_secret_key"
api_key_file="$data_dir/.app_api_key"
bootstrap_hash_file="$data_dir/.bootstrap_admin_hash"
initial_password_file=/dev/shm/databridge-initial-password

random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d '[:space:]'; }
random_base64() { head -c 32 /dev/urandom | base64 -w 0; }

umask 077
mkdir -p "$data_dir" "$PGDATA"
chown postgres:postgres "$data_dir"
chmod 700 "$data_dir"

if [[ ! -s "$db_password_file" ]]; then
  if [[ -f "$PGDATA/PG_VERSION" ]]; then
    echo "database password file is missing from the existing data volume" >&2
    exit 1
  fi
  random_hex > "$db_password_file"
fi
if [[ ! -s "$secret_key_file" ]]; then
  if [[ -n "${APP_SECRET_KEY:-}" ]]; then
    printf '%s' "$APP_SECRET_KEY" > "$secret_key_file"
  else
    random_base64 > "$secret_key_file"
  fi
fi
if [[ ! -s "$api_key_file" ]]; then
  if [[ -n "${APP_API_KEY:-}" ]]; then
    printf '%s' "$APP_API_KEY" > "$api_key_file"
  else
    random_hex > "$api_key_file"
  fi
fi
chmod 600 "$db_password_file" "$secret_key_file" "$api_key_file"

export POSTGRES_USER=databridge POSTGRES_DB=databridge
export POSTGRES_PASSWORD="$(cat "$db_password_file")"
unset POSTGRES_HOST_AUTH_METHOD
export DB_URL=jdbc:postgresql://127.0.0.1:5432/databridge
export DB_USERNAME=databridge DB_PASSWORD="$POSTGRES_PASSWORD"
export APP_SECRET_KEY="$(cat "$secret_key_file")"
export APP_API_KEY="$(cat "$api_key_file")"
export ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
unset APP_FRONTEND_DIR

pg_pid=
app_pid=
stop_processes() {
  trap - TERM INT
  if [[ -n "$app_pid" ]]; then kill -TERM "$app_pid" 2>/dev/null || true; fi
  if [[ -n "$pg_pid" ]]; then kill -TERM "$pg_pid" 2>/dev/null || true; fi
  if [[ -n "$app_pid" ]]; then wait "$app_pid" 2>/dev/null || true; fi
  if [[ -n "$pg_pid" ]]; then wait "$pg_pid" 2>/dev/null || true; fi
}
trap 'stop_processes; exit 143' TERM INT

docker-entrypoint.sh postgres -c listen_addresses=127.0.0.1 -c log_min_messages=fatal &
pg_pid=$!
for (( attempt=0; attempt<120; attempt++ )); do
  if ! kill -0 "$pg_pid" 2>/dev/null; then
    wait "$pg_pid"
    exit 1
  fi
  if pg_isready -q -h 127.0.0.1 -U databridge -d databridge; then break; fi
  sleep 1
done
if ! pg_isready -q -h 127.0.0.1 -U databridge -d databridge; then
  echo "PostgreSQL did not become ready" >&2
  stop_processes
  exit 1
fi

db_query() {
  PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U databridge -d databridge -At -v ON_ERROR_STOP=1 "$@"
}
current_hash=
if [[ -n "$(db_query -c "SELECT to_regclass('public.admin_account')")" ]]; then
  current_hash="$(db_query -v username="$ADMIN_USERNAME" <<'SQL'
SELECT password_hash FROM admin_account WHERE username = :'username';
SQL
)"
fi
bootstrap_pending=false
if [[ -s "$bootstrap_hash_file" ]]; then
  if [[ -n "$current_hash" && "$current_hash" != "$(cat "$bootstrap_hash_file")" ]]; then
    rm -f "$bootstrap_hash_file" "$initial_password_file"
  else
    bootstrap_pending=true
  fi
fi
if [[ "$bootstrap_pending" == true || ( -z "$current_hash" && -z "${ADMIN_PASSWORD_HASH:-}" ) ]]; then
  initial_password="$(random_hex)"
  printf '%s\n' "$initial_password" > "$initial_password_file"
  chmod 600 "$initial_password_file"
  export ADMIN_PASSWORD_HASH="$(printf '%s\n' "$initial_password" | java -jar /app/app.jar --hash-password)"
  unset initial_password
  printf '%s' "$ADMIN_PASSWORD_HASH" > "$bootstrap_hash_file"
  chmod 600 "$bootstrap_hash_file"
  if [[ -n "$current_hash" ]]; then
    db_query -v username="$ADMIN_USERNAME" -v hash="$ADMIN_PASSWORD_HASH" >/dev/null <<'SQL'
UPDATE admin_account SET password_hash = :'hash', updated_at = now() WHERE username = :'username';
SQL
  fi
  echo "Initial admin password: read $initial_password_file in the Portainer container console, then change it after login."
fi

gosu databridge java -jar /app/app.jar &
app_pid=$!
set +e
wait -n "$pg_pid" "$app_pid"
status=$?
set -e
stop_processes
exit "$status"
