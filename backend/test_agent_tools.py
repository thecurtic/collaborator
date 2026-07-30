"""Tests for agent_tools (calculator, git_read, transcribe_video, location)
and their executor wiring."""

import json
import os
import sqlite3
import sys
import tempfile
import types

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, agent_tools, inference
importlib.reload(db)
importlib.reload(main)


# --- calculator -----------------------------------------------------------------

def test_calculator_basics_and_safety():
    calc = agent_tools.calculate
    assert calc("2 + 3 * 4")["result"] == 14
    assert calc("(1200 * 1.07**10) / 12")["result"] == 1200 * 1.07**10 / 12
    assert abs(calc("sqrt(2) * sin(pi/4)")["result"] - 1.0) < 1e-9
    assert calc("factorial(10)")["result"] == 3628800
    assert calc("min(3, 1, 2)")["result"] == 1
    assert calc("sum([1, 2, 3.5])")["result"] == 6.5
    assert calc("-7 // 2")["result"] == -4

    assert "division by zero" in calc("1/0")["error"]
    assert "error" in calc("__import__('os')")
    assert "error" in calc("x + 1")
    assert "error" in calc("'a' * 3")
    assert "error" in calc("10**10**10")            # exponent guard
    assert "error" in calc("factorial(99999)")      # factorial guard
    assert "error" in calc("")
    print("✓ calculator: exact arithmetic, whitelisted funcs, hard safety walls")


# --- git_read (Gitea API mocked) ------------------------------------------------

class _Resp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


def test_git_read(monkeypatch):
    import requests
    cfg = config.get_config()["tools"]["git"]
    monkeypatch.setitem(cfg, "api_url", "http://forge:3000/api/v1")
    monkeypatch.setitem(cfg, "token", "ro-token")

    seen = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen["url"], seen["headers"] = url, headers
        if url.endswith("/user/repos"):
            return _Resp([{"full_name": "curtis/collaborator", "private": True,
                           "default_branch": "main", "description": "chat app"}])
        if url.endswith("/repos/curtis/collaborator/contents/"):
            return _Resp([{"name": "backend", "path": "backend", "type": "dir",
                           "size": 0}])
        if url.endswith("/contents/backend/main.py"):
            import base64
            return _Resp({"type": "file", "size": 11,
                          "content": base64.b64encode(b"hello = 'x'").decode()})
        return _Resp({}, status=404)

    monkeypatch.setattr(requests, "get", fake_get)

    repos = agent_tools.git_read("list_repos")
    assert repos["repos"][0]["name"] == "curtis/collaborator"
    assert seen["headers"]["Authorization"] == "token ro-token"

    files = agent_tools.git_read("list_files", repo="curtis/collaborator")
    assert files["entries"][0]["type"] == "dir"

    f = agent_tools.git_read("read_file", repo="curtis/collaborator",
                             path="backend/main.py")
    assert f["content"] == "hello = 'x'" and f["truncated"] is False

    missing = agent_tools.git_read("read_file", repo="curtis/collaborator",
                                   path="nope.txt")
    assert "not found" in missing["error"]
    assert "repo" in agent_tools.git_read("read_file")["error"]
    print("✓ git_read: token header, list/read, 404 -> clean error")


def test_git_403_surfaces_scope_hint(monkeypatch):
    import requests
    cfg = config.get_config()["tools"]["git"]
    monkeypatch.setitem(cfg, "api_url", "http://forge:3000/api/v1")
    monkeypatch.setitem(cfg, "token", "scopeless")

    class _Forbidden:
        status_code = 403
        text = '{"message":"token does not have at least one of required scope(s): [read:user]"}'

        def raise_for_status(self):
            err = requests.exceptions.HTTPError("403 Client Error")
            err.response = self
            raise err

    monkeypatch.setattr(requests, "get",
                        lambda *a, **k: _Forbidden())
    out = agent_tools.git_read("list_repos")
    assert "read:user" in out["error"]          # Gitea's own body surfaced
    assert "regenerate" in out["error"]         # our scope hint appended
    print("✓ git 403: response body + scope-regeneration hint surfaced")


def test_git_tool_self_gating(monkeypatch):
    cfg = config.get_config()["tools"]["git"]
    monkeypatch.setitem(cfg, "api_url", None)
    monkeypatch.setitem(cfg, "token", None)
    schemas, _, _ = main._build_tools(os.environ["DB_PATH"])
    assert "git_read" not in {s["function"]["name"] for s in schemas}

    monkeypatch.setitem(cfg, "api_url", "http://forge:3000/api/v1")
    monkeypatch.setitem(cfg, "token", "t")
    schemas, _, _ = main._build_tools(os.environ["DB_PATH"])
    assert "git_read" in {s["function"]["name"] for s in schemas}
    print("✓ git_read registers only when tools.git is configured")


# --- transcribe_video (yt-dlp + STT mocked) -------------------------------------

def _stub_video(monkeypatch, duration_s, transcript="hello world"):
    monkeypatch.setattr(agent_tools, "_probe_video",
                        lambda url: {"title": "Test Video",
                                     "duration_s": duration_s})
    monkeypatch.setattr(agent_tools, "_download_and_transcribe",
                        lambda url: transcript)


