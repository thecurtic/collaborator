"""Tests for per-type frontmatter: category exclusivity, the shared state key,
social-graph fields, event people/location, USER.md, and the PATCH fields fix."""

import json
import os
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


def _fresh():
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(tempfile.mkdtemp(), "vault")
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), cfg, path


def _fake_embed(texts):
    return [[float(len(t)), 1.0] for t in texts]


def _approve(c, execute, args):
    out = json.loads(execute("propose_note", args))
    assert "error" not in out, out
    r = c.post(f"/api/notes/drafts/{out['draft_id']}/approve")
    assert r.status_code == 200, r.text
    return r.json()["path"]


def test_type_exclusivity_and_removed_fields():
    c, cfg, dbp = _fresh()
    _, execute, _ = main._build_tools(dbp)

    # The three type tags stay exclusive.
    out = json.loads(execute("propose_note", {
        "title": "Two hats", "body": "x", "tags": ["social-graph", "event"],
        "start": "2026-08-09"}))
    assert "ONE type tag" in out["error"]

    # state and due are gone everywhere, project and the old goal type included.
    for tags in (["goal"], ["question"], ["project", "garden"], ["event"]):
        out = json.loads(execute("propose_note", {
            "title": "Has state", "body": "x", "tags": tags,
            "start": "2026-08-09", "state": "started"}))
        assert "not a note field" in out["error"], tags
    out = json.loads(execute("propose_note", {
        "title": "Has due", "body": "x", "tags": ["goal"], "due": "2026-09-30"}))
    assert "not a note field" in out["error"]

    # Plain tags carry no fields.
    out = json.loads(execute("propose_note", {
        "title": "Wrong home", "body": "x", "tags": ["memory"],
        "birthday": "1990-01-01"}))
    assert "does not apply" in out["error"]
    print("✓ type exclusivity; state/due rejected; plain tags have no fields")


def test_former_categories_are_plain_tags():
    c, cfg, dbp = _fresh()
    _, execute, _ = main._build_tools(dbp)

    # goal/question/decision/memory combine with each other and write no fields.
    path = _approve(c, execute, {
        "title": "Learn woodworking", "body": "By the end of September.",
        "tags": ["goal", "question", "decision", "memory"]})
    raw = open(path, encoding="utf-8").read()
    assert "state:" not in raw and "due:" not in raw
    conn = sqlite3.connect(dbp)
    note = notes_index.get_note_by_title(conn, "Learn woodworking")
    conn.close()
    assert note["fields"] == {}
    hits = json.loads(execute("search_notes", {"query": "", "tag": "goal"}))
    assert [h["title"] for h in hits] == ["Learn woodworking"]
    print("✓ goal/question/decision/memory are plain, combinable tags")


def test_events_and_people_join_projects():
    """project left the exclusive set: membership is project + one name tag,
    on any note, typed or not."""
    c, cfg, dbp = _fresh()
    _, execute, _ = main._build_tools(dbp)
    _approve(c, execute, {
        "title": "Ana", "body": "Runs the seed library.",
        "tags": ["social-graph", "project", "garden"], "relation": "neighbour"})
    path = _approve(c, execute, {
        "title": "Seed swap", "body": "Spring swap at the library.",
        "tags": ["event", "project", "garden"],
        "start": "2026-03-21T10:00", "people": ["Ana"]})
    raw = open(path, encoding="utf-8").read()
    assert "tags: [event, project, garden]" in raw and "start:" in raw

    hits = json.loads(execute("search_notes", {"query": "", "tag": "garden"}))
    assert {h["title"] for h in hits} == {"Ana", "Seed swap"}
    listing = json.loads(execute("list_events",
                                 {"from": "2026-03-21", "to": "2026-03-21"}))
    assert [e["title"] for e in listing["events"]] == ["Seed swap"]

    # Direct PATCH accepts the combination too, and still validates fields.
    r = c.patch("/api/notes/Ana", json={"tags": ["social-graph", "project",
                                                 "garden", "volunteer"]})
    assert r.status_code == 200, r.text
    print("✓ events and people carry project + name; typed fields intact")


def test_stale_state_on_pending_draft_is_not_written():
    """A draft proposed before the change may still hold state/due; approving
    it writes neither (the serializer no longer knows them)."""
    c, cfg, dbp = _fresh()
    conn = sqlite3.connect(dbp)
    d = db.create_note_draft(conn, "Ship the deck", "Finish it.", tags=["goal"],
                             fields={"state": "started", "due": "2026-08-15"})
    conn.close()
    r = c.post(f"/api/notes/drafts/{d['id']}/approve")
    assert r.status_code == 200, r.text
    raw = open(r.json()["path"], encoding="utf-8").read()
    assert "state:" not in raw and "due:" not in raw
    print("✓ stale state/due on a pending draft is dropped at approval")


