#!/usr/bin/env bash
# Stops a cluster started by dev-postgres.sh and deletes its directory.
#
#   packages/pg-store/scripts/stop-dev-postgres.sh [dir]   (default: $SOMEMEMOS_DEV_PG_DIR)
set -euo pipefail

dir="${1:-${SOMEMEMOS_DEV_PG_DIR:-}}"
if [ -z "$dir" ] || [ ! -d "$dir/data" ]; then
  echo "stop-dev-postgres: no cluster directory given (pass it, or set SOMEMEMOS_DEV_PG_DIR)" >&2
  exit 1
fi
case "$dir" in
  */somememos-pg.*) ;;
  *) echo "stop-dev-postgres: $dir was not made by dev-postgres.sh" >&2; exit 1 ;;
esac

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
if command -v pg_ctl >/dev/null 2>&1; then PG_BIN="$(dirname "$(command -v pg_ctl)")"; fi
as_user=()
if [ "$(id -u)" = "0" ]; then as_user=(runuser -u "$(stat -c %U "$dir/data")" --); fi

"${as_user[@]}" "$PG_BIN/pg_ctl" -D "$dir/data" -m fast -w stop >/dev/null || true
rm -rf "$dir"
echo "stopped and removed $dir"
