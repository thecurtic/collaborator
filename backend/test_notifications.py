"""Tests for the notification backbone: kinds + settings, the stored log,
suppression, ntfy delivery (mocked), and the transcript-ready producer."""

import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, notifications, agent_tools
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def _fresh(ntfy=None, app_url=None):
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notifications"]["ntfy"].update(ntfy or {})
    cfg["notifications"]["app_url"] = app_url
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), path


class _Sent:
    """Captures requests.post calls made by ntfy delivery."""
    def __init__(self, monkeypatch, fail=False):
        self.calls = []
        def post(url, json=None, headers=None, timeout=None):
            self.calls.append({"url": url, "json": json, "headers": headers})
            if fail:
                raise ConnectionError("refused")
            class R:
                def raise_for_status(self): pass
            return R()
        monkeypatch.setattr(notifications.requests, "post", post)


def test_settings_list_defaults_and_toggle():
    c, _ = _fresh()
    r = c.get("/api/notifications/settings").json()
    kinds = {k["kind"]: k for k in r["kinds"]}
    assert set(kinds) == {"agent_stops", "transcript_ready"}
    assert all(k["enabled"] for k in kinds.values())        # on by default
    assert kinds["transcript_ready"]["label"] and kinds["transcript_ready"]["description"]
    assert r["delivery"] == {"ntfy": False}

    r = c.put("/api/notifications/settings",
              json={"enabled": {"transcript_ready": False}}).json()
    assert {k["kind"]: k["enabled"] for k in r["kinds"]} == {
        "agent_stops": True, "transcript_ready": False}
    assert c.put("/api/notifications/settings",
                 json={"enabled": {"nope": True}}).status_code == 422
    print("✓ settings list: every kind optional, on by default, toggles persist")


def test_notify_stores_suppresses_and_respects_settings(monkeypatch):
    c, dbp = _fresh()
    sent = _Sent(monkeypatch)
    n = notifications.notify(dbp, "transcript_ready", "Transcript ready", "Beds",
                             link="?open=transcript:3", background=False)
    assert n["title"] == "Transcript ready" and n["delivered"] == "not configured"
    assert sent.calls == []                                 # nothing leaves the box

    assert notifications.notify(dbp, "agent_stops", "Stopped", user_caused=True,
                                background=False) is None
    c.put("/api/notifications/settings", json={"enabled": {"agent_stops": False}})
    assert notifications.notify(dbp, "agent_stops", "Stopped",
                                background=False) is None
    items = c.get("/api/notifications").json()["notifications"]
    assert [i["title"] for i in items] == ["Transcript ready"]
    try:
        notifications.notify(dbp, "bogus", "x")
        assert False
    except ValueError:
        pass
    print("✓ notify: stored; user-caused and disabled kinds dropped")


def test_ntfy_delivery(monkeypatch):
    c, dbp = _fresh(ntfy={"url": "https://ntfy.example/", "token": "tk",
                          "topics": {"default": "collab-abc"}},
                    app_url="https://app.example")
    sent = _Sent(monkeypatch)
    assert c.get("/api/notifications/settings").json()["delivery"] == {"ntfy": True}
    n = notifications.notify(dbp, "transcript_ready", "Transcript ready ✓",
                             "Raised beds", link="?open=transcript:3",
                             background=False)
    assert n["delivered"] == "ntfy"
    call = sent.calls[0]
    assert call["url"] == "https://ntfy.example"
    assert call["json"] == {"topic": "collab-abc", "title": "Transcript ready ✓",
                            "message": "Raised beds",
                            "click": "https://app.example/?open=transcript:3"}
    assert call["headers"] == {"Authorization": "Bearer tk"}

    r = c.post("/api/notifications/test")
    assert r.status_code == 200 and r.json() == {"delivered": "ntfy"}

    failing = _Sent(monkeypatch, fail=True)
    n = notifications.notify(dbp, "agent_stops", "Stopped", background=False)
    assert n["delivered"].startswith("ntfy failed") and "ntfy.example" not in n["delivered"]
    print("✓ ntfy: JSON publish, click link, bearer token, failures recorded")


def test_test_endpoint_needs_delivery():
    c, _ = _fresh()
    assert c.post("/api/notifications/test").status_code == 409
    # A topic for another user isn't this user's delivery.
    c, _ = _fresh(ntfy={"url": "https://ntfy.example", "topics": {"someone": "t"}})
    assert c.post("/api/notifications/test").status_code == 409
    print("✓ test send refuses when this user has no delivery")


def test_background_transcript_notifies(monkeypatch):
    import threading
    c, dbp = _fresh()
    done = threading.Event()
    seen = []
    real = notifications.notify
    def spy(*a, **k):
        seen.append((a, k))
        out = real(*a, **{**k, "background": False})
        done.set()
        return out
    monkeypatch.setattr(notifications, "notify", spy)
    monkeypatch.setattr(agent_tools, "_probe_video",
                        lambda url: {"title": "Long one", "duration_s": 3600,
                                     "channel": None})
    monkeypatch.setattr(agent_tools, "_download_and_transcribe", lambda url: "text")
    out = agent_tools.transcribe_video(dbp, "https://vimeo.com/9")
    assert out["status"] == "processing" and done.wait(5)
    (args, kwargs) = seen[0]
    assert args[1:3] == ("transcript_ready", "Transcript ready")
    assert kwargs["link"] == f"?open=transcript:{out['id']}"

    done.clear()
    monkeypatch.setattr(agent_tools, "_download_and_transcribe",
                        lambda url: (_ for _ in ()).throw(RuntimeError("Private video")))
    out = agent_tools.transcribe_video(dbp, "https://vimeo.com/10")
    assert done.wait(5)
    args, kwargs = seen[-1]
    assert args[2] == "Transcript failed" and "private" in args[3]
    print("✓ background transcripts notify on ready and on failure")
