"""Tests for chat-level tags, the three-dots card summary, and promotion by
deliberate acts (UX doc, Chats section)."""

import json
import os
import sqlite3
import tempfile


def _fresh_env():
    d = tempfile.mkdtemp()
    os.environ["AUTH_ENABLED"] = "false"
    os.environ["DB_PATH"] = os.path.join(d, "conversations.db")
    import config
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(d, "vault")
    config.get_config._config = cfg
    import importlib, db, main
    importlib.reload(db)
    importlib.reload(main)

    def fake_stream(message, context_turns=None, mode=None, recall=None, **kw):
        yield "ok"
    main.stream_llm_tokens = fake_stream
    from starlette.testclient import TestClient
    return main, db, TestClient(main.app), os.environ["DB_PATH"]


def _done(resp):
    return [json.loads(l[6:]) for l in resp.text.splitlines()
            if l.startswith("data: ") and '"done"' in l][0]


def _chat(c, n=2):
    """A seed chat of n exchanges; returns (root_id, leaf_id)."""
    first = _done(c.post("/api/messages", json={"message": "seed garden beds"}))
    root, leaf = first["user_turn_id"], first["id"]
    for i in range(n - 1):
        leaf = _done(c.post("/api/messages", json={
            "message": f"more {i}", "parent_turn_id": leaf}))["id"]
    return root, leaf


def _root_node(c, root_id):
    return next(r for r in c.get("/api/tree").json()["roots"] if r["id"] == root_id)


def test_tags_live_on_the_root_and_promote():
    main, db, c, _ = _fresh_env()
    root, leaf = _chat(c)
    assert _root_node(c, root)["state"] == "seed"

    # Any turn id resolves to the root; tags are normalized and deduped.
    r = c.put(f"/api/chats/{leaf}/tags",
              json={"tags": ["Project", "garden", "project", "Raised Beds"]})
    assert r.status_code == 200, r.text
    assert r.json()["tags"] == ["project", "garden", "raised-beds"]
    assert r.json()["root_id"] == root and r.json()["promoted"] is True

    node = _root_node(c, root)
    assert node["chat_tags"] == ["project", "garden", "raised-beds"]
    assert node["state"] == "tree"                       # whole tree promoted
    assert node["tags"] in (None, [], "")                # turn tags untouched
    assert c.get(f"/api/chats/{root}").json()["tags"] == ["project", "garden",
                                                         "raised-beds"]

    # Clearing works and never demotes.
    r = c.put(f"/api/chats/{root}/tags", json={"tags": []})
    assert r.json()["tags"] == [] and r.json()["promoted"] is False
    assert _root_node(c, root)["state"] == "tree"
    print("✓ chat tags live on the root, normalized; tagging promotes")


def test_tag_validation():
    main, db, c, _ = _fresh_env()
    root, _ = _chat(c, 1)
    r = c.put(f"/api/chats/{root}/tags", json={"tags": ["event", "garden"]})
    assert r.status_code == 422 and "note type" in r.json()["detail"]
    r = c.put(f"/api/chats/{root}/tags", json={"tags": [f"t{i}" for i in range(13)]})
    assert r.status_code == 422
    assert c.put("/api/chats/99999/tags", json={"tags": ["x"]}).status_code == 404
    assert c.get("/api/chats/99999").status_code == 404
    # Clearing an untagged seed doesn't promote it.
    c.put(f"/api/chats/{root}/tags", json={"tags": []})
    assert _root_node(c, root)["state"] == "seed"
    print("✓ type tags, too many tags and unknown turns are rejected")


def test_naming_branching_and_synthesis_promote():
    main, db, c, _ = _fresh_env()

    root, leaf = _chat(c, 1)
    r = c.patch(f"/api/turns/{root}/name", json={"name": ""})
    assert r.json()["promoted"] is False and _root_node(c, root)["state"] == "seed"
    r = c.patch(f"/api/turns/{root}/name", json={"name": "Garden"})
    assert r.json()["promoted"] is True and _root_node(c, root)["state"] == "tree"

    root2, leaf2 = _chat(c, 1)
    branch = _done(c.post(f"/api/branches/{leaf2}", json={"message": "fork"}))
    node = _root_node(c, root2)
    assert node["state"] == "tree"
    states = []
    def walk(n):
        states.append(n["state"])
        for ch in n["children"]:
            walk(ch)
    walk(node)
    assert set(states) == {"tree"} and branch["user_turn_id"]  # new branch too

    root3, _ = _chat(c, 1)
    main.synthesize_notes = lambda tree, existing=None: []
    assert c.post(f"/api/notes/synthesize/{root3}").status_code == 200
    assert _root_node(c, root3)["state"] == "tree"
    print("✓ naming, branching and synthesizing each promote a seed")


