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
    notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed, ensure_user=False)
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


def test_ambient_note_hints():
    c, cfg, dbp = _fresh()
    _seed_note(cfg, dbp, "Sarah", "Ceramics person from the maker space.",
               tags=["social-graph"])
    _seed_note(cfg, dbp, "Unrelated", "Totally different topic.")

    # Embeddings are length-vectors in these tests; make the query land near
    # "Sarah"'s note vector so it clears the threshold.
    sarah_len = float(len("Sarah\nCeramics person from the maker space."))
    main.get_embedding = lambda text: [sarah_len, 1.0]

    hint = main._ambient_note_hints(dbp, "met Sarah yesterday")
    assert hint and "[[Sarah]]" in hint and "social-graph" in hint
    assert "Ceramics" not in hint                      # titles only, never bodies

    # Below-threshold matches stay silent.
    cfg["notes"]["ambient_hints_threshold"] = 1.01     # cosine can't reach this
    assert main._ambient_note_hints(dbp, "met Sarah") is None
    cfg["notes"]["ambient_hints_threshold"] = 0.5

    # Config off -> silent; embedding failure -> silent, never raises.
    cfg["notes"]["ambient_hints"] = False
    assert main._ambient_note_hints(dbp, "met Sarah") is None
    cfg["notes"]["ambient_hints"] = True
    main.get_embedding = lambda text: None
    assert main._ambient_note_hints(dbp, "met Sarah") is None
    print("✓ ambient hints: titles-only scent trail, threshold, off-switch, safe")


def test_search_created_range_composes():
    c, cfg, dbp = _fresh()
    vault = cfg["notes"]["vault_dir"]
    os.makedirs(vault, exist_ok=True)
    def _note(title, created, body, tags=""):
        with open(os.path.join(vault, f"{title}.md"), "w", encoding="utf-8") as f:
            f.write(f"---\ncreated: {created}\ntags: [{tags}]\n---\n\n# {title}\n\n{body}\n")
    _note("Old transit idea", "2026-06-01", "transit dreams")
    _note("Fresh transit idea", "2026-07-28", "transit is freedom", tags="decision")
    _note("Fresh unrelated", "2026-07-29", "gardening notes")
    conn = sqlite3.connect(dbp)
    notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed, ensure_user=False)
    conn.close()

    _, execute, _ = main._build_tools(dbp)
    # "notes from this week that mention transit" — one call.
    hits = json.loads(execute("search_notes", {
        "query": "transit", "mode": "keyword", "created_from": "2026-07-27"}))
    assert [h["title"] for h in hits] == ["Fresh transit idea"]
    # Date range alone lists the period.
    hits = json.loads(execute("search_notes", {
        "query": "", "created_from": "2026-07-27", "created_to": "2026-07-28"}))
    assert [h["title"] for h in hits] == ["Fresh transit idea"]
    # Composes with tag too.
    hits = json.loads(execute("search_notes", {
        "query": "", "created_from": "2026-07-01", "tag": "decision"}))
    assert [h["title"] for h in hits] == ["Fresh transit idea"]
    print("✓ search_notes: created range composes with query and tag")


def test_graph_notes_traversal():
    c, cfg, dbp = _fresh()
    _seed_note(cfg, dbp, "Hub", "Links to [[Spoke A]] and [[Spoke B]] and [[Ghost]].")
    _seed_note(cfg, dbp, "Spoke A", "Points at [[Far]].")
    _seed_note(cfg, dbp, "Spoke B", "Standalone.")
    _seed_note(cfg, dbp, "Far", "Two hops out.")
    _seed_note(cfg, dbp, "Inbound", "I reference [[Hub]] too.")

    _, execute, _ = main._build_tools(dbp)

    g = json.loads(execute("graph_notes", {"title": "hub"}))   # case-insensitive
    names = {n["title"] for n in g["nodes"]}
    # Depth 1: links out, backlinks in, ghost included but flagged missing.
    assert names == {"Hub", "Spoke A", "Spoke B", "Ghost", "Inbound"}
    assert any(n.get("missing") for n in g["nodes"] if n["title"] == "Ghost")
    assert "Far" not in names
    assert {"from": "Inbound", "to": "Hub"} in g["edges"]

    g2 = json.loads(execute("graph_notes", {"title": "Hub", "depth": 2}))
    assert "Far" in {n["title"] for n in g2["nodes"]}
    far = next(n for n in g2["nodes"] if n["title"] == "Far")
    assert far["distance"] == 2

    missing = json.loads(execute("graph_notes", {"title": "Nope"}))
    assert "error" in missing
    print("✓ graph_notes: BFS links+backlinks, missing flagged, depth honored")


