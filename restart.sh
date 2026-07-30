#!/bin/bash
# Restart the Collaborator Python backend (uvicorn) with one command.
#
#   ./restart.sh
#
# Path-portable (works from any checkout location), reads the port from
# config.yaml, and uses the project venv if present. If a systemd unit named
# "collaborator-backend" is installed it is used; otherwise the script stops any
# process on the backend port and relaunches uvicorn in the background.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- Resolve the backend port from config.yaml (default 8001) ---
PORT="$(grep -E '^[[:space:]]*backend_port:' config.yaml 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
PORT="${PORT:-8001}"

# --- Prefer systemd if a unit is installed (survives reboots, proper logs) ---
# Checks BOTH system and user units: starting a nohup uvicorn underneath a
# systemd-managed service leaves a zombie serving stale code on the port while
# the unit crash-loops behind it (this happened; never again).
if command -v systemctl >/dev/null 2>&1 && \
   systemctl --user list-unit-files 2>/dev/null | grep -q '^collaborator-backend\.service'; then
    echo "Restarting via systemd user unit (collaborator-backend)..."
    systemctl --user restart collaborator-backend
    sleep 1
    systemctl --user --no-pager --lines=0 status collaborator-backend || true
elif command -v systemctl >/dev/null 2>&1 && \
   systemctl list-unit-files 2>/dev/null | grep -q '^collaborator-backend\.service'; then
    echo "Restarting via systemd (collaborator-backend)..."
    sudo systemctl restart collaborator-backend
    sleep 1
    sudo systemctl --no-pager --lines=0 status collaborator-backend || true
else
    # --- Fallback: stop whatever holds the port, then relaunch uvicorn ---
    if [ -x ".venv/bin/uvicorn" ]; then
        UVICORN_CMD=("$SCRIPT_DIR/.venv/bin/uvicorn")
    elif [ -x ".venv/bin/python" ]; then
        UVICORN_CMD=("$SCRIPT_DIR/.venv/bin/python" -m uvicorn)
    else
        UVICORN_CMD=(uvicorn)
    fi

    echo "Stopping existing backend on port $PORT (if any)..."
    PIDS="$(ss -lptnH "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
    [ -z "${PIDS:-}" ] && PIDS="$(pgrep -f 'uvicorn main:app' || true)"
    if [ -n "${PIDS:-}" ]; then
        kill $PIDS 2>/dev/null || true
        sleep 1
        kill -9 $PIDS 2>/dev/null || true
    fi

    # db.py derives the project root from the CWD, so launch from backend/.
    mkdir -p logs
    echo "Starting backend on port $PORT..."
    ( cd backend && nohup "${UVICORN_CMD[@]}" main:app --host 0.0.0.0 --port "$PORT" \
        > "$SCRIPT_DIR/logs/backend.log" 2>&1 & echo "$!" > "$SCRIPT_DIR/logs/backend.pid" )
    echo "Backend started (PID $(cat logs/backend.pid)). Logs: logs/backend.log"
fi

# --- Health check (poll: uvicorn takes a couple seconds to boot) ---
echo -n "Waiting for backend health"
for _ in $(seq 1 15); do
    if curl -fs "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
        echo " — OK"
        curl -fs "http://localhost:$PORT/api/health"; echo
        exit 0
    fi
    echo -n "."
    sleep 1
done
echo " — not responding after 15s; check logs/backend.log"
exit 1
