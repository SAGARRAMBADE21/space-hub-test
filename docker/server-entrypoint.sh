#!/bin/sh
# Start SpacetimeDB on an internal port and the allowlist proxy on the
# public port, publish (or update) the spacehub module, then start the web
# service (sign in, sign up, GitHub import). A starting proxy holds the public
# port at once, so platform probes see it open, but answers 503 to everything:
# nobody reaches SpacetimeDB until the module is published and the hub admin
# claimed. Only then does the real allowlist proxy take the port over.
# Publishing never passes --delete-data: a breaking schema change makes
# startup fail instead of wiping spaces. The one exception is a database from
# before the project tables, which is moved aside, not deleted (see below).
set -eu

ROOT="${SPACETIME_ROOT:-/data}"
DB="${SPACEHUB_DB:-spacehub}"
INTERNAL="127.0.0.1:${SPACETIME_INTERNAL_PORT:-3001}"
export PORT="${PORT:-3000}"

# Platform volumes usually arrive owned by root. Started as root, take the
# data directory for the spacetime user, then drop root for everything else.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$ROOT"
  if [ "$(stat -c %u "$ROOT")" != "$(id -u spacetime)" ]; then
    echo "spacehub: giving $ROOT to the spacetime user"
    chown -R spacetime:spacetime "$ROOT"
  fi
  export HOME=/home/spacetime
  exec setpriv --reuid=spacetime --regid=spacetime --init-groups /usr/local/bin/spacehub-server "$@"
fi
if [ ! -w "$ROOT" ]; then
  echo "spacehub: $ROOT is not writable by uid $(id -u). Mount writable storage there," >&2
  echo "spacehub: give the pod an fsGroup of 1000, or let the container start as root so it can fix ownership." >&2
  exit 1
fi

# /data must outlive the container. Without a volume there, every redeploy
# starts an empty hub with new signing keys: projects gone, every login
# rejected ("Failed to verify token: 401"). Say so loudly, and with
# SPACEHUB_REQUIRE_STORAGE=1 refuse to start at all.
if ! awk -v dir="$ROOT" '$2 == dir { found = 1 } END { exit !found }' /proc/mounts 2>/dev/null; then
  echo "spacehub: WARNING: $ROOT is not a mounted volume. Everything here is lost on the next redeploy." >&2
  echo "spacehub: WARNING: mount persistent storage at $ROOT (on XO Launchpad: Persistent storage, path $ROOT)." >&2
  if [ "${SPACEHUB_REQUIRE_STORAGE:-}" = 1 ]; then
    echo "spacehub: SPACEHUB_REQUIRE_STORAGE=1, so refusing to start without it" >&2
    exit 1
  fi
fi

start_spacetime() {
  spacetime --root-dir "$ROOT" start --listen-addr "$INTERNAL" --non-interactive &
  server=$!
  tries=0
  until curl -sf "http://$INTERNAL/v1/ping" >/dev/null 2>&1; do
    if ! kill -0 "$server" 2>/dev/null; then
      echo "spacehub: SpacetimeDB exited during startup" >&2
      exit 1
    fi
    tries=$((tries + 1))
    if [ "$tries" -gt 300 ]; then
      echo "spacehub: SpacetimeDB did not answer on $INTERNAL" >&2
      exit 1
    fi
    sleep 0.2
  done
}

server=""
caddy run --config /opt/spacehub/starting.Caddyfile --adapter caddyfile &
proxy=$!
web=""
stop() {
  kill -TERM $server "$proxy" $web 2>/dev/null || true
  wait
}
trap 'stop; exit 0' TERM INT
start_spacetime

publish() {
  spacetime --root-dir "$ROOT" publish --server "http://$INTERNAL" "$DB" --js-path /opt/spacehub/module.js --yes
}
if ! publish; then
  # A database from before the project tables (its `space` table held
  # repositories) cannot take this schema: SpacetimeDB renames neither tables
  # nor columns. Move it aside under another name, where its data stays
  # untouched, and start a new database under this one. Anything else that
  # stops the publish still stops the server.
  BEFORE="$DB-before-projects"
  if ! spacetime --root-dir "$ROOT" sql --server "http://$INTERNAL" "$DB" "SELECT full_name FROM space WHERE id = 0" >/dev/null 2>&1; then
    echo "spacehub: could not publish the module to \"$DB\"" >&2
    exit 1
  fi
  identity="$(curl -sf "http://$INTERNAL/v1/database/$DB" | sed -n 's/.*"database_identity":{"__identity__":"0x\([0-9a-f]*\)".*/\1/p')"
  if [ -z "$identity" ] || ! spacetime --root-dir "$ROOT" rename --server "http://$INTERNAL" --to "$BEFORE" "$identity" --yes; then
    echo "spacehub: \"$DB\" is from before the project tables, and could not be renamed to \"$BEFORE\"" >&2
    exit 1
  fi
  echo "spacehub: \"$DB\" is from before the project tables; it is kept, unchanged, as \"$BEFORE\", and \"$DB\" starts empty"
  publish
  # Restart SpacetimeDB so the old database, loaded by the checks above, is
  # not held in memory; nothing opens it again.
  kill -TERM "$server" 2>/dev/null || true
  wait "$server" 2>/dev/null || true
  start_spacetime
