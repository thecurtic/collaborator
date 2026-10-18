"""The inference switch's backend: /api/gate against a stubbed gate (no
network). The gate itself has its own tests in gate/."""

import importlib
import os
import tempfile

import requests

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
from starlette.testclient import TestClient


class _Resp:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(str(self.status_code))


def _client(gate):
    cfg = config.load_config()
    cfg["inference"]["gate"] = gate
    config.get_config._config = cfg
    import db, main
    importlib.reload(db)
    importlib.reload(main)
    return TestClient(main.app), main


def test_unconfigured_switch_is_hidden():
    c, _ = _client({"url": None, "token": None})
    assert c.get("/api/gate").json() == {"configured": False}
    assert c.put("/api/gate", json={"paused": True}).status_code == 409


def test_status_pause_resume_and_token_stays_server_side(monkeypatch):
    c, main = _client({"url": "http://gate.example:8080/", "token": "tk", "timeout": 3})
    state = {"paused": False}
    calls = []

    def fake(method, url, headers, timeout):
        calls.append((method, url, headers["Authorization"]))
        if url.endswith("/pause"):
            state["paused"] = True
        elif url.endswith("/resume"):
            state["paused"] = False
        return _Resp(200, {"api_version": 1, "paused": state["paused"],
                           "paused_since": "2026-10-18T00:00:00Z" if state["paused"] else None,
                           "queued": 2, "in_flight": 1, "total_forwarded": 9})
    monkeypatch.setattr(main.gate_client.requests, "request", fake)

    s = c.get("/api/gate").json()
    assert s["configured"] and s["online"] and s["paused"] is False and s["queued"] == 2
    assert "tk" not in str(s)
    out = c.put("/api/gate", json={"paused": True}).json()
    assert out["paused"] is True and main.gate_client.flipped_within(5)
    assert c.put("/api/gate", json={"paused": False}).json()["paused"] is False
    assert calls[1] == ("POST", "http://gate.example:8080/gate/pause", "Bearer tk")


def test_offline_and_bad_token_never_raise(monkeypatch):
    c, main = _client({"url": "http://gate.example:8080", "token": "wrong"})

    def down(*a, **kw):
        raise requests.exceptions.ConnectionError("refused")
    monkeypatch.setattr(main.gate_client.requests, "request", down)
    s = c.get("/api/gate").json()
    assert s == {"configured": True, "online": False, "error": "gate unreachable (ConnectionError)"}
    assert c.put("/api/gate", json={"paused": True}).status_code == 502

    monkeypatch.setattr(main.gate_client.requests, "request",
                        lambda *a, **kw: _Resp(401, {"error": "unauthorized"}))
    assert "refused the token" in c.get("/api/gate").json()["error"]

    monkeypatch.setattr(main.gate_client.requests, "request",
                        lambda *a, **kw: _Resp(200, {"api_version": 2, "paused": False}))
    assert "unknown gate api_version" in c.get("/api/gate").json()["warning"]


def test_url_without_scheme_gets_http(monkeypatch):
    c, main = _client({"url": "gate.example:8080", "token": "tk"})
    seen = []

    def fake(method, url, headers, timeout):
        seen.append(url)
        return _Resp(200, {"api_version": 1, "paused": False})
    monkeypatch.setattr(main.gate_client.requests, "request", fake)
    assert c.get("/api/gate").json()["online"] is True
    assert seen == ["http://gate.example:8080/gate/status"]
