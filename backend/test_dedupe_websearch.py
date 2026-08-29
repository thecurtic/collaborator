"""Tests for dedupe-against-vault (synthesis + propose_note) and the web_search tool."""

import os
import json
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, notes_index, inference
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def _fresh(**cfg_over):
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(tempfile.mkdtemp(), "vault")
    for k, v in cfg_over.items():
        section, key = k.split(".", 1)
        cfg[section][key] = v
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), cfg, path


def _seed_indexed_note(cfg, dbp, title, body, vec):
    vault = cfg["notes"]["vault_dir"]
    os.makedirs(vault, exist_ok=True)
    with open(os.path.join(vault, f"{title}.md"), "w", encoding="utf-8") as f:
        f.write(f"---\ncreated: 2026-07-06\n---\n\n# {title}\n\n{body}\n")
    conn = sqlite3.connect(dbp)
    notes_index.reindex_vault(conn, vault, embed_fn=lambda texts: [vec for _ in texts])
    conn.close()


def test_synthesis_flags_duplicates_and_passes_existing():
    c, cfg, dbp = _fresh()
    # One existing note, embedded at [1, 0].
    _seed_indexed_note(cfg, dbp, "SQLite fits this project", "Existing body.", [1.0, 0.0])

    conn = sqlite3.connect(dbp)
    root = db.create_turn(conn, None, "user", "database chat")
    conn.close()

    # Query/candidate embeddings also [1,0] -> similarity 1.0 (>= threshold).
    main.get_embedding = lambda text: [1.0, 0.0]
    captured = {}
    def fake_synth(tree, existing=None):
        captured["existing"] = existing
        return [
            {"title": "SQLite is the right call here", "body": "Near-duplicate idea.",
             "tags": [], "links": [], "source_turns": []},
        ]
    main.synthesize_notes = fake_synth

    out = c.post(f"/api/notes/synthesize/{root['id']}").json()
    # The model was told what already exists...
    assert any(n["title"] == "SQLite fits this project" for n in captured["existing"])
    # ...and the near-duplicate candidate got flagged, not dropped.
    d = out["drafts"][0]
    assert d["status"] == "pending"
    assert d["duplicate_of"] and d["duplicate_of"][0]["title"] == "SQLite fits this project"
    assert d["duplicate_of"][0]["score"] >= 0.85
    # Visible in the review inbox too.
    inbox = c.get(f"/api/notes/drafts?run_id={out['run_id']}").json()["drafts"][0]
    assert inbox["duplicate_of"][0]["title"] == "SQLite fits this project"
    print("✓ synthesis: existing notes passed to the model; near-dupes flagged on drafts")


def test_no_flag_when_dissimilar():
    c, cfg, dbp = _fresh()
    _seed_indexed_note(cfg, dbp, "Unrelated note", "Different topic.", [0.0, 1.0])
    conn = sqlite3.connect(dbp)
    root = db.create_turn(conn, None, "user", "chat")
    conn.close()
    main.get_embedding = lambda text: [1.0, 0.0]   # orthogonal to the seeded note
    main.synthesize_notes = lambda tree, existing=None: [
        {"title": "Fresh idea", "body": "New.", "tags": [], "links": [], "source_turns": []}]
    out = c.post(f"/api/notes/synthesize/{root['id']}").json()
    assert out["drafts"][0]["duplicate_of"] == []
    print("✓ dissimilar candidates carry no duplicate_of")


def test_propose_note_warns_on_duplicate():
    c, cfg, dbp = _fresh()
    _seed_indexed_note(cfg, dbp, "SQLite fits this project", "Existing body.", [1.0, 0.0])
    main.get_embedding = lambda text: [1.0, 0.0]

    _, execute, state = main._build_tools(dbp)
    out = json.loads(execute("propose_note", {"title": "SQLite again", "body": "Same idea."}))
    assert out["possible_duplicates"][0]["title"] == "SQLite fits this project"
    assert "duplicate" in out["note"].lower()

    conn = sqlite3.connect(dbp)
    draft = db.list_note_drafts(conn, status="pending")[0]
    conn.close()
    assert draft["duplicate_of"][0]["title"] == "SQLite fits this project"
    print("✓ propose_note: duplicate warning in tool result + stored on draft")


