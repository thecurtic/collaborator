"""Tests for propose_edit: the LLM proposes changes to existing notes as PENDING
drafts (kind='edit'); approval applies them through the shared note-edit machinery
(renames rewrite wikilinks); the vault is never touched before approval."""

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


def _fake_embed(texts):
    return [[float(len(t)), 1.0] for t in texts]


def _fresh():
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(tempfile.mkdtemp(), "vault")
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    main.embed_texts = _fake_embed
    db.init_db()
    return TestClient(main.app), cfg, path


def _seed_note(cfg, dbp, title, body, tags=None):
    vault = cfg["notes"]["vault_dir"]
    os.makedirs(vault, exist_ok=True)
    with open(os.path.join(vault, f"{title}.md"), "w", encoding="utf-8") as f:
        f.write(f"---\ncreated: 2026-07-06\ntags: [{', '.join(tags or [])}]\n---\n\n"
                f"# {title}\n\n{body}\n")
    conn = sqlite3.connect(dbp)
    notes_index.reindex_vault(conn, cfg["notes"]["vault_dir"], embed_fn=_fake_embed)
    conn.close()


def test_migration_adds_edit_columns():
    _, _, dbp = _fresh()
    conn = sqlite3.connect(dbp)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(note_drafts)").fetchall()}
    conn.close()
    assert {"kind", "target_title", "reason"} <= cols
    print("✓ migration: note_drafts gains kind/target_title/reason")


def test_registry_gating():
    _, cfg, dbp = _fresh()
    schemas, _, _ = main._build_tools(dbp)
    assert "propose_edit" in {s["function"]["name"] for s in schemas}
    cfg["tools"]["available"]["propose_edit"] = False
    schemas, _, _ = main._build_tools(dbp)
    assert "propose_edit" not in {s["function"]["name"] for s in schemas}
    cfg["tools"]["available"]["propose_edit"] = True
    print("✓ registry: propose_edit present and config-gated")


def test_propose_edit_creates_pending_draft_only():
    c, cfg, dbp = _fresh()
    _seed_note(cfg, dbp, "Transit is freedom", "I believe buses beat cars.", ["transit"])
    _, execute, state = main._build_tools(dbp)

    # Unknown target -> error, no draft.
    out = json.loads(execute("propose_edit", {"title": "Nope"}))
    assert "no note titled" in out["error"]

    # No-op edit -> error.
    out = json.loads(execute("propose_edit", {"title": "Transit is freedom"}))
    assert "changes nothing" in out["error"]

    out = json.loads(execute("propose_edit", {
        "title": "Transit is freedom",
        "new_title": "Good transit is freedom",
        "tags": ["transit", "cities"],
        "reason": "sharper claim; add cities tag"}))
    assert out["status"] == "pending"
    draft_id = out["draft_id"]

    # Vault untouched; draft holds full proposed state (snapshot semantics).
    vault = cfg["notes"]["vault_dir"]
    assert os.path.exists(os.path.join(vault, "Transit is freedom.md"))
    assert not os.path.exists(os.path.join(vault, "Good transit is freedom.md"))
    d = c.get("/api/notes/drafts", params={"status": "pending"}).json()["drafts"][0]
    assert d["id"] == draft_id and d["kind"] == "edit"
    assert d["target_title"] == "Transit is freedom"
    assert d["title"] == "Good transit is freedom"
    assert d["body"] == "I believe buses beat cars."      # omitted -> current body
    assert d["tags"] == ["transit", "cities"]
    assert d["reason"] == "sharper claim; add cities tag"
    # And it's surfaced for the drafts_proposed SSE event with its kind.
    assert state["proposed_drafts"][0]["kind"] == "edit"
    print("✓ propose_edit: pending draft only, snapshot fill, vault untouched")


def test_approve_applies_edit_and_rewrites_wikilinks():
    c, cfg, dbp = _fresh()
    _seed_note(cfg, dbp, "Transit is freedom", "I believe buses beat cars.", ["transit"])
    _seed_note(cfg, dbp, "Cars are a trap",
               "Ownership costs compound; see [[Transit is freedom]].", ["cars"])
    _, execute, _ = main._build_tools(dbp)
    execute("get_note", {"title": "Transit is freedom"})   # read-before-edit gate
    out = json.loads(execute("propose_edit", {
        "title": "Transit is freedom", "new_title": "Good transit is freedom",
        "body": "I believe frequent buses beat cars on every axis I care about.",
        "tags": ["transit", "cities"], "reason": "tighten"}))

    r = c.post(f"/api/notes/drafts/{out['draft_id']}/approve")
    assert r.status_code == 200
    res = r.json()
    assert res["draft"]["status"] == "approved"
    assert res["renamed"] is True
    assert res["links_rewritten"] == ["Cars are a trap"]

    vault = cfg["notes"]["vault_dir"]
    assert not os.path.exists(os.path.join(vault, "Transit is freedom.md"))
    new_path = os.path.join(vault, "Good transit is freedom.md")
    text = open(new_path, encoding="utf-8").read()
    assert "frequent buses" in text and "tags:" in text and "cities" in text
    linker = open(os.path.join(vault, "Cars are a trap.md"), encoding="utf-8").read()
    assert "[[Good transit is freedom]]" in linker
    assert "[[Transit is freedom]]" not in linker
    print("✓ approve: edit applied, rename rewrote inbound wikilinks, reindexed")


