# inference-gate

A small reverse proxy on the inference Mac. It lets the background coding
agents share LM Studio, but holds their requests whenever Collaborator wants
the model to itself.

This folder is self-contained. It imports nothing from the rest of the
Collaborator repository, so you can pull the repo onto the Mac, keep `gate/`
and delete the rest.

```
agents (VMs) ──► gate :8080 ──► LM Studio :1234 ◄── Collaborator (direct)
                    ▲
                    └── Collaborator's switch: /gate/pause, /gate/resume
```

Collaborator never goes through the gate. It keeps calling LM Studio directly
and only talks to the gate to pause, resume or read status.

## What it does

- Forwards everything under `/v1/*` to LM Studio unchanged, minus hop-by-hop
  headers. Responses stream back as they arrive, SSE included, with no read
  timeout.
- Only `POST` is gated. While paused, a new `POST` is held open with nothing
  sent back, and the held requests are released in arrival order on resume.
  `GET` requests such as `/v1/models` always pass, so agents can start up
  while it's paused.
- Pausing never cancels anything. Requests already streaming finish
  normally.
- A held client that disconnects is dropped and never forwarded.
- `paused` lives in memory only and starts `false`, so a restart resumes the
  agents.

## Install (macOS)

Needs Python 3.11 or newer.

```bash
cd gate
./install.sh
```

`install.sh` does the following:

1. Creates `.venv` and installs `requirements.txt` (just aiohttp).
2. Copies `.env.example` to `.env` if there's no `.env` yet.
3. Generates a `GATE_TOKEN` when `.env` has none, and prints it.
4. Writes `~/Library/LaunchAgents/local.inference-gate.plist` (`RunAtLoad`
   and `KeepAlive`) and loads it with `launchctl`.

Re-running it reinstalls and restarts the gate. It keeps your `.env`.

Put the printed token in Collaborator's `config.yaml`:

```yaml
inference:
  gate:
    url: "http://<mac-tailnet-name>:8080"
    token: "<GATE_TOKEN>"
```

Restart or stop it:

```bash
launchctl kickstart -k gui/$(id -u)/local.inference-gate   # restart
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/local.inference-gate.plist  # stop
```

## Configuration

All configuration is environment variables, read from `.env` by the launchd
agent.

| Variable | Default | Notes |
| --- | --- | --- |
| `GATE_HOST` | `0.0.0.0` | Must be reachable over the tailnet |
| `GATE_PORT` | `8080` | What the agents point at |
| `UPSTREAM_URL` | `http://127.0.0.1:1234` | LM Studio's OpenAI-compatible server |
| `GATE_TOKEN` | none, required | The gate refuses to start without it |
| `MAX_CONCURRENT_UPSTREAM` | unset (unlimited) | Optional cap on requests in flight |
| `LOG_LEVEL` | `INFO` | |

## Pointing the agents at it

Do this on each agent VM, and verify it on one VM before doing the other
three:

1. In pi's provider config, comment out the commercial (OpenRouter) provider
   entry and uncomment the local one.
2. Set the local provider's base URL to `http://<mac-tailnet-name>:8080/v1`,
   not port 1234.
3. Set the model id to exactly what LM Studio's `/v1/models` reports for the
   loaded model.
4. Remove or raise any client request timeout, so a request held for an
   hour is still waiting when it's released.
5. Start with a context window of about 32k, and raise it only if the
   agents lose the thread.

The exact file paths and field names depend on your pi install. They
weren't verified while building this, so record them here once you've done
the first VM.

The agents could skip the gate entirely by calling port 1234 directly. To
stop that, use a Tailscale ACL that allows 1234 only from Collaborator's
host.

## Logs

The log is `~/Library/Logs/inference-gate.log`. Each request gets a short id
and one line per event: `arrival`, `held`, `released`, `finished <status> in
<seconds>`, and `client disconnected`. Every pause and resume is logged with
its time and the caller's IP. A warning appears when more than 8 requests are
held. To trace a stuck agent, search the log for its request id.

## Tests

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

The tests run against a fake upstream that streams slowly. They cover:

- unpaused streaming matches a direct call;
- a paused `POST` is held while `GET` still passes;
- a pause during a stream lets that stream finish;
- held requests are released in arrival order;
- a held client that disconnects is never forwarded;
- a long hold still completes;
- the token is required, and pause and resume are idempotent;
- a down upstream gives a `502`, not a hang.

Still to check by hand:

- after `launchctl kickstart -k` or a reboot, the gate comes back up
  unpaused;
- one real agent task completes through the gate, with a pause and resume
  in the middle.

The control API Collaborator uses is in [docs/CONTROL_API.md](docs/CONTROL_API.md).
