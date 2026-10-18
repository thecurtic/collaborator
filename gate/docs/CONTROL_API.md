# Gate control API (api_version 1)

This is the contract between the gate and whatever toggles it. That is
Collaborator's inference switch, but anything that can send HTTP works.
Everything you need is on this page.

## Where Collaborator fits

Collaborator keeps calling LM Studio on port 1234 directly. It never sends
inference through the gate. It calls the gate only to pause, resume and read
status. The gate's own port, 8080 by default, is what the background agents
use.

## Auth

Every `/gate/*` call needs this header:

```
Authorization: Bearer <GATE_TOKEN>
```

`GATE_TOKEN` is set in the gate's `.env` on the Mac, and `install.sh`
generates one. Store it in Collaborator's settings (`config.yaml`:
`inference.gate.token`), never in code. A missing or wrong token gets `401`
and changes nothing.

## Endpoints

| Method | Path | Effect | Returns |
| --- | --- | --- | --- |
| `GET` | `/gate/status` | none | status object |
| `POST` | `/gate/pause` | `paused = true` | status object |
| `POST` | `/gate/resume` | `paused = false`, releases held requests in arrival order | status object |

Errors:
- `401`: missing or wrong token.
- `405`: wrong method, for example `GET /gate/pause`.
- `404`: unknown `/gate/` path.

Every response is `application/json` and comes back immediately, without
ever waiting on LM Studio. `/gate/*` requests are never gated or forwarded.

```bash
curl -s -H "Authorization: Bearer $GATE_TOKEN" http://<mac-tailnet-name>:8080/gate/status
curl -s -X POST -H "Authorization: Bearer $GATE_TOKEN" http://<mac-tailnet-name>:8080/gate/pause
curl -s -X POST -H "Authorization: Bearer $GATE_TOKEN" http://<mac-tailnet-name>:8080/gate/resume
```

The status object:

```json
{
  "api_version": 1,
  "paused": true,
  "paused_since": "2026-09-28T19:42:10Z",
  "queued": 2,
  "in_flight": 1,
  "total_forwarded": 318
}
```

| Field | Meaning |
| --- | --- |
| `paused` | whether new agent requests are being held |
| `paused_since` | ISO 8601 UTC time of the pause, or `null` |
| `queued` | requests the gate is holding right now |
| `in_flight` | requests forwarded and not yet finished |
| `total_forwarded` | counter since the gate started |

## Semantics

- Pause holds only new agent `POST`s. A request already in flight finishes,
  so Collaborator's first reply after pausing can wait on it.
- Pause and resume are idempotent. Pausing twice keeps the first
  `paused_since`.
- `paused` is not saved anywhere. If the gate restarts, it comes back
  unpaused.

## Recommended UI

- A pause/resume switch that shows the current state in words.
- A small indicator driven by `queued` and `in_flight`.
- Poll `/gate/status` every 2–5 seconds while the switch is on screen.

## Failure handling

If the gate is unreachable, show the switch as "gate offline" and let chat
carry on. A gate failure must never block Collaborator, because Collaborator
doesn't depend on the gate to talk to the model.

## Versioning

Check `api_version`. On a value you don't know, warn, and keep using only the
fields documented here. Changes are listed in [../CHANGELOG.md](../CHANGELOG.md).

## Reference client (Python)

```python
import requests

class Gate:
    def __init__(self, url: str, token: str, timeout: float = 3.0):
        self.url = url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {token}"}
        self.timeout = timeout

    def _call(self, method: str, action: str) -> dict:
        r = requests.request(method, f"{self.url}/gate/{action}",
                             headers=self.headers, timeout=self.timeout)
        r.raise_for_status()
        status = r.json()
        if status.get("api_version") != 1:
            print(f"warning: unknown gate api_version {status.get('api_version')}")
        return status

    def get_status(self) -> dict:
        return self._call("GET", "status")

    def pause(self) -> dict:
        return self._call("POST", "pause")

    def resume(self) -> dict:
        return self._call("POST", "resume")
```
