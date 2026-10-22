# Deploying Collaborator

One server runs everything: the Python backend, the built frontend (static
files behind a reverse proxy), and whatever inference server you point it at.

## Prerequisites

- Linux host with Python 3.10 to 3.12, Node 20+, git, ffmpeg. On a system
  whose default Python is 3.13 (Ubuntu 25.04 and later), install 3.12 beside
  it (Ubuntu: the deadsnakes PPA) and create the venv with
  `python3.12 -m venv backend/.venv`.
- An OpenAI-compatible inference endpoint reachable from the server (LM Studio,
  llama.cpp, vLLM, …).
- A reverse proxy for TLS (Caddy, nginx, Tailscale Serve, …). The PWA, the
  microphone and the service worker all require a secure origin.

## First install

```bash
sudo mkdir -p /srv/collaborator && sudo chown "$USER" /srv/collaborator
git clone <your-remote> /srv/collaborator
cd /srv/collaborator
cp config.yaml.example config.yaml
$EDITOR config.yaml                # inference.endpoint_url, server.cors_origins, …
```

Create the backend environment and your passkey:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cd backend && .venv/bin/python data/passkey.py create && cd ..
```

Authentication is on by default; without a passkey every request is refused,
so this step is not optional.

Install the backend as a service (edit `User=` and the paths first):

```bash
sudo cp deploy/collaborator-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now collaborator-backend
```

A systemd **user** unit works too (drop the `User=` line, put the file in
`~/.config/systemd/user/`, use `systemctl --user` and `loginctl enable-linger`).
`deploy.sh` and `restart.sh` find either kind.

Build the frontend and put it behind your proxy. `deploy/Caddyfile.example`
serves `frontend/dist` and routes `/api/*` to the backend on port 8001; any
static server plus proxy works the same way (WebSockets must be passed through
for voice).

```bash
./deploy.sh
```

## Updating

```bash
cd /srv/collaborator && ./deploy.sh
```

The script pulls, installs backend requirements, upgrades yt-dlp, builds the
frontend, restarts the backend unit (or falls back to `./restart.sh`) and waits
for `/api/health`. Flags: `SKIP_PULL=1`, `SKIP_FRONTEND=1`. If a dedicated
static server runs as a systemd unit, name it in `FRONTEND_SERVICE` and the
script restarts it too.

## Configuration

Everything machine-specific lives in the gitignored `config.yaml`:

- `inference.endpoint_url`, `inference.model_id`
- `server.backend_port`, `server.cors_origins` (add your public origin)
- `authentication.enabled`, `authentication.passkeys_db_path`
- `tools.*`: web search provider and key, fetch proxy, transcription limits,
  wallet keys. Every secret the app holds is in this file.
- `agents.listen`: where agent endpoints connect (see below).

## Agent endpoints

Agent backends (API-SPEC.md §26) connect to their own listener, not the
app's port. Set `agents.listen` to this box's tailnet address, for example
`<tailnet-ip>:8765`, and configure each endpoint with
`ws://<tailnet-ip>:8765`. Don't add it to any reverse-proxy block: endpoints
reach it over the tailnet only. A new endpoint shows its fingerprint and waits
in Settings → Agents until you approve it, once. To try the UI without real
agents, run the fake endpoint from the dev box:
`backend/.venv/bin/python backend/dev/fake_endpoint.py ws://<tailnet-ip>:8765 --scenario team`
(scenarios: team, solo, drop, silent, multi, unmatched).

User data lives under `backend/data/users/<identity-hash>/`: the SQLite
database and the notes vault. Back that directory up, plus `config.yaml` and
`backend/data/authentication/passkeys.db`.

## Note migrations

Some releases change the notes format (`NOTES-FORMAT.md` dates each change).
When one needs existing vaults rewritten, run its migration once after
deploying. Each is safe to re-run, and `--dry-run` shows what would change.

```bash
cd backend
.venv/bin/python data/migrate_notes.py --dry-run   # 2026-10-12: strip state/due
.venv/bin/python data/migrate_notes.py
```

## Passkeys

```bash
cd backend
.venv/bin/python data/passkey.py create
.venv/bin/python data/passkey.py list
.venv/bin/python data/passkey.py rotate <old-hash>   # new passkey, same data
.venv/bin/python data/passkey.py revoke <hash>
```

`rotate` issues a new passkey for an existing identity, moves nothing on disk,
and logs every device out. The identity hash printed at creation is what
`tools.wallet.lnbits.wallets` (and the dormant `tools.nwc.connections`) are
keyed by.

## Android shell

The APK is a WebView pointed at your deployment. Set the URL when syncing:

```bash
cd frontend
COLLABORATOR_URL=https://collaborator.example.com npm run android:sync
cd android && ./gradlew assembleDebug
```

## Health

```bash
curl -s http://localhost:8001/api/health
journalctl -u collaborator-backend -f
```
