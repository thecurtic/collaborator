#!/bin/sh
# Install the gate as a launchd user agent on this Mac: venv, dependencies,
# .env (with a generated token if none), the plist, and load it. Safe to
# re-run: it reinstalls and restarts the agent, keeping your .env.
set -eu

GATE_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="local.inference-gate"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/inference-gate.log"
PYTHON="${PYTHON:-python3}"

echo "Gate folder: $GATE_DIR"
"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || { echo "Python 3.11+ is required (set PYTHON=/path/to/python3)"; exit 1; }

[ -d "$GATE_DIR/.venv" ] || "$PYTHON" -m venv "$GATE_DIR/.venv"
"$GATE_DIR/.venv/bin/pip" install -q --upgrade pip
"$GATE_DIR/.venv/bin/pip" install -q -r "$GATE_DIR/requirements.txt"

if [ ! -f "$GATE_DIR/.env" ]; then
  cp "$GATE_DIR/.env.example" "$GATE_DIR/.env"
  echo "Created .env from .env.example"
fi
if ! grep -q '^GATE_TOKEN=..*' "$GATE_DIR/.env"; then
  TOKEN="$(openssl rand -hex 32)"
  sed -i '' "s/^GATE_TOKEN=.*/GATE_TOKEN=$TOKEN/" "$GATE_DIR/.env"
  echo "Generated GATE_TOKEN. Put this in Collaborator's config.yaml as inference.gate.token:"
  echo "  $TOKEN"
fi
chmod 600 "$GATE_DIR/.env"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__GATE_DIR__|$GATE_DIR|g" -e "s|__LOG__|$LOG|g" \
  "$GATE_DIR/local.inference-gate.plist" > "$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Loaded $LABEL. Logs: $LOG"
echo "Check it:  curl -s -H \"Authorization: Bearer \$GATE_TOKEN\" http://127.0.0.1:\${GATE_PORT:-8080}/gate/status"
