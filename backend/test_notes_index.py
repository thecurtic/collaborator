"""Tests for the notes index: parsing, reconcile, backlinks, search, endpoints —
and the Nostr-foresight invariant (graph rebuildable from files alone)."""

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
    cfg["notes"]["bootstrap_user_note"] = False   # deterministic vault contents
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), cfg["notes"]["vault_dir"], path


def _write(vault, title, body, tags=None, source_turns=None):
    os.makedirs(vault, exist_ok=True)
    front = ["---", "created: 2026-07-06"]
    if tags:
        front.append(f"tags: [{', '.join(tags)}]")
    if source_turns:
        front.append(f"source_turns: [{', '.join(map(str, source_turns))}]")
    front.append("---")
    path = os.path.join(vault, f"{title}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(front) + f"\n\n# {title}\n\n{body}\n")
    return path


def _fake_embed(texts):
    # Deterministic 2-dim vectors: length-based, so similar lengths score together.
    return [[float(len(t)), 1.0] for t in texts]


def test_parse_and_wikilinks():
    _, vault, _ = _fresh()
    p = _write(vault, "Alpha claim", "Links to [[Beta claim]] and [[Beta claim|an alias]] "
               "plus [[Gamma claim#section]].", tags=["decision"], source_turns=[3, 4])
    note = notes_index.parse_note_file(p)
    assert note["title"] == "Alpha claim"
    assert note["links"] == ["Beta claim", "Gamma claim"]      # alias/heading stripped, deduped
    assert note["tags"] == ["decision"] and note["source_turns"] == [3, 4]
    assert "# Alpha claim" not in note["body"]                 # H1 separated from body
    print("✓ parse: frontmatter, H1, wikilinks (alias/heading/dedupe)")


def test_reindex_reconciles_and_backlinks():
    _, vault, dbp = _fresh()
    _write(vault, "Alpha claim", "See [[Beta claim]].")
    _write(vault, "Beta claim", "Standalone.")
    conn = sqlite3.connect(dbp)

    stats = notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed, ensure_user=False)
    assert stats["added"] == 2 and stats["total"] == 2

    # Backlinks derive from content edges.
    back = notes_index.get_backlinks(conn, "Beta claim")
    assert [n["title"] for n in back] == ["Alpha claim"]

    # Edit one file -> updated; delete the other -> removed.
    _write(vault, "Alpha claim", "Rewritten, no links now.")
    os.remove(os.path.join(vault, "Beta claim.md"))
    stats = notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed, ensure_user=False)
    assert stats["updated"] == 1 and stats["removed"] == 1 and stats["total"] == 1
    assert notes_index.get_backlinks(conn, "Beta claim") == []
    conn.close()
    print("✓ reindex: add/update/remove reconcile; backlinks follow content")


def test_graph_reconstructable_from_files_alone():
    """THE invariant: drop the index entirely; rebuilding from files yields the
    identical graph (titles, links, tags). This is what keeps a future
    Nostr round-trip (kind-1 events) reconstructable."""
    _, vault, dbp = _fresh()
    _write(vault, "A", "Points at [[B]] and [[C]].", tags=["concept"])
    _write(vault, "B", "Points back at [[A]].", tags=["decision", "databases"])
    _write(vault, "C", "Leaf note.", tags=["open-question"])
    conn = sqlite3.connect(dbp)

    notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed, ensure_user=False)
    def graph(c):
        return {n["title"]: (sorted(n["links"]), sorted(n["tags"]))
                for n in notes_index.list_notes(c)}
    before = graph(conn)

    conn.execute("DROP TABLE notes_index")   # nuke the cache completely
    conn.commit()
    db.ensure_conversation_schema(conn)
    notes_index.reindex_vault(conn, vault, ensure_user=False)   # rebuild purely from files
    after = graph(conn)
    conn.close()

    assert before == after and len(after) == 3
    print("✓ INVARIANT: graph identical after full index rebuild from files alone")


def test_search_semantic_and_keyword():
    _, vault, dbp = _fresh()
    _write(vault, "Short", "tiny")
    _write(vault, "A much longer note title", "this body is considerably longer than the other one")
    conn = sqlite3.connect(dbp)
    notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed, ensure_user=False)

    # Semantic: query vector near the long note's length-vector ranks it first.
    long_len = float(len("A much longer note title\nthis body is considerably longer than the other one"))
    res = notes_index.search_notes_semantic(conn, [long_len, 1.0], limit=2)
    assert res[0]["title"] == "A much longer note title"

    res = notes_index.search_notes_keyword(conn, "considerably longer", limit=5)
    assert res and res[0]["title"] == "A much longer note title"
    conn.close()
    print("✓ semantic + keyword search over the index")