def test_get_notes_batch_traversal():
    c, cfg, dbp = _fresh()
    _seed_note(cfg, dbp, "Alpha", "Links to [[Beta]] and [[Gamma]].", tags=["decision"])
    _seed_note(cfg, dbp, "Beta", "Beta body.")
    _seed_note(cfg, dbp, "Gamma", "Gamma body.")
    _, execute, _ = main._build_tools(dbp)

    out = json.loads(execute("get_notes", {"titles": ["Alpha", "beta", "Nope"]}))
    assert out[0]["title"] == "Alpha" and out[0]["links"] == ["Beta", "Gamma"]
    assert out[1]["title"] == "Beta" and out[1]["body"] == "Beta body."
    assert out[2] == {"title": "Nope", "error": "no note with this title"}
    assert "error" in json.loads(execute("get_notes", {"titles": []}))
    # search_notes honors an explicit limit.
    hits = json.loads(execute("search_notes",
                              {"query": "body", "mode": "keyword", "limit": 1}))
    assert len(hits) == 1 and "created" in hits[0]
    print("✓ get_notes batch (case-insensitive, misses flagged) + search limit")


def test_propose_event_validated_and_approved_to_frontmatter():
    c, cfg, dbp = _fresh()
    _, execute, _ = main._build_tools(dbp)

    # Fuzzy dates are rejected with a model-facing error (strict ISO only).
    bad = json.loads(execute("propose_note", {
        "title": "Dinner with Sam", "body": "At the taqueria.",
        "tags": ["event"], "start": "next tuesday"}))
    assert "ISO 8601" in bad["error"]
    # An event tag without a start is rejected.
    bad = json.loads(execute("propose_note", {
        "title": "Dinner with Sam", "body": "At the taqueria.", "tags": ["event"]}))
    assert "start" in bad["error"]
    # all_day mismatch is rejected.
    bad = json.loads(execute("propose_note", {
        "title": "Dinner with Sam", "body": "x", "tags": ["event"],
        "start": "2026-08-02T19:00", "all_day": True}))
    assert "all-day" in bad["error"] or "all_day" in bad["error"]

    # Valid timed event -> draft with typed fields (no YAML from the model).
    ok = json.loads(execute("propose_note", {
        "title": "Dinner with Sam", "body": "Taqueria with [[Sam]].",
        "tags": ["event"], "start": "2026-08-02T19:00",
        "end": "2026-08-02T21:00"}))
    assert ok["status"] == "pending"
    import db as _db, sqlite3 as _sq
    conn = _sq.connect(dbp)
    draft = _db.get_note_draft(conn, ok["draft_id"])
    conn.close()
    assert draft["fields"] == {"start": "2026-08-02T19:00",
                               "end": "2026-08-02T21:00", "all_day": False}

    # Approval writes app-serialized frontmatter, stamping the local offset.
    r = c.post(f"/api/notes/drafts/{ok['draft_id']}/approve")
    assert r.status_code == 200
    raw = open(r.json()["path"], encoding="utf-8").read()
    import re as _re
    assert _re.search(r"start: 2026-08-02T19:00[+-]\d{2}:\d{2}", raw)
    assert "all_day" not in raw          # false -> omitted

    # The approved event is immediately visible to list_events.
    listing = json.loads(execute("list_events", {"from": "2026-08-01",
                                                 "to": "2026-08-03"}))
    assert listing["count"] == 1
    ev = listing["events"][0]
    assert ev["title"] == "Dinner with Sam" and ev["links"] == ["Sam"]
    assert ev["start"].startswith("2026-08-02T19:00")
    print("✓ event proposal: strict validation, typed fields, offset stamped, listed")


def test_events_ics_export():
    c, cfg, dbp = _fresh()
    vault = cfg["notes"]["vault_dir"]
    os.makedirs(vault, exist_ok=True)
    with open(os.path.join(vault, "Team offsite.md"), "w", encoding="utf-8") as f:
        f.write("---\ntags: [event]\nstart: 2026-08-05\nend: 2026-08-06\n"
                "all_day: true\n---\n\n# Team offsite\n\nTwo days, with [[Sam]].\n")
    with open(os.path.join(vault, "Dentist.md"), "w", encoding="utf-8") as f:
        f.write("---\ntags: [event]\nstart: 2026-08-02T14:00-05:00\n---\n\n"
                "# Dentist\n\nCheckup; note the , and ; escaping.\n")
    conn = sqlite3.connect(dbp)
    notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed, ensure_user=False)
    conn.close()

    r = c.get("/api/events.ics")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/calendar")
    text = r.text
    assert text.count("BEGIN:VEVENT") == 2
    assert "SUMMARY:Team offsite" in text
    assert "DTSTART;VALUE=DATE:20260805" in text
    assert "DTEND;VALUE=DATE:20260807" in text          # all-day DTEND exclusive
    assert "DTSTART:20260802T190000Z" in text           # 14:00-05:00 -> UTC
    assert "\\," in text and "\\;" in text              # DESCRIPTION escaping
    # Windowed export filters.
    r2 = c.get("/api/events.ics?from=2026-08-04&to=2026-08-08")
    assert r2.text.count("BEGIN:VEVENT") == 1 and "Team offsite" in r2.text
    print("✓ .ics export: all-day + timed-UTC forms, escaping, windowing")


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