def test_summary_generates_caches_and_proposes(monkeypatch):
    main, db, c, dbp = _fresh_env()
    root, leaf = _chat(c, 2)
    c.put(f"/api/chats/{root}/tags", json={"tags": ["garden"]})
    other, _ = _chat(c, 1)
    c.put(f"/api/chats/{other}/tags", json={"tags": ["project", "homestead"]})
    monkeypatch.setattr(main, "generate_title", lambda turns: "Raised beds")

    seen = {}
    def fake_summary(previous, turns, fork_note, vocabulary=None):
        seen["turns"] = [t["content"] for t in turns]
        seen["vocabulary"] = vocabulary
        seen["note"] = fork_note
        return {"summary": "Planning raised beds; layout settled.", "label": "Beds",
                "tags": ["Garden", "homestead", "project", "event", "Soil Mix",
                         "a", "b"]}
    monkeypatch.setattr(main, "generate_branch_summary", fake_summary)

    assert c.get(f"/api/chats/{root}").json()["summary"] is None
    r = c.post(f"/api/chats/{leaf}/summary")
    assert r.status_code == 200, r.text
    card = r.json()
    assert card["summary"]["text"] == "Planning raised beds; layout settled."
    # Normalized, minus tags it already wears and type tags, at most 4.
    assert card["summary"]["proposed_tags"] == ["homestead", "project", "soil-mix", "a"]
    assert card["summary"]["stale"] is False
    assert card["tags"] == ["garden"]                    # proposals not applied
    # The whole branch from the root, and the shared vocabulary.
    assert seen["turns"][0] == "seed garden beds" and len(seen["turns"]) == 4
    assert set(seen["vocabulary"]) == {"garden", "project", "homestead"}
    assert "no branches" in seen["note"]

    # Fresh: asking again regenerates nothing.
    seen.clear()
    c.post(f"/api/chats/{root}/summary")
    assert seen == {}

    # Cached: GET returns it; it goes stale once the chat grows.
    assert c.get(f"/api/chats/{root}").json()["summary"]["text"].startswith("Planning")
    _done(c.post("/api/messages", json={"message": "later", "parent_turn_id": leaf}))
    assert c.get(f"/api/chats/{root}").json()["summary"]["stale"] is True
    print("✓ summary: whole branch, cached, stale on growth, proposals filtered")


def test_summary_failure_is_502(monkeypatch):
    main, db, c, _ = _fresh_env()
    root, _ = _chat(c, 1)
    monkeypatch.setattr(main, "generate_title", lambda turns: "")
    def boom(*a):
        raise RuntimeError("model down")
    monkeypatch.setattr(main, "generate_branch_summary", boom)
    assert c.post(f"/api/chats/{root}/summary").status_code == 502
    monkeypatch.setattr(main, "generate_branch_summary",
                        lambda *a: {"summary": "", "label": "", "tags": []})
    assert c.post(f"/api/chats/{root}/summary").status_code == 502
    assert c.get(f"/api/chats/{root}").json()["summary"] is None
    print("✓ failed or empty generation is a 502 and stores nothing")


def test_vocabulary_includes_note_tags():
    main, db, c, dbp = _fresh_env()
    root, _ = _chat(c, 1)
    c.put(f"/api/chats/{root}/tags", json={"tags": ["garden"]})
    conn = sqlite3.connect(dbp)
    d = db.create_note_draft(conn, "Beds face south", "Sun.",
                             tags=["project", "garden", "decision"])
    e = db.create_note_draft(conn, "Sam", "Neighbour.", tags=["social-graph"])
    conn.close()
    for draft in (d, e):
        assert c.post(f"/api/notes/drafts/{draft['id']}/approve").status_code == 200
    conn = sqlite3.connect(dbp)
    vocab = main._tag_vocabulary(conn)
    conn.close()
    assert vocab[0] == "garden"                          # most used first
    assert {"project", "decision"} <= set(vocab)
    assert "social-graph" not in vocab                   # type tags never offered
    print("✓ vocabulary: note + chat tags by use, type tags excluded")


def test_deleting_a_root_keeps_its_tags():
    main, db, c, dbp = _fresh_env()
    root, leaf = _chat(c, 1)
    c.put(f"/api/chats/{root}/tags", json={"tags": ["garden"]})
    assert c.delete(f"/api/messages/{root}").status_code == 200   # reparent delete
    node = _root_node(c, leaf)                                 # the reply is root now
    assert node["chat_tags"] == ["garden"]
    print("✓ deleting a root hands its chat tags to the new root")


def test_generate_branch_summary_parsing(monkeypatch):
    import importlib, inference
    importlib.reload(inference)

    class _R:
        def __init__(self, text): self.text = text
        def raise_for_status(self): pass
        def json(self):
            return {"choices": [{"message": {"content": self.text}}]}
    import requests
    outputs = iter([
        'Sure! {"summary": "  Beds   planned. ", "label": "Bed layout.", '
        '"tags": ["garden", 3, null]}',
        "Just prose, no JSON at all.",
    ])
    sent = {}
    def fake_post(url, json=None, timeout=None):
        sent.update(json)
        return _R(next(outputs))
    monkeypatch.setattr(requests, "post", fake_post)
    turns = [{"role": "user", "content": "x"}] * 3
    out = inference.generate_branch_summary("Earlier: soil.", turns, "One line.",
                                            ["garden", "project"])
    assert out == {"summary": "Beds planned.", "label": "Bed layout", "tags": ["garden", "3"]}
    user = sent["messages"][-1]["content"]
    assert user.startswith("Where this branch sits: One line.")
    assert "Previous summary of the earlier turns:\nEarlier: soil." in user
    assert "New turns:" in user and user.endswith("Existing tags: garden, project")
    assert inference.generate_branch_summary(None, turns, "One line.") == {
        "summary": "Just prose, no JSON at all.", "label": "", "tags": []}
    print("✓ generate_branch_summary: lenient JSON, prose fallback, rolling input")
