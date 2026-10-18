"""Collaborator's side of the inference switch: a client for the gate's
control API (gate/docs/CONTROL_API.md, api_version 1).

The gate runs on the Mac and holds the background agents' requests while
paused; Collaborator calls LM Studio directly and only toggles the gate. The
token stays here, never sent to the browser. A gate that's down or
misconfigured never blocks anything: callers get {online: False, error}.
"""

import time
from typing import Dict, Optional

import requests

from config import get_config

KNOWN_API_VERSION = 1

# When the user last flipped the switch (monotonic), so stops it causes can
# be told apart from real ones (UX doc, Notifications: stops I caused don't
# notify).
_last_flip: Optional[float] = None


def _cfg() -> Dict:
    return ((get_config().get("inference") or {}).get("gate") or {})


def configured() -> bool:
    return bool((_cfg().get("url") or "").strip())


def _call(method: str, action: str) -> Dict:
    cfg = _cfg()
    url = (cfg.get("url") or "").strip().rstrip("/")
    headers = {"Authorization": f"Bearer {cfg.get('token') or ''}"}
    try:
        r = requests.request(method, f"{url}/gate/{action}", headers=headers,
                             timeout=float(cfg.get("timeout", 3)))
    except requests.exceptions.RequestException as e:
        return {"online": False, "error": f"gate unreachable ({e.__class__.__name__})"}
    if r.status_code == 401:
        return {"online": False, "error": "the gate refused the token "
                                          "(inference.gate.token)"}
    try:
        r.raise_for_status()
        data = r.json()
    except (requests.exceptions.RequestException, ValueError):
        return {"online": False, "error": f"gate error (HTTP {r.status_code})"}
    out = {"online": True,
           "paused": bool(data.get("paused")),
           "paused_since": data.get("paused_since"),
           "queued": int(data.get("queued") or 0),
           "in_flight": int(data.get("in_flight") or 0),
           "api_version": data.get("api_version")}
    if data.get("api_version") != KNOWN_API_VERSION:
        out["warning"] = f"unknown gate api_version {data.get('api_version')!r}"
    return out


def status() -> Dict:
    """For the switch: {configured, online, paused, queued, in_flight, ...}."""
    if not configured():
        return {"configured": False}
    return {"configured": True, **_call("GET", "status")}


def set_paused(paused: bool) -> Dict:
    """Pause (Collaborator only) or resume (all requests)."""
    global _last_flip
    if not configured():
        return {"configured": False}
    out = _call("POST", "pause" if paused else "resume")
    if out.get("online"):
        _last_flip = time.monotonic()
    return {"configured": True, **out}


def flipped_within(seconds: float) -> bool:
    """True when the user flipped the switch in the last `seconds`: a stop
    the agents report around then was caused by the user, and doesn't
    notify (the agent_stops producer, once the agent team exists)."""
    return _last_flip is not None and time.monotonic() - _last_flip <= seconds
