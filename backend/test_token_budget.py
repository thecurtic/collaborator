"""Tests for the token-budget context trim (turns pick, tokens trim)."""

import json
import os
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, inference
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def test_estimate_and_context_detection(monkeypatch):
    import requests
    assert inference.estimate_tokens("") == 1
    assert inference.estimate_tokens("x" * 400) == 101

    class _R:
        def raise_for_status(self): pass
        def json(self):
            return {"data": [
                {"id": "minimax-m2.5", "state": "loaded",
                 "max_context_length": 196608, "loaded_context_length": 100000},
                {"id": "other", "max_context_length": 8192},
            ]}
    seen = {}
    def fake_get(url, timeout=None, **kw):
        seen["url"] = url
        return _R()
    monkeypatch.setattr(requests, "get", fake_get)
    inference._ctx_cache.clear()
    assert inference.get_model_context_tokens("minimax-m2.5") == 100000  # loaded wins
    assert seen["url"].endswith("/api/v0/models")
    assert inference.get_model_context_tokens("other") == 8192
    assert inference.get_model_context_tokens("missing") is None

    # Failure -> None (cached), never raises.
    inference._ctx_cache.clear()
    monkeypatch.setattr(requests, "get",
                        lambda *a, **k: (_ for _ in ()).throw(Exception("down")))
    assert inference.get_model_context_tokens("minimax-m2.5") is None
    inference._ctx_cache.clear()
    print("✓ token estimate + context detection (loaded > max, cached, safe)")


def test_trim_keeps_newest_within_budget(monkeypatch):
    # Small model: 10k context. Budget = 8000 - 2048 - 3000 - msg ≈ ~2950.
    monkeypatch.setattr(main, "get_model_context_tokens", lambda *a, **k: 10000)
    long_turn = {"role": "user", "content": "x" * 8000}      # ~2001 tokens each
    turns = [dict(long_turn, id=i) for i in range(5)]
    kept, dropped = main._trim_context_to_token_budget(turns, "short question")
    assert dropped == 4
    assert [t["id"] for t in kept] == [4]                    # newest survives
    # Plenty of room -> nothing dropped.
    monkeypatch.setattr(main, "get_model_context_tokens", lambda *a, **k: 200000)
    kept, dropped = main._trim_context_to_token_budget(turns, "q")
    assert dropped == 0 and len(kept) == 5
    # Even the newest too big -> empty context, never a crash.
    monkeypatch.setattr(main, "get_model_context_tokens", lambda *a, **k: 6000)
    kept, dropped = main._trim_context_to_token_budget(
        [dict(long_turn, id=9)], "q")
    assert kept == [] and dropped == 1
    print("✓ trim: oldest dropped first, roomy = untouched, oversized = empty")


def test_config_override_beats_detection(monkeypatch):
    called = {"n": 0}
    def detect(*a, **k):
        called["n"] += 1
        return 999999
    monkeypatch.setattr(main, "get_model_context_tokens", detect)
    mcfg = config.get_config()["memory"]
    monkeypatch.setitem(mcfg, "context_budget_tokens", 10000)
    long_turn = {"role": "user", "content": "x" * 8000}
    kept, dropped = main._trim_context_to_token_budget(
        [dict(long_turn, id=i) for i in range(5)], "q")
    assert dropped == 4 and called["n"] == 0        # override used, no detection
    print("✓ memory.context_budget_tokens overrides auto-detection")


def test_send_message_applies_trim(monkeypatch):
    import sqlite3
    monkeypatch.setattr(main, "get_model_context_tokens", lambda *a, **k: 10000)
    captured = {}
    def fake_stream(message, context_turns=None, mode=None, recall=None, **kw):
        captured["context"] = context_turns
        yield "ok"
    main.stream_llm_tokens = fake_stream

    path = os.environ["DB_PATH"]
    conn = sqlite3.connect(path)
    prev = None
    for i in range(4):
        t = db.create_turn(conn, None, "user" if i % 2 == 0 else "assistant",
                           "y" * 8000, parent_turn_id=prev)
        prev = t["id"]
    conn.close()

    c = TestClient(main.app)
    r = c.post("/api/messages", json={"message": "hi", "parent_turn_id": prev,
                                      "context_turns": 10})
    assert r.status_code == 200 and '"type": "done"' in r.text
    assert len(captured["context"]) == 1            # 4 candidates, budget keeps 1
    print("✓ /api/messages: turns window selected, token budget trimmed")
