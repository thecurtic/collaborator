"""Security hardening (2026-10-13 review): fetch_url redirect hops are
re-checked, the passkey lockout counts per client behind trusted proxies,
/api/transcribe uses the shared auth, wildcard CORS is refused, and a
streaming STT session has a length cap."""

import importlib
import json
import os
import tempfile

import pytest

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import auth, inference, main
importlib.reload(main)
from starlette.testclient import TestClient


# --- fetch_url: every redirect hop is checked ------------------------------------

class _Resp:
    def __init__(self, status, location=None, body=b"<html><title>T</title>ok</html>"):
        self.status_code = status
        self.headers = {"location": location} if location else {"content-type": "text/html"}
        self.is_redirect = status in (301, 302, 303, 307, 308) and bool(location)
        self.url = None
        self.encoding = 'utf-8'
        self.apparent_encoding = 'utf-8'
        self._body = body
    def raise_for_status(self): pass
    def iter_content(self, n): yield self._body
    def close(self): pass


def _fake_web(monkeypatch, routes):
    seen = []
    def get(url, **kw):
        assert kw.get("allow_redirects") is False      # never automatic
        seen.append(url)
        resp = routes[url]
        resp.url = url
        return resp
    monkeypatch.setattr(inference.requests, "get", get)
    private = {"127.0.0.1", "169.254.169.254", "100.64.0.9", "internal.lan"}
    monkeypatch.setattr(inference, "_host_is_private", lambda h: h in private)
    monkeypatch.setitem(inference._tools_config().setdefault("fetch_url", {}),
                        "webtool_url", None)
    return seen


def test_redirect_to_private_address_is_refused(monkeypatch):
    seen = _fake_web(monkeypatch, {
        "https://public.example/a": _Resp(302, "http://169.254.169.254/latest/meta-data/"),
    })
    out = inference.fetch_url("https://public.example/a")
    assert "private/internal" in out["error"]
    assert seen == ["https://public.example/a"]          # the hop was never fetched

    seen = _fake_web(monkeypatch, {
        "https://public.example/b": _Resp(301, "/c"),
        "https://public.example/c": _Resp(302, "http://internal.lan:8080/admin"),
    })
    assert "private/internal" in inference.fetch_url("https://public.example/b")["error"]

    seen = _fake_web(monkeypatch, {
        "https://public.example/d": _Resp(302, "file:///etc/passwd"),
    })
    assert "non-http(s)" in inference.fetch_url("https://public.example/d")["error"]
    print("✓ redirects to private, internal or non-http targets are refused")


def test_public_redirects_still_work_and_loops_stop(monkeypatch):
    seen = _fake_web(monkeypatch, {
        "https://short.example/x": _Resp(301, "https://site.example/page"),
        "https://site.example/page": _Resp(200),
    })
    out = inference.fetch_url("https://short.example/x")
    assert "error" not in out and seen[-1] == "https://site.example/page"

    loop = {f"https://loop.example/{i}": _Resp(302, f"https://loop.example/{i + 1}")
            for i in range(10)}
    _fake_web(monkeypatch, loop)
    assert "too many redirects" in inference.fetch_url("https://loop.example/0")["error"]

    # allow_private keeps working for tailnet docs.
    _fake_web(monkeypatch, {
        "https://public.example/e": _Resp(302, "http://100.64.0.9/doc"),
        "http://100.64.0.9/doc": _Resp(200),
    })
    monkeypatch.setitem(inference._tools_config()["fetch_url"], "allow_private", True)
    assert "error" not in inference.fetch_url("https://public.example/e")
    print("✓ public redirects followed; loops capped; allow_private honoured")


# --- Lockout: per client, headers trusted only from configured proxies ------------

class _H(dict):
    def get(self, k, d=None):
        return super().get(k.lower(), d)


