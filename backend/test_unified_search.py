"""Unified search: every pile at once, scoped, and never the model's."""

import importlib
import inspect
import json
import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
from starlette.testclient import TestClient


def _fresh():
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(tempfile.mkdtemp(), "vault")
    cfg["notes"]["bootstrap_user_note"] = False
    cfg["scratch"]["link_previews"] = False
    config.get_config._config = cfg
    import db, main
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    main.stream_llm_tokens = lambda *a, **kw: iter(["Mulch keeps the soil damp."])
    return TestClient(main.app), main, path


def _done(resp):
    events = [json.loads(l[6:]) for l in resp.text.splitlines() if l.startswith("data: ")]
    return next(e for e in events if e["type"] == "done")


def test_one_search_over_every_pile():
    c, main, dbp = _fresh()
    d = _done(c.post("/api/messages", json={"message": "how deep should compost mulch go?"}))
    c.post("/api/messages", json={"message": "unrelated question about bikes"})
    c.post("/api/scratch", json={"content": "buy compost bags saturday"})
    c.post("/api/scratch", json={"content": "call the bank"})
    att = c.post("/api/attachments", files={"file": ("beds.txt", b"compost ratio 3:1",
                                                      "text/plain")}).json()["attachment"]
    c.post("/api/events", json={"title": "Compost day", "start": "2026-11-01T10:00",
                                "end": "2026-11-01T11:00"})
    conn = sqlite3.connect(dbp)
    conn.execute("INSERT INTO transcripts (url, title, status, text, channel) VALUES "
                 "(?, ?, 'done', ?, ?)", ("https://youtu.be/x", "Garden basics",
                                         "today we turn the compost pile", "Plot"))
    conn.commit()
    conn.close()
    import time
    for _ in range(100):
        if c.get(f"/api/attachments/{att['id']}").json()["attachment"]["text_status"] == "done":
            break
        time.sleep(0.05)

    r = c.get("/api/find", params={"q": "compost"}).json()
    scopes = [g["scope"] for g in r["groups"]]
    assert scopes == ["chats", "notes", "scratch", "transcripts", "attachments"]
    assert next(g for g in r["groups"] if g["scope"] == "notes")["items"][0]["title"] == "Compost day"
    assert next(g for g in r["groups"] if g["scope"] == "attachments")["items"][0]["title"] == "beds.txt"
    chat = r["groups"][0]["items"][0]
    assert chat["type"] == "chat" and chat["matches"] >= 1 and "compost" in chat["snippet"].lower()
    assert chat["id"] == chat["turn_id"] or chat["turn_id"] >= chat["id"]
    scratch = next(g for g in r["groups"] if g["scope"] == "scratch")
    assert scratch["total"] == 1 and "compost" in scratch["items"][0]["title"]
    tr = next(g for g in r["groups"] if g["scope"] == "transcripts")["items"][0]
    assert tr["title"] == "Garden basics" and "compost" in tr["snippet"]

    # Scoped: the same search, one pile.
    only = c.get("/api/find", params={"q": "compost", "scope": "scratch"}).json()
    assert [g["scope"] for g in only["groups"]] == ["scratch"]
    # All words must match in Scratch.
    assert c.get("/api/find", params={"q": "compost bank", "scope": "scratch"}).json()["groups"] == []
    assert c.get("/api/find", params={"q": "x", "scope": "web"}).status_code == 422
    assert c.get("/api/find", params={"q": ""}).json()["groups"] == []


def test_named_or_tagged_chat_is_found_by_its_name():
    c, main, dbp = _fresh()
    d = _done(c.post("/api/messages", json={"message": "first message"}))
    root = d["user_turn_id"]
    assert c.patch(f"/api/turns/{root}/name", json={"name": "Greenhouse plans"}).status_code == 200
    item = c.get("/api/find", params={"q": "greenhouse"}).json()["groups"][0]["items"][0]
    assert item["id"] == root and item["title"] == "Greenhouse plans"


def test_scratch_never_reaches_the_model():
    """The line the UX doc draws: unified search is mine. No model tool may
    call it, and the agent's own searches still can't see Scratch."""
    c, main, dbp = _fresh()
    c.post("/api/scratch", json={"content": "PRIVATEWORD scratch only"})
    assert c.get("/api/find", params={"q": "PRIVATEWORD"}).json()["groups"][0]["scope"] == "scratch"
    schemas, execute, _ = main._build_tools(dbp)
    for s in schemas:
        name = s["function"]["name"]
        args = {"query": "PRIVATEWORD"}
        try:
            out = execute(name, args)
        except Exception:
            continue
        assert "PRIVATEWORD" not in str(out), f"tool {name} reached Scratch"
    import agent_tools, inference
    for mod in (agent_tools, inference):
        assert "unified_search" not in inspect.getsource(mod)
    assert "unified_search" not in inspect.getsource(main._build_tools)