def test_transcribe_video_sync_and_cache(monkeypatch):
    _stub_video(monkeypatch, duration_s=300)   # 5 min -> sync
    dbp = os.environ["DB_PATH"]
    out = agent_tools.transcribe_video(dbp, "https://youtu.be/abc")
    assert out["status"] == "done" and out["transcript"] == "hello world"

    # Second ask hits the cache (no re-download even if the stub changed).
    monkeypatch.setattr(agent_tools, "_download_and_transcribe",
                        lambda url: (_ for _ in ()).throw(RuntimeError("no")))
    again = agent_tools.transcribe_video(dbp, "https://youtu.be/abc")
    assert again["status"] == "done" and again["transcript"] == "hello world"

    assert "error" in agent_tools.transcribe_video(dbp, "notaurl")
    print("✓ transcribe_video: sync path + cached re-ask")


def test_transcribe_video_background(monkeypatch):
    import threading
    done = threading.Event()
    dbp = os.environ["DB_PATH"]
    monkeypatch.setattr(agent_tools, "_probe_video",
                        lambda url: {"title": "Long Video", "duration_s": 3600})

    def slow_transcribe(url):
        done.set()
        return "long transcript"
    monkeypatch.setattr(agent_tools, "_download_and_transcribe", slow_transcribe)

    out = agent_tools.transcribe_video(dbp, "https://youtu.be/long1")
    assert out["status"] == "processing" and "background" in out["note"]
    assert done.wait(5)

    # Poll until the worker commits, then the same call returns the transcript.
    import time as _t
    for _ in range(50):
        again = agent_tools.transcribe_video(dbp, "https://youtu.be/long1")
        if again.get("status") == "done":
            break
        _t.sleep(0.1)
    assert again["status"] == "done" and again["transcript"] == "long transcript"

    # Over the hard cap -> clean refusal.
    monkeypatch.setattr(agent_tools, "_probe_video",
                        lambda url: {"title": "Epic", "duration_s": 250 * 3600})
    assert "cap" in agent_tools.transcribe_video(dbp, "https://youtu.be/epic")["error"]

    # Jobs surface via the endpoints.
    from starlette.testclient import TestClient
    c = TestClient(main.app)
    listing = c.get("/api/transcripts").json()
    assert listing["count"] >= 2
    assert all("text" not in t for t in listing["transcripts"])
    full = c.get(f"/api/transcripts/{listing['transcripts'][0]['id']}").json()
    assert "transcript" in full
    print("✓ transcribe_video: background job -> re-ask -> done; endpoints list jobs")


# --- location -------------------------------------------------------------------

def test_transcribe_video_error_surfaces_and_retries(monkeypatch):
    """A failed attempt must never masquerade as eternal 'processing': the next
    ask surfaces the error in its note and retries."""
    dbp = os.environ["DB_PATH"]
    monkeypatch.setattr(agent_tools, "_probe_video",
                        lambda url: {"title": "Failing", "duration_s": 120})
    monkeypatch.setattr(agent_tools, "_download_and_transcribe",
                        lambda url: (_ for _ in ()).throw(
                            RuntimeError("speaches unreachable")))
    first = agent_tools.transcribe_video(dbp, "https://youtu.be/fail1")
    assert "speaches unreachable" in first["error"]

    # Retry after the cause is fixed: succeeds and mentions the earlier failure.
    monkeypatch.setattr(agent_tools, "_download_and_transcribe",
                        lambda url: "recovered transcript")
    second = agent_tools.transcribe_video(dbp, "https://youtu.be/fail1")
    assert second["status"] == "done"
    assert second["transcript"] == "recovered transcript"
    assert "earlier attempt failed" in second["note"]
    print("✓ transcribe_video: errors surface + retry works (no eternal processing)")


def test_describe_location():
    raw = agent_tools.describe_location({"lat": 12.34567, "lon": -1.0,
                                         "accuracy": 20})
    assert raw == ("User location right now: 12.34567, -1.00000 (±20m). "
                   "Use only when relevant.")
    no_acc = agent_tools.describe_location({"lat": 40.0, "lon": -105.0})
    assert "±" not in no_acc and "40.00000, -105.00000" in no_acc
    assert agent_tools.describe_location({"lat": "x"}) == ""
    assert agent_tools.describe_location({}) == ""
    print("✓ location line: raw coordinates only, bad input safe")


def test_location_line_reaches_system_prompt():
    msgs = inference._build_messages("hi", [], extra_system="User location right now: at home.")
    # Dynamic content rides the LATE system message (prefix-cache friendly),
    # never the static head.
    assert "User location" not in msgs[0]["content"]
    assert "User location right now: at home." in msgs[-2]["content"]
    assert msgs[-2]["role"] == "system"
    msgs = inference._build_messages("hi", [], extra_system=None)
    assert all("User location" not in m["content"] for m in msgs)
    print("✓ location line lands in the late dynamic system message only")


# --- executor wiring ------------------------------------------------------------

def test_executor_wiring(monkeypatch):
    schemas, execute, _ = main._build_tools(os.environ["DB_PATH"])
    names = {s["function"]["name"] for s in schemas}
    assert {"calculate", "transcribe_video", "get_notes"} <= names

    result = json.loads(execute("calculate", {"expression": "6*7"}))
    assert result["result"] == 42

    monkeypatch.setattr(agent_tools, "transcribe_video",
                        lambda dbp, url: {"status": "done", "transcript": "t"})
    out = json.loads(execute("transcribe_video", {"url": "https://x"}))
    assert out["status"] == "done"
    print("✓ executor wiring: calculate/get_notes/transcribe_video registered")
