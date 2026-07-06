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


if __name__ == "__main__":
    test_draft_lifecycle_and_vault_write()
    test_title_validation_and_collision()
    test_reject_never_touches_vault()
    print("\n✓ All note-draft tests passed!")