def test_social_graph_fields_and_alias_search():
    c, cfg, dbp = _fresh()
    _, execute, _ = main._build_tools(dbp)
    _approve(c, execute, {
        "title": "Robert Chen", "body": "Met at the co-op.",
        "tags": ["social-graph"], "aliases": ["Bob", "Bobby C"],
        "kind": "person", "relation": "friend", "birthday": "03-14"})

    conn = sqlite3.connect(dbp)
    note = notes_index.get_note_by_title(conn, "Robert Chen")
    assert note["fields"]["aliases"] == ["Bob", "Bobby C"]
    assert note["fields"]["kind"] == "person"
    assert note["fields"]["birthday"] == "03-14"
    # Alias hits keyword search even though "Bob" is nowhere in title/body.
    res = notes_index.search_notes_keyword(conn, "Bob")
    assert [n["title"] for n in res] == ["Robert Chen"]
    conn.close()

    bad = json.loads(execute("propose_note", {
        "title": "X", "body": "y", "tags": ["social-graph"], "kind": "robot"}))
    assert "person" in bad["error"]
    print("✓ social-graph fields persisted; aliases match keyword search")


def test_event_people_location_and_graph_edges():
    c, cfg, dbp = _fresh()
    _, execute, _ = main._build_tools(dbp)
    _approve(c, execute, {"title": "Sarah", "body": "Ceramics.",
                          "tags": ["social-graph"]})
    _approve(c, execute, {
        "title": "Kiln workshop", "body": "Hands-on day.", "tags": ["event"],
        "start": "2026-08-09T10:00", "end": "2026-08-09T15:00",
        "location": "Maker space annex", "people": ["Sarah"]})

    # people become graph edges: the event links to Sarah, Sarah's backlinks
    # include the event, graph_notes sees it.
    g = json.loads(execute("graph_notes", {"title": "Sarah"}))
    assert "Kiln workshop" in {n["title"] for n in g["nodes"]}

    listing = json.loads(execute("list_events",
                                 {"from": "2026-08-09", "to": "2026-08-09"}))
    ev = listing["events"][0]
    assert ev["location"] == "Maker space annex" and ev["people"] == ["Sarah"]

    ics = c.get("/api/events.ics").text
    assert "LOCATION:Maker space annex" in ics
    print("✓ event people are graph edges; location flows to list_events + ICS")


def test_patch_fields_bug_fixed_and_clearing():
    """THE bug: PATCH /api/notes/{title} could not touch typed fields at all."""
    c, cfg, dbp = _fresh()
    _, execute, _ = main._build_tools(dbp)
    path = _approve(c, execute, {
        "title": "Dentist", "body": "Checkup.", "tags": ["event"],
        "start": "2026-08-10T14:00", "location": "Old office"})

    r = c.patch("/api/notes/Dentist", json={
        "fields": {"start": "2026-08-11T09:00", "location": ""}})
    assert r.status_code == 200, r.text
    conn = sqlite3.connect(dbp)
    note = notes_index.get_note_by_title(conn, "Dentist")
    conn.close()
    assert note["event_start"].startswith("2026-08-11T09:00")
    assert "location" not in note["fields"]              # empty string cleared it

    # Validation applies on PATCH too.
    r = c.patch("/api/notes/Dentist", json={"fields": {"state": "started"}})
    assert r.status_code == 422
    print("✓ PATCH edits typed fields (bug fixed); empty string clears; validated")


def test_user_note_bootstrap_and_fields():
    c, cfg, dbp = _fresh()
    vault = cfg["notes"]["vault_dir"]
    conn = sqlite3.connect(dbp)
    stats = notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed)
    assert stats["user_note_created"] is True
    note = notes_index.get_note_by_title(conn, "USER")
    assert note is not None and note["tags"] == ["user-profile"]
    assert "## Significant Relationships" in note["body"]
    # Second reindex: idempotent.
    stats2 = notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed)
    assert stats2["user_note_created"] is False
    conn.close()

    # USER-only fields via PATCH; rejected on other notes.
    r = c.patch("/api/notes/USER", json={
        "fields": {"name": "Alex", "timezone": "America/Chicago",
                   "dob": "1990-05-01"}})
    assert r.status_code == 200, r.text
    conn = sqlite3.connect(dbp)
    note = notes_index.get_note_by_title(conn, "USER")
    conn.close()
    assert note["fields"]["name"] == "Alex"
    assert note["fields"]["timezone"] == "America/Chicago"

    assert c.patch("/api/notes/USER", json={
        "fields": {"timezone": "Mars/Olympus"}}).status_code == 422

    # Satellite with area; area-filtered search finds it.
    _, execute, _ = main._build_tools(dbp)
    out = json.loads(execute("propose_note", {
        "title": "Woodworking obsession", "body": "Deep dive lately.",
        "tags": ["user-profile"], "area": "Interests"}))
    assert "error" not in out
    c.post(f"/api/notes/drafts/{out['draft_id']}/approve")
    hits = json.loads(execute("search_notes",
                              {"query": "", "tag": "user-profile",
                               "area": "interests"}))
    assert [h["title"] for h in hits] == ["Woodworking obsession"]
    print("✓ USER.md scaffolded once; hub fields validated; area crawl works")
