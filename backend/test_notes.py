"""Tests for note drafts: CRUD, approval (vault write + frontmatter), rejection."""

import os
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def _fresh():
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(tempfile.mkdtemp(), "vault")
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), cfg["notes"]["vault_dir"]


def test_draft_lifecycle_and_vault_write():
    c, vault = _fresh()

    # Create a draft (body includes a duplicate H1 the writer must drop; messy tags).
    r = c.post("/api/notes/drafts", json={
        "title": "SQLite fits single-user local persistence",
        "body": "# SQLite fits single-user local persistence\n\nFor a single-user app, "
                "SQLite beats a server DB. The open tradeoff is [[Postgres JSON support]].",
        "tags": ["Databases", "Open Question"],
        "source_turns": [42, 47],
        "run_id": "run-1",
    })
    assert r.status_code == 200
    draft = r.json()["draft"]
    assert draft["status"] == "pending" and draft["source_turns"] == [42, 47]

    # List + filter.
    assert c.get("/api/notes/drafts?status=pending").json()["count"] == 1
    assert c.get("/api/notes/drafts?run_id=run-1").json()["count"] == 1
    assert c.get("/api/notes/drafts?status=approved").json()["count"] == 0

    # Edit during review.
    r = c.patch(f"/api/notes/drafts/{draft['id']}", json={"tags": ["databases", "decision"]})
    assert r.json()["draft"]["tags"] == ["databases", "decision"]

    # Approve -> file lands in the vault with app-stamped frontmatter + single H1.
    r = c.post(f"/api/notes/drafts/{draft['id']}/approve")
    assert r.status_code == 200
    assert r.json()["filename"] == "SQLite fits single-user local persistence.md"
    content = open(r.json()["path"], encoding="utf-8").read()
    assert content.startswith("---\ncreated: ")
    assert "tags: [databases, decision]" in content
    assert "source_turns: [42, 47]" in content
    assert content.count("# SQLite fits single-user local persistence") == 1  # no double H1
    assert "[[Postgres JSON support]]" in content

    # Already decided -> 409 on re-approve and on edit.
    assert c.post(f"/api/notes/drafts/{draft['id']}/approve").status_code == 409
    assert c.patch(f"/api/notes/drafts/{draft['id']}", json={"body": "x"}).status_code == 409
    print("✓ draft lifecycle: create, list, edit, approve -> vault file with frontmatter")


def test_title_validation_and_collision():
    c, vault = _fresh()

    def mk(title):
        return c.post("/api/notes/drafts", json={"title": title, "body": "body"}).json()["draft"]

    # Forbidden characters -> 422 at approval.
    bad = mk("What about [brackets] and #hash?")
    assert c.post(f"/api/notes/drafts/{bad['id']}/approve").status_code == 422

    # Collision (case-insensitive) -> 409; draft stays pending for a rename.
    a = mk("A note title")
    b = mk("a NOTE title")
    assert c.post(f"/api/notes/drafts/{a['id']}/approve").status_code == 200
    r = c.post(f"/api/notes/drafts/{b['id']}/approve")
    assert r.status_code == 409
    assert c.get(f"/api/notes/drafts?status=pending").json()["count"] >= 1
    # Rename then approve succeeds.
    c.patch(f"/api/notes/drafts/{b['id']}", json={"title": "A different claim"})
    assert c.post(f"/api/notes/drafts/{b['id']}/approve").status_code == 200
    print("✓ title validation (422), case-insensitive collision (409), rename recovers")


def test_reject_never_touches_vault():
    c, vault = _fresh()
    d = c.post("/api/notes/drafts", json={"title": "Rejected idea", "body": "meh"}).json()["draft"]
    r = c.post(f"/api/notes/drafts/{d['id']}/reject")
    assert r.json()["draft"]["status"] == "rejected"
    assert not os.path.exists(os.path.join(vault, "Rejected idea.md"))
    # Missing drafts -> 404.
    assert c.post("/api/notes/drafts/9999/approve").status_code == 404
    assert c.post("/api/notes/drafts/9999/reject").status_code == 404
    print("✓ reject keeps the vault untouched; 404s on missing drafts")