def test_approve_409_when_target_gone_and_reject_untouched():
    c, cfg, dbp = _fresh()
    _seed_note(cfg, dbp, "Transit is freedom", "Body.", ["transit"])
    _, execute, _ = main._build_tools(dbp)
    out = json.loads(execute("propose_edit", {
        "title": "Transit is freedom", "tags": ["transit", "cities"]}))

    # Reject: vault untouched, draft archived.
    r = c.post(f"/api/notes/drafts/{out['draft_id']}/reject")
    assert r.status_code == 200
    text = open(os.path.join(cfg["notes"]["vault_dir"], "Transit is freedom.md"),
                encoding="utf-8").read()
    assert "cities" not in text

    # Target deleted between proposal and approval -> 409.
    out = json.loads(execute("propose_edit", {
        "title": "Transit is freedom", "tags": ["transit", "cities"]}))
    os.remove(os.path.join(cfg["notes"]["vault_dir"], "Transit is freedom.md"))
    conn = sqlite3.connect(dbp)
    notes_index.reindex_vault(conn, cfg["notes"]["vault_dir"], embed_fn=_fake_embed)
    conn.close()
    r = c.post(f"/api/notes/drafts/{out['draft_id']}/approve")
    assert r.status_code == 409 and "no longer exists" in r.json()["detail"]
    print("✓ reject leaves vault untouched; approve is 409 when the target vanished")


def test_many_edits_one_per_note():
    c, cfg, dbp = _fresh()
    for i in range(3):
        _seed_note(cfg, dbp, f"Note {i}", f"Body {i}.", ["old-tag"])
    _, execute, state = main._build_tools(dbp)
    for i in range(3):
        out = json.loads(execute("propose_edit", {
            "title": f"Note {i}", "tags": ["new-tag"], "reason": "retag sweep"}))
        assert out["status"] == "pending"
    drafts = c.get("/api/notes/drafts", params={"status": "pending"}).json()["drafts"]
    assert len(drafts) == 3 and all(d["kind"] == "edit" for d in drafts)
    assert len(state["proposed_drafts"]) == 3
    for d in drafts:
        assert c.post(f"/api/notes/drafts/{d['id']}/approve").status_code == 200
    for i in range(3):
        text = open(os.path.join(cfg["notes"]["vault_dir"], f"Note {i}.md"),
                    encoding="utf-8").read()
        assert "new-tag" in text
    print("✓ bulk: one draft per note, all reviewable and appliable from one inbox")


if __name__ == "__main__":
    test_migration_adds_edit_columns()
    test_registry_gating()
    test_propose_edit_creates_pending_draft_only()
    test_approve_applies_edit_and_rewrites_wikilinks()
    test_approve_409_when_target_gone_and_reject_untouched()
    test_many_edits_one_per_note()
    print("\n✓ All propose_edit tests passed!")


def test_read_before_edit_gate():
    """A body replacement is refused until the model has READ the current note
    this turn — composing from memory silently reverts the user's own edits."""
    c, cfg, dbp = _fresh()
    _seed_note(cfg, dbp, "Transit is freedom", "User-amended body.", ["transit"])
    _, execute, _ = main._build_tools(dbp)

    out = json.loads(execute("propose_edit", {
        "title": "Transit is freedom", "body": "Rewritten from stale memory."}))
    assert "get_note FIRST" in out["error"]

    execute("get_note", {"title": "transit is freedom"})   # case-insensitive read
    out = json.loads(execute("propose_edit", {
        "title": "Transit is freedom", "body": "Informed rewrite."}))
    assert out["status"] == "pending"

    # Field-only edits (tags, fields) don't need the read — no body to clobber.
    _seed_note(cfg, dbp, "Ship the app", "Goal body.", ["goal"])
    out = json.loads(execute("propose_edit", {
        "title": "Ship the app", "tags": ["goal", "project", "app"]}))
    assert out["status"] == "pending"
    print("✓ read-before-edit: body needs a fresh read; field-only edits don't")


def test_body_metadata_duplication_rejected():
    """Field values repeated in the body ('Due: Friday') are rejected — typed
    fields become frontmatter; the body is pure prose."""
    c, cfg, dbp = _fresh()
    _, execute, _ = main._build_tools(dbp)

    out = json.loads(execute("propose_note", {
        "title": "Kiln day", "tags": ["event"], "start": "2026-08-15T10:00",
        "body": "Date: 2026-08-15\nA hands-on firing day."}))
    assert "pure prose" in out["error"]

    out = json.loads(execute("propose_note", {
        "title": "Kiln day", "tags": ["event"], "start": "2026-08-15T10:00",
        "body": "**Location:** the annex\nA hands-on firing day."}))
    assert "pure prose" in out["error"]

    # Prose that merely mentions a date inline is fine.
    out = json.loads(execute("propose_note", {
        "title": "Ship the deck", "tags": ["goal"],
        "body": "Finish the investor deck by 2026-08-15, before the board "
                "meeting."}))
    assert out["status"] == "pending"
    print("✓ metadata smuggled into the body rejected; clean prose accepted")
