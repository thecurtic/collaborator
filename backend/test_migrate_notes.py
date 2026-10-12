"""Tests for the 2026-10-12 vault migration (backend/data/migrate_notes.py):
state and due leave the frontmatter; everything else stays byte-identical."""

import importlib.util
import json
import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
import config
import notes_index

_spec = importlib.util.spec_from_file_location(
    "migrate_notes", os.path.join(os.path.dirname(__file__), "data",
                                  "migrate_notes.py"))
migrate_notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migrate_notes)

GOAL = """---
created: 2026-07-06
tags: [goal, woodworking]
source_turns: [42, 47]
state: started
due: '2026-09-30'
custom: kept by obsidian
---

# Learn woodworking

Build a bench by the end of September. [[Workshop]]
"""

PROJECT = """---
created: 2026-08-01
state: paused
tags:
- project
- garden
---

# Raised beds

Three beds along the fence.
"""

PLAIN = """---
created: 2026-07-06
tags: [decision]
---

# SQLite fits

Zero ops.
"""


def _vault(files):
    vault = os.path.join(tempfile.mkdtemp(), "notes")
    os.makedirs(vault)
    for name, raw in files.items():
        with open(os.path.join(vault, name), "w", encoding="utf-8") as f:
            f.write(raw)
    return vault


def _read(vault, name):
    with open(os.path.join(vault, name), encoding="utf-8") as f:
        return f.read()


def test_strips_only_removed_keys_byte_identical_otherwise():
    vault = _vault({"Learn woodworking.md": GOAL, "Raised beds.md": PROJECT,
                    "SQLite fits.md": PLAIN})
    lines = []
    stats = migrate_notes.migrate_vault(vault, out=lines.append)
    assert stats == {"notes": 3, "changed": 2, "skipped": 0, "reindexed": 0}

    assert _read(vault, "Learn woodworking.md") == GOAL.replace(
        "state: started\ndue: '2026-09-30'\n", "")
    assert _read(vault, "Raised beds.md") == PROJECT.replace("state: paused\n", "")
    assert _read(vault, "SQLite fits.md") == PLAIN               # untouched
    # The removed values are reported, so nothing vanishes silently.
    assert any("state=started" in l and "due=2026-09-30" in l for l in lines)

    note = notes_index.parse_note_file(os.path.join(vault, "Learn woodworking.md"))
    assert note["tags"] == ["goal", "woodworking"]
    assert note["front"]["custom"] == "kept by obsidian"
    assert note["source_turns"] == [42, 47]
    print("✓ migration strips state/due only; tags, keys and body intact")


def test_rerun_is_a_noop_and_dry_run_writes_nothing():
    vault = _vault({"Learn woodworking.md": GOAL})
    dry = migrate_notes.migrate_vault(vault, dry_run=True, out=lambda s: None)
    assert dry["changed"] == 1 and _read(vault, "Learn woodworking.md") == GOAL

    migrate_notes.migrate_vault(vault, out=lambda s: None)
    once = _read(vault, "Learn woodworking.md")
    again = migrate_notes.migrate_vault(vault, out=lambda s: None)
    assert again["changed"] == 0 and _read(vault, "Learn woodworking.md") == once
    assert not [n for n in os.listdir(vault) if n.startswith(".migrate-")]
    print("✓ dry run writes nothing; re-running changes nothing")


def test_unusual_layouts():
    block_due = ("---\ntags: [goal]\ndue:\n  2026-09-30\nnote: x\n---\n\n"
                 "# Odd\n\nBody.\n")
    only_state = "---\nstate: open\n---\n\n# Bare\n\nBody.\n"
    broken = "---\ntags: [goal\nstate: open\n---\n\n# Broken\n\nBody.\n"
    no_front = "# Loose\n\nNo frontmatter at all.\n"
    vault = _vault({"Odd.md": block_due, "Bare.md": only_state,
                    "Broken.md": broken, "Loose.md": no_front})
    stats = migrate_notes.migrate_vault(vault, out=lambda s: None)
    assert stats["changed"] == 2 and stats["skipped"] == 1

    assert _read(vault, "Odd.md") == ("---\ntags: [goal]\nnote: x\n---\n\n"
                                      "# Odd\n\nBody.\n")
    assert _read(vault, "Bare.md") == "# Bare\n\nBody.\n"     # empty block gone
    assert _read(vault, "Broken.md") == broken                # never guessed at
    assert _read(vault, "Loose.md") == no_front
    print("✓ block values, emptied frontmatter, unreadable YAML, no frontmatter")


def test_index_refreshed_and_embeddings_kept():
    vault = _vault({"Learn woodworking.md": GOAL, "SQLite fits.md": PLAIN})
    db_path = os.path.join(os.path.dirname(vault), "conversations.db")
    import db
    conn = sqlite3.connect(db_path)
    db.ensure_conversation_schema(conn)
    notes_index.reindex_vault(conn, vault,
                              embed_fn=lambda texts: [[1.0, 2.0] for _ in texts],
                              ensure_user=False)
    # Simulate a pre-change index row that still holds state.
    conn.execute("UPDATE notes_index SET fields = ? WHERE title = ?",
                 (json.dumps({"state": "started"}), "Learn woodworking"))
    conn.commit()
    conn.close()

    stats = migrate_notes.migrate_vault(vault, db_path, out=lambda s: None)
    assert stats["reindexed"] == 1

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT fields, embedding FROM notes_index WHERE title = ?",
                       ("Learn woodworking",)).fetchone()
    conn.close()
    assert json.loads(row[0]) == {}
    assert row[1] is not None                                 # embedding kept
    print("✓ index rows of migrated notes refreshed, embeddings kept")


def test_find_vaults_matches_the_app():
    root = tempfile.mkdtemp()
    users = os.path.join(root, "users")
    for h in ("aaa111", "bbb222"):
        os.makedirs(os.path.join(users, h))
        open(os.path.join(users, h, "conversations.db"), "w").close()
    os.makedirs(os.path.join(users, "no-db-here"))
    cfg = {"authentication": {"enabled": True, "users_dir": users},
           "notes": {"vault_dir": None}, "memory": {}}
    assert migrate_notes.find_vaults(cfg) == [
        (os.path.join(users, "aaa111", "notes"),
         os.path.join(users, "aaa111", "conversations.db")),
        (os.path.join(users, "bbb222", "notes"),
         os.path.join(users, "bbb222", "conversations.db"))]

    cfg["notes"]["vault_dir"] = "/srv/vaults"
    assert [v for v, _ in migrate_notes.find_vaults(cfg)] == [
        "/srv/vaults/aaa111", "/srv/vaults/bbb222"]

    single = {"authentication": {"enabled": False}, "notes": {},
              "memory": {"db_path": os.path.join(root, "conversations.db")}}
    assert migrate_notes.find_vaults(single) == [
        (os.path.join(root, "notes"), os.path.join(root, "conversations.db"))]
    print("✓ vault discovery agrees with the app's per-user resolution")
