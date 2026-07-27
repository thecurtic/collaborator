"""Tests for the notes tools on the tool loop: registry gating, executors,
propose_note -> pending draft + drafts_proposed SSE event, vault untouched."""

import os
import json
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, notes_index
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def _fresh(tools_on=False):
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(tempfile.mkdtemp(), "vault")
    if tools_on:
        cfg["tools"]["enabled"] = True
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), cfg, path


def _fake_embed(texts):
    return [[float(len(t)), 1.0] for t in texts]


def _seed_note(cfg, dbp, title, body, tags=None):
    vault = cfg["notes"]["vault_dir"]
    os.makedirs(vault, exist_ok=True)
    with open(os.path.join(vault, f"{title}.md"), "w", encoding="utf-8") as f:
        f.write(f"---\ncreated: 2026-07-06\ntags: [{', '.join(tags or [])}]\n---\n\n# {title}\n\n{body}\n")
    conn = sqlite3.connect(dbp)
    notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed)
    conn.close()


def test_registry_includes_and_gates_notes_tools():
    c, cfg, dbp = _fresh()
    schemas, _, _ = main._build_tools(dbp)
    names = {s["function"]["name"] for s in schemas}
    assert {"search_notes", "get_note", "propose_note"} <= names

    cfg["tools"]["available"]["propose_note"] = False
    cfg["tools"]["available"]["get_note"] = False
    schemas, _, _ = main._build_tools(dbp)
    names = {s["function"]["name"] for s in schemas}
    assert "search_notes" in names and "propose_note" not in names and "get_note" not in names
    print("✓ registry: notes tools present and individually config-gated")


def test_search_and_get_note_executors():
    c, cfg, dbp = _fresh()
    _seed_note(cfg, dbp, "Alpha claim", "Grounded in [[Beta claim]].", tags=["decision"])
    _seed_note(cfg, dbp, "Beta claim", "Standalone body.")

    _, execute, _ = main._build_tools(dbp)

    hits = json.loads(execute("search_notes", {"query": "grounded", "mode": "keyword"}))
    assert any(h["title"] == "Alpha claim" for h in hits)
    assert all("preview" in h and "links" in h for h in hits)

    note = json.loads(execute("get_note", {"title": "beta claim"}))   # case-insensitive
    assert note["title"] == "Beta claim" and note["backlinks"] == ["Alpha claim"]
    missing = json.loads(execute("get_note", {"title": "Nope"}))
    assert "error" in missing
    print("✓ executors: search_notes (keyword), get_note with backlinks, miss -> error")


def test_search_notes_tag_filter_executor():
    c, cfg, dbp = _fresh()
    _seed_note(cfg, dbp, "Curtis runs a homelab", "profile fact", tags=["user-profile"])
    _seed_note(cfg, dbp, "Sam", "friend from the maker space", tags=["social-graph"])
    _seed_note(cfg, dbp, "Loose idea", "no category")

    _, execute, _ = main._build_tools(dbp)

    # Tag + empty query = whole category listing (the full user profile).
    hits = json.loads(execute("search_notes", {"query": "", "tag": "user-profile"}))
    assert [h["title"] for h in hits] == ["Curtis runs a homelab"]

    # Tag constrains a keyword search.
    hits = json.loads(execute("search_notes",
                              {"query": "friend idea fact", "mode": "keyword",
                               "tag": "social-graph"}))
    assert [h["title"] for h in hits] == ["Sam"]
    print("✓ search_notes executor: tag filter + tag-only category listing")


def test_propose_note_creates_pending_draft_only():
    c, cfg, dbp = _fresh()
    _, execute, state = main._build_tools(dbp)

    out = json.loads(execute("propose_note", {
        "title": "An idea worth keeping",
        "body": "First-person distilled body.",
        "tags": ["concept"], "links": [],
    }))
    assert out["status"] == "pending"
    assert state["proposed_drafts"][0]["title"] == "An idea worth keeping"

    conn = sqlite3.connect(dbp)
    drafts = db.list_note_drafts(conn, status="pending")
    conn.close()
    assert len(drafts) == 1 and drafts[0]["run_id"].startswith("chat-")

    vault = cfg["notes"]["vault_dir"]
    assert not os.path.exists(os.path.join(vault, "An idea worth keeping.md"))  # NEVER the vault
    # Missing fields -> tool-level error, no draft.
    err = json.loads(execute("propose_note", {"title": "", "body": ""}))
    assert "error" in err
    print("✓ propose_note: pending draft only, chat run_id, vault untouched")


def test_drafts_proposed_sse_event():
    c, cfg, dbp = _fresh(tools_on=True)
    import inference

    rounds = [
        [{"tool_calls": [{"index": 0, "id": "1", "type": "function",
                          "function": {"name": "propose_note", "arguments": ""}}]},
         {"tool_calls": [{"index": 0, "function": {"arguments":
            json.dumps({"title": "Proposed from chat", "body": "Distilled.", "tags": [], "links": []})}}]}],
        [{"content": "Draft created — it's in your inbox."}],
    ]
    calls = {"i": 0}
    def scripted(payload):
        deltas = rounds[calls["i"]] if calls["i"] < len(rounds) else []
        calls["i"] += 1
        for d in deltas:
            yield ({}, d)
    orig = inference._iter_stream_events
    inference._iter_stream_events = scripted
    main.embed_texts = _fake_embed
    main.get_embedding = lambda text: [1.0, 1.0]
    try:
        r = c.post("/api/messages", json={"message": "note that down please", "recall": True})
    finally:
        inference._iter_stream_events = orig

    events = [json.loads(l[6:]) for l in r.text.splitlines() if l.startswith("data: ")]
    types = [e["type"] for e in events]
    assert "status" in types and "drafts_proposed" in types and "done" in types
    proposed = next(e for e in events if e["type"] == "drafts_proposed")
    assert proposed["drafts"][0]["title"] == "Proposed from chat"
    assert proposed["drafts"][0]["run_id"].startswith("chat-")

    inbox = c.get(f"/api/notes/drafts?run_id={proposed['drafts'][0]['run_id']}").json()
    assert inbox["count"] == 1 and inbox["drafts"][0]["status"] == "pending"
    print("✓ SSE: drafts_proposed event emitted; draft lands pending in the inbox")


if __name__ == "__main__":
    test_registry_includes_and_gates_notes_tools()
    test_search_and_get_note_executors()
    test_propose_note_creates_pending_draft_only()
    test_drafts_proposed_sse_event()
    print("\n✓ All notes-tools tests passed!")