def test_client_key_trusts_headers_only_from_proxies(monkeypatch):
    acfg = config.get_config()["authentication"]
    monkeypatch.setitem(acfg, "trusted_proxies", [])
    spoof = _H({"cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "7.7.7.7"})
    assert auth.client_key("203.0.113.5", spoof) == "203.0.113.5"   # untrusted peer

    monkeypatch.setitem(acfg, "trusted_proxies", ["127.0.0.1", "100.64.0.0/10"])
    assert auth.client_key("127.0.0.1", _H({"cf-connecting-ip": "198.51.100.7"})) == "198.51.100.7"
    # Right-most hop that isn't a trusted proxy.
    xff = _H({"x-forwarded-for": "6.6.6.6, 198.51.100.8, 100.64.1.2"})
    assert auth.client_key("127.0.0.1", xff) == "198.51.100.8"
    assert auth.client_key("127.0.0.1", _H({})) == "127.0.0.1"
    assert auth.client_key("203.0.113.5", spoof) == "203.0.113.5"   # still untrusted
    print("✓ client address: forwarding headers trusted only from trusted proxies")


def test_lockout_is_per_client(monkeypatch):
    acfg = config.get_config()["authentication"]
    monkeypatch.setitem(acfg, "lockout_threshold", 3)
    monkeypatch.setitem(acfg, "lockout_base_seconds", 60)
    auth._reset_lockout_for_tests()
    for _ in range(3):
        auth.record_auth_failure("198.51.100.1")
    assert auth.lockout_remaining("198.51.100.1") > 0
    assert auth.lockout_remaining("198.51.100.2") == 0      # others unaffected
    auth.record_auth_success("198.51.100.1")
    assert auth.lockout_remaining("198.51.100.1") == 0
    auth._reset_lockout_for_tests()
    print("✓ one client's failures never lock out another")


def test_lockout_table_is_bounded(monkeypatch):
    auth._reset_lockout_for_tests()
    monkeypatch.setattr(auth, "_LOCKOUT_MAX_CLIENTS", 50)
    for i in range(200):
        auth.record_auth_failure(f"10.9.{i // 250}.{i % 250}")
    assert len(auth._lockouts) <= 50
    auth._reset_lockout_for_tests()
    print("✓ the lockout table can't grow without bound")


def test_transcribe_counts_toward_lockout_and_accepts_sessions(monkeypatch):
    acfg = config.get_config()["authentication"]
    monkeypatch.setitem(acfg, "lockout_threshold", 2)
    monkeypatch.setattr(main, "auth_enabled", True)
    monkeypatch.setattr(main, "validate_passkey", lambda p: False)
    auth._reset_lockout_for_tests()
    c = TestClient(main.app)
    files = {"audio": ("a.wav", b"RIFF", "audio/wav")}
    for _ in range(2):
        r = c.post("/api/transcribe", files=files, headers={"X-Passkey": "wrong"})
        assert r.status_code == 403
    r = c.post("/api/transcribe", files=files, headers={"X-Passkey": "wrong"})
    assert r.status_code == 429                              # lockout now applies here

    # A session satisfies it (previously only X-Passkey did).
    monkeypatch.setattr(auth, "validate_session", lambda t: ("hash", 1))
    r = c.post("/api/transcribe", files=files, headers={"X-Session": "tok"})
    assert r.status_code not in (403, 429)
    auth._reset_lockout_for_tests()
    print("✓ /api/transcribe uses the shared auth (sessions + lockout)")


# --- CORS -------------------------------------------------------------------------

def test_wildcard_cors_is_refused():
    cfg = config.get_config()
    saved = cfg["server"].get("cors_origins")
    cfg["server"]["cors_origins"] = ["https://app.example", "*"]
    try:
        with pytest.raises(RuntimeError, match="cors_origins"):
            importlib.reload(main)
    finally:
        cfg["server"]["cors_origins"] = saved
        importlib.reload(main)
    print("✓ a wildcard CORS origin stops startup")


# --- Streaming STT length cap -------------------------------------------------------

def test_stream_session_is_capped(monkeypatch):
    import voice
    monkeypatch.setattr(main, "auth_enabled", False)
    monkeypatch.setattr(voice, "ensure_stt_loaded", lambda: None)
    monkeypatch.setattr(voice, "decode_partial_pcm", lambda pcm, language=None: ("p", []))
    monkeypatch.setattr(voice, "decode_final_pcm",
                        lambda pcm, language=None: f"{len(pcm)} bytes")
    real = voice.stt_config
    monkeypatch.setattr(voice, "stt_config",
                        lambda: {**real(), "max_session_minutes": 1 / 60})  # 1 s
    c = TestClient(main.app)
    with c.websocket_connect("/api/transcribe/stream") as ws:
        ws.send_bytes(b"\x00" * (16000 * 2 * 2))           # 2 s > the 1 s cap
        msgs = []
        while True:
            m = ws.receive_json()
            msgs.append(m)
            if m["type"] == "final":
                break
    assert msgs[-1]["type"] == "final" and "bytes" in msgs[-1]["text"]
    print("✓ a streaming session past max_session_minutes finalizes and closes")
