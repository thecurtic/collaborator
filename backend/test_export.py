"""Tests for export_tree: pruning/reparenting, orphans, subtree export, endpoint, CLI."""

import os
import json
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, export_tree
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def _fresh_db():
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    # Refresh the config singleton so main._resolve_db_path sees the new path.
    config.get_config._config = config.load_config()
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return path


def test_forest_structure_and_metadata():
    path = _fresh_db()
    conn = sqlite3.connect(path)
    r = db.create_turn(conn, None, "user", "root q", state="tree")
    a = db.create_turn(conn, None, "assistant", "answer", parent_turn_id=r["id"], state="tree")
    b1 = db.create_turn(conn, None, "user", "branch one", parent_turn_id=a["id"],
                        branched=True, paragraph_index=1, state="tree")
    b2 = db.create_turn(conn, None, "user", "branch two", parent_turn_id=a["id"], state="tree")
    r2 = db.create_turn(conn, None, "user", "second conversation")

    roots = export_tree.export_forest(conn)
    conn.close()

    assert [n["id"] for n in roots] == [r["id"], r2["id"]]          # multiple roots
    root = roots[0]
    assert root["parent_turn_id"] is None and root["state"] == "tree"
    assert "T" in root["created_at"] and root["created_at"].endswith("Z")   # ISO-8601
    (an,) = root["children"]
    kids = an["children"]
    assert [k["id"] for k in kids] == [b1["id"], b2["id"]]
    assert kids[0]["branched"] is True and kids[0]["paragraph_index"] == 1
    assert kids[0]["sibling_index"] == 0 and kids[0]["sibling_count"] == 2
    assert kids[1]["sibling_index"] == 1
    # excluded fields stay excluded
    assert "recall" not in root and "embedding" not in root and "recall_content" not in root
    print("✓ forest structure, siblings, ISO timestamps, exclusions")


def test_prune_reparents_committed_descendants():
    path = _fresh_db()
    conn = sqlite3.connect(path)
    r = db.create_turn(conn, None, "user", "kept root")
    ghost = db.create_turn(conn, None, "assistant", "discarded", parent_turn_id=r["id"],
                           committed=False)
    child = db.create_turn(conn, None, "user", "survivor", parent_turn_id=ghost["id"])

    roots = export_tree.export_forest(conn)
    conn.close()

    assert len(roots) == 1
    root = roots[0]
    assert [c["id"] for c in root["children"]] == [child["id"]]      # reparented up
    assert root["children"][0]["parent_turn_id"] == r["id"]          # effective parent
    ids = {root["id"], *(c["id"] for c in root["children"])}
    assert ghost["id"] not in ids                                    # pruned
    print("✓ uncommitted turn pruned; committed child reparented to grandparent")


def test_orphans_logged_and_skipped():
    path = _fresh_db()
    conn = sqlite3.connect(path)
    ok = db.create_turn(conn, None, "user", "healthy root")
    # manual DB surgery: a turn pointing at a nonexistent parent, plus its child
    cur = conn.cursor()
    cur.execute("INSERT INTO turns (role, content, parent_turn_id) VALUES ('user', 'orphan', 9999)")
    orphan_id = cur.lastrowid
    cur.execute("INSERT INTO turns (role, content, parent_turn_id) VALUES ('assistant', 'orphan child', ?)",
                (orphan_id,))
    conn.commit()

    warnings = []
    roots = export_tree.export_forest(conn, log=warnings.append)
    conn.close()

    assert [n["id"] for n in roots] == [ok["id"]]                    # orphan subtree gone
    assert any("orphaned" in w for w in warnings)                    # and logged
    print("✓ orphaned subtree skipped and logged")


def test_subtree_export_and_endpoint():
    path = _fresh_db()
    conn = sqlite3.connect(path)
    r = db.create_turn(conn, None, "user", "root")
    a = db.create_turn(conn, None, "assistant", "mid", parent_turn_id=r["id"])
    leaf = db.create_turn(conn, None, "user", "leaf", parent_turn_id=a["id"])
    conn.close()

    c = TestClient(main.app)
    # whole conversation from the root
    full = c.get(f"/api/tree/{r['id']}/export").json()["tree"]
    assert full["id"] == r["id"] and full["children"][0]["children"][0]["id"] == leaf["id"]
    # subtree from a mid-tree turn (branch export)
    sub = c.get(f"/api/tree/{a['id']}/export").json()["tree"]
    assert sub["id"] == a["id"] and [k["id"] for k in sub["children"]] == [leaf["id"]]
    # missing turn -> 404
    assert c.get("/api/tree/99999/export").status_code == 404
    print("✓ endpoint exports full tree, subtree, 404s on missing")


def test_cli_writes_json():
    path = _fresh_db()
    conn = sqlite3.connect(path)
    r = db.create_turn(conn, None, "user", "cli root")
    db.create_turn(conn, None, "assistant", "cli reply", parent_turn_id=r["id"])
    conn.close()

    out = os.path.join(tempfile.mkdtemp(), "out.json")
    rc = export_tree.main(["--db", path, "-o", out, "--quiet"])
    assert rc == 0
    data = json.load(open(out, encoding="utf-8"))
    assert isinstance(data, list) and data[0]["id"] == r["id"]
    # --tree-id filters to one subtree
    rc = export_tree.main(["--db", path, "--tree-id", str(r["id"]), "-o", out, "--quiet"])
    data = json.load(open(out, encoding="utf-8"))
    assert len(data) == 1 and data[0]["id"] == r["id"]
    # unknown tree id -> empty list
    rc = export_tree.main(["--db", path, "--tree-id", "424242", "-o", out, "--quiet"])
    assert json.load(open(out, encoding="utf-8")) == []
    print("✓ CLI writes JSON, --tree-id filters, empty for unknown id")


if __name__ == "__main__":
    test_forest_structure_and_metadata()
    test_prune_reparents_committed_descendants()
    test_orphans_logged_and_skipped()
    test_subtree_export_and_endpoint()
    test_cli_writes_json()
    print("\n✓ All export tests passed!")
