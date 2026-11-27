#!/usr/bin/env bash
# Starts a throwaway Postgres cluster for the pg-store tests, in a new
# temporary directory on a free port, and prints the shell lines to use it:
#
#   eval "$(packages/pg-store/scripts/dev-postgres.sh)"
#   npm test
#   packages/pg-store/scripts/stop-dev-postgres.sh
#
# Postgres refuses to run as root, so under root the cluster runs as the
# `postgres` OS user (override with PG_USER). Binaries are found on PATH, else
# in PG_BIN (default /usr/lib/postgresql/16/bin). Authentication is `trust`
# on 127.0.0.1 only: this is for tests, never for real data.
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
if command -v initdb >/dev/null 2>&1; then PG_BIN="$(dirname "$(command -v initdb)")"; fi
for tool in initdb pg_ctl createdb; do
  if [ ! -x "$PG_BIN/$tool" ]; then
    echo "dev-postgres: $tool not found in $PG_BIN (set PG_BIN)" >&2
    exit 1
  fi
done

as_user=()
if [ "$(id -u)" = "0" ]; then
  PG_USER="${PG_USER:-postgres}"
  as_user=(runuser -u "$PG_USER" --)
fi

dir="$(mktemp -d "${TMPDIR:-/tmp}/somememos-pg.XXXXXX")"
chmod 700 "$dir"
if [ ${#as_user[@]} -gt 0 ]; then chown "$PG_USER" "$dir"; fi

port="${PG_PORT:-$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")}"

"${as_user[@]}" "$PG_BIN/initdb" -D "$dir/data" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >"$dir/initdb.log" 2>&1 \
  || { cat "$dir/initdb.log" >&2; exit 1; }
"${as_user[@]}" "$PG_BIN/pg_ctl" -D "$dir/data" -l "$dir/postgres.log" -w \
  -o "-p $port -k $dir -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
  start >/dev/null || { cat "$dir/postgres.log" >&2; exit 1; }
"${as_user[@]}" "$PG_BIN/createdb" -h 127.0.0.1 -p "$port" -U postgres somememos_test

echo "export SOMEMEMOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:$port/somememos_test"
echo "export SOMEMEMOS_DEV_PG_DIR=$dir"
