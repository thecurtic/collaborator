"""Tests for the 2026-10-27 branch migration (backend/data/migrate_branches.py):
branch names cleared, chat names kept, without-context branches split off
into their own chats."""

import importlib.util
import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
import db

_spec = importlib.util.spec_from_file_location(
    "migrate_branches", os.path.join(os.path.dirname(__file__), "data",
                                     "migrate_branches.py"))
migrate_branches = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migrate_branches)


def _db():
    path = os.path.join(tempfile.mkdtemp(), "conversations.db")
    conn = sqlite3.connect(path)
    db.ensure_conversation_schema(conn)
    return path, conn


def _fixture():
    """root -> a -> (continuation u2 -> a2) and (reset r1 -> ra1 -> nested
    reset r2 -> ra2). Root named and tagged, a branch named."""
    path, conn = _db()
    root = db.create_turn(conn, None, "user", "root", state="tree")
    a = db.create_turn(conn, None, "assistant", "a", parent_turn_id=root["id"])
    u2 = db.create_turn(conn, None, "user", "u2", parent_turn_id=a["id"])
    db.create_turn(conn, None, "assistant", "a2", parent_turn_id=u2["id"])
    r1 = db.create_turn(conn, None, "user", "r1", parent_turn_id=a["id"],
                        context_turns=0, branched=True, paragraph_index=1)
    ra1 = db.create_turn(conn, None, "assistant", "ra1", parent_turn_id=r1["id"],
                         context_turns=0)
    r2 = db.create_turn(conn, None, "user", "r2", parent_turn_id=ra1["id"],
                        context_turns=0, branched=True)
    ra2 = db.create_turn(conn, None, "assistant", "ra2", parent_turn_id=r2["id"],
                         context_turns=0)
    db.update_turn_name(conn, root["id"], "Garden chat")
    db.update_turn_name(conn, r1["id"], "My branch")
    db.set_chat_tags(conn, root["id"], ["garden"])
    db.set_chat_summary(conn, root["id"], {"text": "old", "turns": 8})
    conn.execute("INSERT INTO tool_calls (root_id, turn_id, tool, category, outcome) "
                 "VALUES (?, ?, 'search_notes', 'read', 'ok')", (root["id"], ra2["id"]))
    conn.commit()
    conn.close()
    return path, {"root": root["id"], "a": a["id"], "r1": r1["id"], "r2": r2["id"],
                  "ra1": ra1["id"], "ra2": ra2["id"]}


def _row(path, tid, cols):
    conn = sqlite3.connect(path)
    try:
        return conn.execute(f"SELECT {cols} FROM turns WHERE id = ?", (tid,)).fetchone()
    finally:
        conn.close()


def test_dry_run_writes_nothing():
    path, ids = _fixture()
    lines = []
    s = migrate_branches.migrate_db(path, 20, dry_run=True, out=lines.append)
    assert s["names_cleared"] == 1 and s["chat_names_kept"] == 1
    assert s["branches_split"] == 2
    assert _row(path, ids["r1"], "parent_turn_id, name") == (ids["a"], "My branch")
    assert any("would split" in l for l in lines)


def test_migration_splits_resets_and_clears_branch_names():
    path, ids = _fixture()
    s = migrate_branches.migrate_db(path, 20, out=lambda *_: None)
    assert s["branches_split"] == 2 and s["names_cleared"] == 1

    # Chat name kept; branch name gone.
    assert _row(path, ids["root"], "name")[0] == "Garden chat"
    assert _row(path, ids["r1"], "name")[0] is None

    # Both resets are roots now, carrying the old chat's state and tags.
    for key in ("r1", "r2"):
        parent, branched, para, state, tags = _row(
            path, ids[key], "parent_turn_id, branched, paragraph_index, state, chat_tags")
        assert parent is None and branched == 0 and para is None
        assert state == "tree" and '"garden"' in tags

    # Subtrees came along; the nested split hangs off nothing.
    assert _row(path, ids["ra1"], "parent_turn_id")[0] == ids["r1"]
    assert _row(path, ids["ra2"], "parent_turn_id")[0] == ids["r2"]

    # Nothing looks like a reset any more; the old chat is marked for refresh.
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT COUNT(*) FROM turns WHERE context_turns = 0").fetchone()[0] == 0
    assert conn.execute("SELECT root_id FROM tool_calls").fetchone()[0] == ids["r2"]
    conn.close()
    assert _row(path, ids["root"], "title_turns, summary") == (0, None)

    # The ancestor chain of the split branch starts at its new root.
    conn = sqlite3.connect(path)
    chain = [t["content"] for t in db.get_ancestor_chain(conn, ids["ra1"])]
    conn.close()
    assert chain == ["r1", "ra1"]


def test_rerun_is_a_no_op():
    path, _ = _fixture()
    migrate_branches.migrate_db(path, 20, out=lambda *_: None)
    s = migrate_branches.migrate_db(path, 20, out=lambda *_: None)
    assert s["names_cleared"] == 0 and s["branches_split"] == 0
    assert s["windows_reset"] == 0