def test_search_tag_filter_and_tag_only_listing():
    _, vault, dbp = _fresh()
    _write(vault, "Curtis prefers tailnet deploys", "profile fact", tags=["user-profile"])
    _write(vault, "Sam", "friend from the maker space", tags=["social-graph"])
    _write(vault, "Unrelated idea", "no category tag here")
    conn = sqlite3.connect(dbp)
    notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed, ensure_user=False)

    # Keyword search constrained to a tag never returns untagged notes.
    res = notes_index.search_notes_keyword(conn, "idea fact friend", tag="user-profile")
    assert [n["title"] for n in res] == ["Curtis prefers tailnet deploys"]

    # Tag with no query = the whole category ("the full user profile").
    res = notes_index.search_notes_keyword(conn, "", tag="social-graph")
    assert [n["title"] for n in res] == ["Sam"]
    assert notes_index.search_notes_keyword(conn, "", tag=None) == []

    # Semantic search honors the same filter.
    res = notes_index.search_notes_semantic(conn, [10.0, 1.0], limit=5, tag="user-profile")
    assert [n["title"] for n in res] == ["Curtis prefers tailnet deploys"]
    conn.close()
    print("✓ tag filter: scoped search + tag-only category listing")


def test_event_fields_indexed_and_windowed():
    _, vault, dbp = _fresh()
    os.makedirs(vault, exist_ok=True)
    def _event(title, front_lines, body="details"):
        with open(os.path.join(vault, f"{title}.md"), "w", encoding="utf-8") as f:
            f.write("---\n" + "\n".join(front_lines) + "\n---\n\n"
                    f"# {title}\n\n{body}\n")
    _event("Dentist", ["tags: [event]", "start: 2026-08-02T14:00-05:00",
                       "end: 2026-08-02T15:00-05:00"])
    _event("Conference", ["tags: [event]", "start: 2026-08-01", "end: 2026-08-10",
                          "all_day: true"])
    _event("Later dinner", ["tags: [event]", "start: 2026-09-01T19:00-05:00"])
    _event("Dated but not event", ["tags: [memory]", "start: 2026-08-02"])
    _event("Event without start", ["tags: [event]"])
    conn = sqlite3.connect(dbp)
    notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed, ensure_user=False)

    # YAML hands back datetime/date objects; both normalize to ISO strings.
    dentist = notes_index.get_note_by_title(conn, "Dentist")
    assert dentist["event_start"] == "2026-08-02T14:00-05:00"
    assert dentist["event_all_day"] is False
    conf = notes_index.get_note_by_title(conn, "Conference")
    assert conf["event_start"] == "2026-08-01" and conf["event_all_day"] is True

    # Window: overlapping events only, tagged 'event' only, sorted by start.
    events = notes_index.list_events(conn, "2026-08-02", "2026-08-04")
    assert [e["title"] for e in events] == ["Conference", "Dentist"]
    assert notes_index.list_events(conn, "2026-08-20", "2026-08-25") == []
    assert [e["title"] for e in notes_index.list_events(conn)] == [
        "Conference", "Dentist", "Later dinner"]
    conn.close()
    print("✓ event frontmatter indexed; window overlap + tag gating + sorting")


def test_endpoints_and_approve_hook():
    c, vault, dbp = _fresh()
    main.embed_texts = _fake_embed

    # Approving a draft indexes the note immediately.
    d = c.post("/api/notes/drafts", json={
        "title": "Indexed on approval",
        "body": "Body linking to [[Some other note]].",
        "tags": ["decision"], "source_turns": [7],
    }).json()["draft"]
    assert c.post(f"/api/notes/drafts/{d['id']}/approve").status_code == 200

    r = c.get("/api/notes")
    assert r.json()["count"] == 1
    note = c.get("/api/notes/Indexed on approval").json()["note"]
    assert note["links"] == ["Some other note"] and note["source_turns"] == [7]
    assert note["backlinks"] == []

    # Vault edited outside the app -> reindex reconciles.
    _write(vault, "Some other note", "Refers to [[Indexed on approval]].")
    stats = c.post("/api/notes/reindex").json()
    assert stats["added"] == 1 and stats["total"] == 2
    note = c.get("/api/notes/Indexed on approval").json()["note"]
    assert [b["title"] for b in note["backlinks"]] == ["Some other note"]

    # Filters, search endpoint, 404, and route precedence with /drafts.
    assert c.get("/api/notes?tag=decision").json()["count"] == 1
    assert c.get("/api/notes/search?q=refers&mode=keyword").json()["count"] >= 1
    assert c.get("/api/notes/No such note").status_code == 404
    assert "drafts" in c.get("/api/notes/drafts").json()   # literal route still wins
    print("✓ endpoints: approve-hook indexing, reindex, get+backlinks, search, 404")


if __name__ == "__main__":
    test_parse_and_wikilinks()
    test_reindex_reconciles_and_backlinks()
    test_graph_reconstructable_from_files_alone()
    test_search_semantic_and_keyword()
    test_endpoints_and_approve_hook()
    print("\n✓ All notes-index tests passed!")
