"""Tests for the frontend request batch: draft provenance stamping, persisted
per-turn tool activity on GET /api/tree, and auto-generated conversation titles."""

import os
import json
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, inference
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def _fresh(tools_on=True, titles_on=False):
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["tools"]["enabled"] = tools_on
    cfg["titles"]["enabled"] = titles_on
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), cfg, path


def _scripted(rounds):
    calls = {"i": 0}
    def fake(payload):
        deltas = rounds[calls["i"]] if calls["i"] < len(rounds) else []
        calls["i"] += 1
        for d in deltas:
            yield ({}, d)
    return fake


def _tool_call(idx_id, name, arguments):
    return [{"tool_calls": [{"index": 0, "id": idx_id, "type": "function",
                             "function": {"name": name, "arguments": ""}}]},
            {"tool_calls": [{"index": 0, "function": {"arguments": arguments}}]}]


def _post_message(c, rounds, message="hi", parent=None):
    orig = inference._iter_stream_events
    inference._iter_stream_events = _scripted(rounds)
    try:
        body = {"message": message, "recall": True}
        if parent is not None:
            body["parent_turn_id"] = parent
        r = c.post("/api/messages", json=body)
    finally:
        inference._iter_stream_events = orig
    events = [json.loads(l[6:]) for l in r.text.splitlines() if l.startswith("data: ")]
    return events


def test_chat_drafts_get_source_turns_and_root():
    c, cfg, dbp = _fresh()
    rounds = [
        _tool_call("1", "propose_note", json.dumps(
            {"title": "Transit is freedom", "body": "Buses beat cars for me."})),
        [{"content": "Draft created for your review."}],
    ]
    events = _post_message(c, rounds, "note that down")
    done = next(e for e in events if e["type"] == "done")
    proposed = next(e for e in events if e["type"] == "drafts_proposed")["drafts"]

    conn = sqlite3.connect(dbp)
    draft = db.get_note_draft(conn, proposed[0]["id"])
    conn.close()
    assert draft["source_turns"] == [done["id"]]          # assistant turn id
    assert draft["tree_root_id"] == done["user_turn_id"]  # first exchange: user turn is root
    print("✓ chat-proposed drafts stamped with source_turns + tree_root_id")


def test_tool_activity_persisted_and_on_tree():
    c, cfg, dbp = _fresh()

    def ok_resp(url):
        class R:
            headers = {"content-type": "text/html"}
            encoding = "utf-8"
            def raise_for_status(self): pass
            def iter_content(self, n): yield b"<html><title>T</title><body>x</body></html>"
        R.url = url
        return R()

    class SearchResp:
        def raise_for_status(self): pass
        def json(self):
            return {"results": [{"title": "A", "url": "https://a.example/1",
                                 "content": "s", "engine": "brave"},
                                {"title": "B", "url": "https://b.example/2",
                                 "content": "s", "engine": "mojeek"}]}

    cfg["tools"]["web_search"]["url"] = "http://searx.test"
    rounds = [
        _tool_call("1", "web_search", json.dumps({"query": "transit ridership 2026"})),
        _tool_call("2", "fetch_url", json.dumps({"url": "https://a.example/1"})),
        [{"content": "Here's what I found."}],
    ]
    orig_get = inference.requests.get
    inference.requests.get = (lambda url, **k:
                              SearchResp() if "searx.test" in url else ok_resp(url))
    try:
        events = _post_message(c, rounds, "look this up")
    finally:
        inference.requests.get = orig_get
        cfg["tools"]["web_search"]["url"] = None
    done = next(e for e in events if e["type"] == "done")

    tree = TestClient(main.app).get("/api/tree").json()
    def find(nodes, tid):
        for n in nodes:
            if n["id"] == tid:
                return n
            hit = find(n.get("children") or [], tid)
            if hit:
                return hit
    node = find(tree["roots"] if isinstance(tree, dict) else tree, done["id"])
    tools = node["tools"]
    assert tools[0]["tool"] == "web_search"
    assert tools[0]["query"] == "transit ridership 2026"
    assert tools[0]["outcome"] == "ok" and tools[0]["count"] == 2
    assert tools[0]["urls"] == ["https://a.example/1", "https://b.example/2"]
    assert tools[1]["tool"] == "fetch_url"
    assert tools[1]["url"] == "https://a.example/1" and tools[1]["outcome"] == "ok"
    print("✓ tool activity persisted per turn and exposed as node.tools on the tree")


def test_titles_generated_lazily_and_on_demand():
    c, cfg, dbp = _fresh(tools_on=False, titles_on=True)
    cfg["titles"]["regenerate_after_turns"] = 6
    titles = {"n": 0}
    def fake_title(turns):
        titles["n"] += 1
        return f"Generated Title {titles['n']}"
    orig = main.generate_title
    main.generate_title = fake_title
    try:
        # First exchange: root gets a title.
        events = _post_message(c, [[{"content": "hello there"}]], "hi")
        done = next(e for e in events if e["type"] == "done")
        root_id = done["user_turn_id"]
        tree = c.get("/api/tree").json()
        roots = tree["roots"] if isinstance(tree, dict) else tree
        root = next(n for n in roots if n["id"] == root_id)
        assert root["title"] == "Generated Title 1"
        assert root.get("state", "seed") == "seed"     # seeds get titles too

        # Two more turns (4 total < 6): lazy — no regeneration.
        events = _post_message(c, [[{"content": "more"}]], "again", parent=done["id"])
        assert titles["n"] == 1

        # On-demand regeneration from any turn id in the tree.
        done2 = next(e for e in events if e["type"] == "done")
        r = c.post(f"/api/turns/{done2['id']}/title")
        assert r.status_code == 200
        assert r.json() == {"root_id": root_id, "title": "Generated Title 2"}

        # Unknown turn -> 404; failed generation -> 502.
        assert c.post("/api/turns/99999/title").status_code == 404
        main.generate_title = lambda turns: ""
        assert c.post(f"/api/turns/{root_id}/title").status_code == 502
    finally:
        main.generate_title = orig
    print("✓ titles: generated on first exchange, lazy after, on-demand endpoint")


def test_title_survives_promotion_and_name_wins_separately():
    c, cfg, dbp = _fresh(tools_on=False, titles_on=True)
    orig = main.generate_title
    main.generate_title = lambda turns: "Seed Title"
    try:
        events = _post_message(c, [[{"content": "hi"}]], "quick thought")
        root_id = next(e for e in events if e["type"] == "done")["user_turn_id"]
        # Promote seed -> tree; the title rides along (same root row).
        r = c.patch(f"/api/turns/{root_id}/state", json={"state": "tree"})
        assert r.status_code == 200
        # And a user-set name coexists without clobbering the generated title.
        c.patch(f"/api/turns/{root_id}/name", json={"name": "My Name"})
        roots = c.get("/api/tree").json()
        roots = roots["roots"] if isinstance(roots, dict) else roots
        root = next(n for n in roots if n["id"] == root_id)
        assert root["title"] == "Seed Title" and root["name"] == "My Name"
        assert root["state"] == "tree"
    finally:
        main.generate_title = orig
    print("✓ title survives seed->tree promotion; independent of user-set name")


if __name__ == "__main__":
    test_chat_drafts_get_source_turns_and_root()
    test_tool_activity_persisted_and_on_tree()
    test_titles_generated_lazily_and_on_demand()
    test_title_survives_promotion_and_name_wins_separately()
    print("\n✓ All frontend-batch tests passed!")