fi

# The identity that owns the database is the hub's admin (it alone writes the
# xo tables and switches sign-up). Claim it on every start, while only this
# script can reach SpacetimeDB: the first claim sticks, and if another identity
# holds it, stop rather than serve.
if ! claim="$(spacetime --root-dir "$ROOT" call --server "http://$INTERNAL" "$DB" claim_admin 2>&1)"; then
  echo "spacehub: could not claim the hub admin: $claim" >&2
  echo "spacehub: refusing to start; if another identity holds it, the database was tampered with" >&2
  exit 1
fi

# The web service acts as the admin for three things: syncing spaces linked to
# GitHub, signing builders up with GitHub (/-/api/auth/github), and (only with
# SPACEHUB_XO_KEY) xo.quirq.dev's API at /-/api/xo/v1/, which makes builders
# for xo's users.
# The CLI keeps the owner's token as spacetimedb_token in its cli.toml.
SPACEHUB_ADMIN_TOKEN="$(sed -n 's/^[[:space:]]*spacetimedb_token[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$ROOT/config/cli.toml" 2>/dev/null | head -n 1)"
if [ -z "$SPACEHUB_ADMIN_TOKEN" ]; then
  SPACEHUB_ADMIN_TOKEN="$(spacetime --root-dir "$ROOT" login show --token 2>/dev/null \
    | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | head -n 1)"
fi
if [ -n "$SPACEHUB_ADMIN_TOKEN" ]; then
  export SPACEHUB_ADMIN_TOKEN
else
  echo "spacehub: the admin's token could not be read; spaces linked to GitHub will not sync" >&2
fi
# How people sign up, from SPACEHUB_ACCOUNTS: "github" (the default: with a
# GitHub account, checked by the web service as the admin), "open" (anyone
# registers a name) or "xo" (nobody: only xo's API makes builders). xo's API
# (SPACEHUB_XO_KEY) makes builders for xo's users in every mode.
ACCOUNTS="${SPACEHUB_ACCOUNTS:-github}"
case "$ACCOUNTS" in
  github | open | xo) ;;
  *)
    echo "spacehub: SPACEHUB_ACCOUNTS must be \"github\", \"open\" or \"xo\"" >&2
    exit 1
    ;;
esac
if [ "$ACCOUNTS" = github ] && [ -z "$SPACEHUB_ADMIN_TOKEN" ]; then
  echo "spacehub: GitHub sign-up needs the admin's token, and it could not be read" >&2
  exit 1
fi
# The hub's GitHub OAuth App (device flow sign-in): its client id and secret, both or neither.
if [ -z "${SPACEHUB_GITHUB_CLIENT_ID:-}" ] && [ -n "${SPACEHUB_GITHUB_CLIENT_SECRET:-}" ]; then
  github_app=half
elif [ -n "${SPACEHUB_GITHUB_CLIENT_ID:-}" ] && [ -z "${SPACEHUB_GITHUB_CLIENT_SECRET:-}" ]; then
  github_app=half
else
  github_app=ok
fi
if [ "$github_app" = half ]; then
  echo "spacehub: set both SPACEHUB_GITHUB_CLIENT_ID and SPACEHUB_GITHUB_CLIENT_SECRET (the OAuth App's), or neither" >&2
  exit 1
fi
if [ -n "${SPACEHUB_XO_KEY:-}" ] && [ -z "$SPACEHUB_ADMIN_TOKEN" ]; then
  echo "spacehub: SPACEHUB_XO_KEY is set but the admin's token could not be read" >&2
  exit 1
fi
spacetime --root-dir "$ROOT" call --server "http://$INTERNAL" "$DB" set_accounts "\"$ACCOUNTS\"" >/dev/null

# Ready: hand the public port to the allowlist proxy.
kill -TERM "$proxy" 2>/dev/null || true
wait "$proxy" 2>/dev/null || true
caddy run --config /opt/spacehub/Caddyfile --adapter caddyfile &
proxy=$!

SPACEHUB_SERVER="ws://$INTERNAL" SPACEHUB_INTERNAL_HTTP="http://$INTERNAL" SPACEHUB_DB="$DB" node /opt/spacehub/cli/dist/web.mjs &
web=$!
echo "spacehub: serving database \"$DB\" on port $PORT"

while kill -0 "$server" 2>/dev/null && kill -0 "$proxy" 2>/dev/null && kill -0 "$web" 2>/dev/null; do
  sleep 2
done
echo "spacehub: a server process exited; stopping" >&2
stop
exit 1