def test_web_search_gating_and_executor():
    # No URL -> tool absent from the registry.
    c, cfg, dbp = _fresh()
    schemas, _, _ = main._build_tools(dbp)
    assert "web_search" not in {s["function"]["name"] for s in schemas}

    # URL set -> present; executor parses SearXNG JSON (mocked HTTP).
    cfg["tools"]["web_search"]["url"] = "http://<search-vm-ip>"
    schemas, execute, _ = main._build_tools(dbp)
    assert "web_search" in {s["function"]["name"] for s in schemas}

    class FakeResp:
        def raise_for_status(self): pass
        def json(self):
            return {"results": [
                        {"title": "TransLink", "url": "https://translink.ca",
                         "content": "Vancouver transit authority " * 30, "engine": "duckduckgo"},
                    ] * 9,
                    "answers": ["Transit info answer"],
                    "infoboxes": [{"infobox": "TransLink", "content": "Metro Vancouver transit."}]}
    captured = {}
    orig = inference.requests.get
    inference.requests.get = lambda url, params=None, timeout=None: captured.update(url=url, params=params) or FakeResp()
    try:
        out = json.loads(execute("web_search", {"query": "vancouver transit"}))
    finally:
        inference.requests.get = orig

    assert captured["url"].startswith("http://<search-vm-ip>/search")
    assert captured["params"]["q"] == "vancouver transit" and captured["params"]["format"] == "json"
    assert len(out["results"]) == 5                                # capped at config results
    assert len(out["results"][0]["snippet"]) <= 300                # snippets trimmed
    assert out["answers"] == ["Transit info answer"]
    assert out["infoboxes"][0]["title"] == "TransLink"

    # Failure path returns a tool-level error, not an exception.
    inference.requests.get = lambda *a, **k: (_ for _ in ()).throw(Exception("down"))
    try:
        out = json.loads(execute("web_search", {"query": "x"}))
    finally:
        inference.requests.get = orig
    assert "error" in out
    print("✓ web_search: URL-gated registry, SearXNG JSON parsed, capped, error-safe")


def test_web_search_brave_provider():
    # provider=brave with no key -> tool absent, even with a searxng URL set
    # (the SELECTED provider's credential is what gates).
    c, cfg, dbp = _fresh()
    cfg["tools"]["web_search"]["provider"] = "brave"
    cfg["tools"]["web_search"]["url"] = "http://<search-vm-ip>"
    schemas, _, _ = main._build_tools(dbp)
    assert "web_search" not in {s["function"]["name"] for s in schemas}

    # Key set -> present; executor calls the Brave API and maps the response.
    cfg["tools"]["web_search"]["brave_api_key"] = "test-key"
    schemas, execute, _ = main._build_tools(dbp)
    assert "web_search" in {s["function"]["name"] for s in schemas}

    class FakeResp:
        def raise_for_status(self): pass
        def json(self):
            return {"web": {"results": [
                {"title": "Trans<strong>Link</strong>",
                 "url": "https://translink.ca?utm_source=brave",
                 "description": "Vancouver &amp; region transit " * 30},
            ] * 9}}
    captured = {}
    orig = inference.requests.get
    inference.requests.get = (lambda url, **kw:
                              captured.update(url=url, **kw) or FakeResp())
    try:
        out = json.loads(execute("web_search", {"query": "vancouver transit"}))
    finally:
        inference.requests.get = orig

    assert captured["url"] == "https://api.search.brave.com/res/v1/web/search"
    assert captured["headers"]["X-Subscription-Token"] == "test-key"
    assert captured["params"]["q"] == "vancouver transit"
    assert captured["params"]["safesearch"] == "off"
    assert len(out["results"]) == 5                       # capped at config results
    r = out["results"][0]
    assert r["title"] == "TransLink"                      # highlight tags stripped
    assert r["url"] == "https://translink.ca"             # tracking params stripped
    assert "&amp;" not in r["snippet"] and len(r["snippet"]) <= 300
    assert r["engine"] == "brave"
    assert out["engines"]["responded"] == {"brave": 5}    # health shape preserved

    # Failure path returns a tool-level error, not an exception.
    inference.requests.get = lambda *a, **k: (_ for _ in ()).throw(Exception("down"))
    try:
        out = json.loads(execute("web_search", {"query": "x"}))
    finally:
        inference.requests.get = orig
    assert "brave" in out["error"]
    print("✓ web_search: brave provider — key-gated, mapped, stripped, error-safe")


if __name__ == "__main__":
    test_synthesis_flags_duplicates_and_passes_existing()
    test_no_flag_when_dissimilar()
    test_propose_note_warns_on_duplicate()
    test_web_search_gating_and_executor()
    test_web_search_brave_provider()
    print("\n✓ All dedupe + web-search tests passed!")
