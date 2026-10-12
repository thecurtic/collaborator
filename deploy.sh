#!/usr/bin/env bash
# Collaborator deploy: pull, install, build, restart, health-check.
#
# Run on the server from the checkout root (e.g. /srv/collaborator):
#
#   ./deploy.sh                  # full deploy
#   SKIP_PULL=1 ./deploy.sh      # deploy the working tree as-is
#   SKIP_FRONTEND=1 ./deploy.sh  # backend only
#
# What it does:
#   1. git pull --ff-only
#   2. backend/.venv: install requirements, upgrade yt-dlp (it rots against
#      YouTube, so every deploy refreshes it)
#   3. frontend: npm ci + npm run build  ->  frontend/dist
#   4. restart the backend (systemd user or system unit if installed, else
#      ./restart.sh) and the frontend unit if one exists
#   5. wait for /api/health
#
# The frontend is static files in frontend/dist. Serve them with your reverse
# proxy and route /api to the backend; deploy/Caddyfile.example shows one way.
# If you run a dedicated static server as a systemd unit instead, name it in
# FRONTEND_SERVICE and this script restarts it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BACKEND_SERVICE="${BACKEND_SERVICE:-collaborator-backend}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-collaborator-frontend}"
VENV="$ROOT/backend/.venv"

log() { printf '\n== %s\n' "$*"; }

# Restart a systemd unit by name: a user unit (systemctl --user) if one is
# installed, else a system unit (sudo). Returns 1 when neither exists.
restart_unit() {
    command -v systemctl >/dev/null 2>&1 || return 1
    if systemctl --user list-unit-files 2>/dev/null | grep -q "^$1\.service"; then
        systemctl --user restart "$1"
    elif systemctl list-unit-files 2>/dev/null | grep -q "^$1\.service"; then
        sudo systemctl restart "$1"
    else
        return 1
    fi
}

# --- 0. preconditions --------------------------------------------------------
[ -f config.yaml ] || {
    echo "config.yaml not found. Copy config.yaml.example and edit it first." >&2
    exit 1
}

# --- 1. pull -----------------------------------------------------------------
if [ -z "${SKIP_PULL:-}" ]; then
    log "Pulling latest"
    git pull --ff-only
fi

# --- 2. backend --------------------------------------------------------------
log "Backend dependencies"
[ -x "$VENV/bin/pip" ] || python3 -m venv "$VENV" || true
[ -x "$VENV/bin/pip" ] || {
    echo "python3 -m venv could not create a venv with pip (on Debian/Ubuntu: sudo apt install python3-venv)" >&2
    exit 1
}
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r backend/requirements.txt
"$VENV/bin/pip" install --quiet --upgrade yt-dlp
command -v ffmpeg >/dev/null 2>&1 || \
    echo "WARNING: ffmpeg not on PATH; audio and video transcription will fail (apt install ffmpeg)."

# --- 3. frontend -------------------------------------------------------------
if [ -z "${SKIP_FRONTEND:-}" ]; then
    if command -v npm >/dev/null 2>&1; then
        log "Frontend build"
        ( cd frontend && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) && npm run build )
    else
        echo "WARNING: npm not found; skipping the frontend build."
    fi
fi

# --- 4. restart --------------------------------------------------------------
log "Restarting backend"
restart_unit "$BACKEND_SERVICE" || ./restart.sh
if [ -z "${SKIP_FRONTEND:-}" ]; then
    log "Restarting frontend ($FRONTEND_SERVICE)"
    restart_unit "$FRONTEND_SERVICE" || \
        echo "no $FRONTEND_SERVICE unit; frontend/dist is built, your proxy serves it"
fi

# --- 5. health ---------------------------------------------------------------
PORT="$(grep -E '^[[:space:]]*backend_port:' config.yaml 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
PORT="${PORT:-8001}"
printf 'Waiting for backend health'
for _ in $(seq 1 20); do
    if curl -fs "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
        echo " OK"
        curl -fs "http://localhost:$PORT/api/health"; echo
        exit 0
    fi
    printf '.'
    sleep 1
done
echo " backend not responding after 20s" >&2
exit 1