def test_vault_dir_resolution():
    """Vaults are ALWAYS per-user; vault_dir relocates them, never merges them."""
    c, vault = _fresh()
    a = "/data/users/abc123hash/conversations.db"
    b = "/data/users/def456hash/conversations.db"

    # Under auth with vault_dir set: per-user subdirectory of the configured root —
    # two users NEVER share a vault.
    config.get_config._config["notes"]["vault_dir"] = "/srv/vaults"
    main.auth_enabled = True
    assert main._resolve_vault_dir(a) == "/srv/vaults/abc123hash"
    assert main._resolve_vault_dir(b) == "/srv/vaults/def456hash"
    assert main._resolve_vault_dir(a) != main._resolve_vault_dir(b)

    # Under auth, unset -> vault next to each user's DB.
    config.get_config._config["notes"]["vault_dir"] = None
    assert main._resolve_vault_dir(a) == "/data/users/abc123hash/notes"

    # Auth off (single anonymous user): vault_dir IS the vault; unset -> next to DB.
    main.auth_enabled = False
    config.get_config._config["notes"]["vault_dir"] = "/srv/vaults"
    assert main._resolve_vault_dir("/x/data/conversations.db") == "/srv/vaults"
    config.get_config._config["notes"]["vault_dir"] = None
    assert main._resolve_vault_dir("/x/data/conversations.db") == "/x/data/notes"
    print("✓ vault_dir: always per-user under auth; relocates, never merges")


def test_synthesize_endpoint_creates_pending_drafts():
    c, vault = _fresh()
    import sqlite3
    conn = sqlite3.connect(os.environ["DB_PATH"])
    root = db.create_turn(conn, None, "user", "Should we use SQLite?")
    db.create_turn(conn, None, "assistant", "SQLite is simpler.", parent_turn_id=root["id"])
    conn.close()

    captured = {}
    def fake_synth(tree, existing=None):
        captured["tree"] = tree
        return [
            {"title": "SQLite fits this project", "body": "I chose SQLite because…",
             "tags": ["decision"], "links": [], "source_turns": [root["id"]]},
            {"title": "Is JSON querying a future risk?", "body": "Open question I hold…",
             "tags": ["open-question"], "links": ["SQLite fits this project"],
             "source_turns": [root["id"]]},
        ]
    main.synthesize_notes = fake_synth

    r = c.post(f"/api/notes/synthesize/{root['id']}")
    assert r.status_code == 200
    out = r.json()
    assert out["count"] == 2 and out["run_id"].startswith("run-")
    assert captured["tree"]["id"] == root["id"]                      # got the export tree
    assert all(d["status"] == "pending" for d in out["drafts"])      # awaiting review
    assert all(d["tree_root_id"] == root["id"] for d in out["drafts"])
    # They land in the review inbox, grouped by run.
    inbox = c.get(f"/api/notes/drafts?run_id={out['run_id']}").json()
    assert inbox["count"] == 2
    assert not os.listdir(vault) if os.path.isdir(vault) else True   # vault untouched

    # Missing tree -> 404; synthesis blow-up -> 502.
    assert c.post("/api/notes/synthesize/99999").status_code == 404
    def boom(tree, existing=None): raise RuntimeError("model fell over")
    main.synthesize_notes = boom
    assert c.post(f"/api/notes/synthesize/{root['id']}").status_code == 502
    print("✓ synthesize endpoint: export -> LLM -> pending drafts; 404/502 paths")


def test_synthesize_notes_parse_fallback():
    """synthesize_notes tolerates JSON wrapped in prose and drops invalid entries."""
    import inference, json as _json
    payload = {"notes": [
        {"title": "Real note", "body": "Body.", "tags": [], "links": [], "source_turns": [1]},
        {"title": "", "body": "no title -> dropped", "tags": [], "links": [], "source_turns": []},
    ]}
    class FakeResp:
        def raise_for_status(self): pass
        def json(self):
            return {"choices": [{"message": {"content":
                "Here you go:\n" + _json.dumps(payload) + "\nHope that helps!"}}]}
    orig = inference.requests.post
    inference.requests.post = lambda *a, **k: FakeResp()
    try:
        notes = inference.synthesize_notes({"id": 1, "children": []})
    finally:
        inference.requests.post = orig
    assert len(notes) == 1 and notes[0]["title"] == "Real note"
    print("✓ synthesize_notes: prose-wrapped JSON parsed, invalid entries dropped")


if __name__ == "__main__":
    test_draft_lifecycle_and_vault_write()
    test_title_validation_and_collision()
    test_reject_never_touches_vault()
    test_vault_dir_resolution()
    test_synthesize_endpoint_creates_pending_drafts()
    test_synthesize_notes_parse_fallback()
    print("\n✓ All note-draft tests passed!")
