#!/bin/sh
# The container's start command (Dockerfile, railway.json): runs the server
# as the unprivileged user $SOMEMEMOS_USER (default `node`, which the Node
# image has), never as root.
#
# A host mounts the data volume owned by root, so when the container starts
# as root this hands the data directory to that user (recursively, only
# while its top folder belongs to someone else, so a restart costs nothing),
# then drops root for good with setpriv. Started as any other user, it just
# runs the server.
set -eu

user="${SOMEMEMOS_USER:-node}"
dir="${SOMEMEMOS_DATA_DIR:-/data}"
server="${SOMEMEMOS_SERVER:-apps/web/build}"

if [ "$(id -u)" = 0 ]; then
  uid="$(id -u "$user")"
  gid="$(id -g "$user")"
  mkdir -p "$dir"
  if [ "$(stat -c %u "$dir")" != "$uid" ]; then
    chown -R "$uid:$gid" "$dir"
  fi
  exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- node "$server"
fi
exec node "$server"
