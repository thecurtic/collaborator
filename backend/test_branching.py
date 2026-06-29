"""Tests for conversation branching: schema migration, ancestor context, tree, endpoints."""

import os
import sqlite3
import tempfile


def _fresh_env():
    """Point the app at a fresh temp DB with auth disabled."""
    d = tempfile.mkdtemp()
    os.environ["AUTH_ENABLED"] = "false"
    os.environ["DB_PATH"] = os.path.join(d, "conversations.db")
    import config
    config.get_config._config = config.load_config()
    import importlib, db, main
    importlib.reload(db)
    importlib.reload(main)
    return main, db


def test_migration_backfills_linear_chain():
    """An OLD-schema turns table gets branching columns + a linear parent chain."""
    d = tempfile.mkdtemp()
    path = os.path.join(d, "old.db")
    conn = sqlite3.connect(path)
    conn.execute("""
        CREATE TABLE turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
            context_turns INTEGER NOT NULL DEFAULT 5,
            committed BOOLEAN NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            model_name TEXT, token_count INTEGER, tags TEXT
        )
    """)
    for r, c in [("user", "a"), ("assistant", "b"), ("user", "c")]:
        conn.execute("INSERT INTO turns (role, content) VALUES (?, ?)", (r, c))
    conn.commit()
    conn.close()

    import importlib, db
    importlib.reload(db)
    conn = sqlite3.connect(path)
    db.ensure_conversation_schema(conn)

    cols = {row[1] for row in conn.execute("PRAGMA table_info(turns)").fetchall()}
    assert "parent_turn_id" in cols and "paragraph_index" in cols

    rows = conn.execute("SELECT id, parent_turn_id FROM turns ORDER BY id").fetchall()
    assert rows[0][1] is None                  # first turn is the root
    assert rows[1][1] == rows[0][0]            # each links to the previous
    assert rows[2][1] == rows[1][0]
    conn.close()
    print("✓ migration backfills linear chain")


def test_ancestor_chain_inclusive_and_ordered():
    main, db = _fresh_env()
    conn = sqlite3.connect(os.environ["DB_PATH"])
    t1 = db.create_turn(conn, None, "user", "root")
    t2 = db.create_turn(conn, None, "assistant", "a1", parent_turn_id=t1["id"])
    t3 = db.create_turn(conn, None, "user", "q2", parent_turn_id=t2["id"])
    # a divergent branch off t1 that must NOT appear in t3's chain
    db.create_turn(conn, None, "user", "other", parent_turn_id=t1["id"])

    chain = db.get_ancestor_chain(conn, t3["id"])
    assert [t["content"] for t in chain] == ["root", "a1", "q2"]   # oldest-first, inclusive

    limited = db.get_ancestor_chain(conn, t3["id"], limit=2)
    assert [t["content"] for t in limited] == ["a1", "q2"]         # most recent 2
    conn.close()
    print("✓ ancestor chain is inclusive, ordered, branch-isolated")


def test_tree_structure():
    main, db = _fresh_env()
    conn = sqlite3.connect(os.environ["DB_PATH"])
    t1 = db.create_turn(conn, None, "user", "root")
    t2 = db.create_turn(conn, None, "assistant", "reply", parent_turn_id=t1["id"])
    db.create_turn(conn, None, "user", "branchA", parent_turn_id=t2["id"])
    db.create_turn(conn, None, "user", "branchB", parent_turn_id=t2["id"], paragraph_index=1)
    conn.close()

    roots = db.get_turn_tree(conn := sqlite3.connect(os.environ["DB_PATH"]))
    conn.close()
    assert len(roots) == 1
    assert roots[0]["content"] == "root"
    assert len(roots[0]["children"][0]["children"]) == 2   # t2 has two branches
    labels = {c["content"] for c in roots[0]["children"][0]["children"]}
    assert labels == {"branchA", "branchB"}
    print("✓ tree nests branches under their fork point")


def test_branch_endpoint_and_tree_api():
    main, db = _fresh_env()
    from starlette.testclient import TestClient

    # Mock the LLM with a deterministic multi-paragraph reply.
    def fake_stream(message, context_turns=None, mode=None):
        for tok in ["First idea.", "\n\n", "Second idea.", "\n\n", "Third idea."]:
            yield tok
    main.stream_llm_tokens = fake_stream

    c = TestClient(main.app)

    # Seed a normal turn → becomes the head.
    r1 = c.post("/api/messages", json={"message": "hello", "context_turns": 5})
    assert r1.status_code == 200 and '"type": "done"' in r1.text

    # The assistant turn should be branchable by paragraph.
    hist = c.get("/api/messages").json()
    assistant = next(t for t in hist["turns"] if t["role"] == "assistant")
    assert assistant["paragraphs"] == ["First idea.", "Second idea.", "Third idea."]
    fork_id = assistant["id"]

    # Branch from paragraph index 1 of that assistant turn.
    rb = c.post(f"/api/branches/{fork_id}", json={"message": "tell me more about the second",
                                                  "paragraph_index": 1, "context_turns": 5})
    assert rb.status_code == 200
    import json as _json
    done = [ _json.loads(l[6:]) for l in rb.text.splitlines()
             if l.startswith("data: ") and '"done"' in l ][0]
    assert done["parent_turn_id"] == fork_id
    assert done["paragraph_index"] == 1

    # The new user turn should hang off the fork point with the right paragraph index.
    conn = sqlite3.connect(os.environ["DB_PATH"])
    branch_user = db.get_turn_by_id(conn, done["user_turn_id"])
    conn.close()
    assert branch_user["parent_turn_id"] == fork_id
    assert branch_user["paragraph_index"] == 1

    # Tree API reflects the branch.
    tree = c.get("/api/tree").json()
    assert tree["count"] >= 4
    assert len(tree["roots"]) == 1

    # Out-of-range paragraph → 422; missing parent → 404.
    assert c.post(f"/api/branches/{fork_id}", json={"message": "x", "paragraph_index": 99}).status_code == 422
    assert c.post("/api/branches/99999", json={"message": "x"}).status_code == 404
    print("✓ branch endpoint, tree API, and validation all work")


if __name__ == "__main__":
    test_migration_backfills_linear_chain()
    test_ancestor_chain_inclusive_and_ordered()
    test_tree_structure()
    test_branch_endpoint_and_tree_api()
    print("\n✓ All branching tests passed!")
