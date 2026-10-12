#!/usr/bin/env bash
# Run Collaborator locally: backend (uvicorn, auto-reload) and the Vite dev
# server in one terminal. Ctrl-C stops both.
#
#   ./dev.sh
#
# First run: creates backend/.venv and installs requirements, runs npm install
# in frontend/. Needs config.yaml (copy config.yaml.example) and, with
# authentication on, a passkey (cd backend && .venv/bin/python data/passkey.py create).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
VENV="$ROOT/backend/.venv"

[ -f config.yaml ] || {
    echo "config.yaml not found. Copy config.yaml.example and edit inference.endpoint_url." >&2
    exit 1
}

if [ ! -x "$VENV/bin/uvicorn" ]; then
    echo "== Creating backend/.venv and installing requirements"
    [ -x "$VENV/bin/pip" ] || python3 -m venv "$VENV" || true
    [ -x "$VENV/bin/pip" ] || {
        echo "python3 -m venv could not create a venv with pip (on Debian/Ubuntu: sudo apt install python3-venv)" >&2
        exit 1
    }
    "$VENV/bin/pip" install --quiet -r backend/requirements.txt
fi
if [ ! -d frontend/node_modules ]; then
    echo "== Installing frontend dependencies"
    ( cd frontend && npm install --no-audit --no-fund )
fi

PORT="$(grep -E '^[[:space:]]*backend_port:' config.yaml 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
PORT="${PORT:-8001}"

# Stop both children when this script exits for any reason.
trap 'trap - TERM INT; kill 0 2>/dev/null' EXIT INT TERM

echo "== Backend  http://127.0.0.1:$PORT   (API docs at /docs)"
( cd backend && exec "$VENV/bin/uvicorn" main:app --host 127.0.0.1 --port "$PORT" --reload ) &

echo "== Frontend http://localhost:3000   (proxies /api to the backend)"
( cd frontend && VITE_BACKEND_URL="http://127.0.0.1:$PORT" exec npm run dev ) &

wait
