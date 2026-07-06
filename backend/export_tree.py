"""Export the SQLite `turns` table as nested JSON conversation trees.

Reshapes turns into nested trees (one per root conversation) for downstream LLM
synthesis into atomic notes. Pure data reshaping — no LLM involved.

Used two ways:
  - API: GET /api/tree/{turn_id}/export (main.py) calls export_forest/find_tree
  - CLI: python export_tree.py --db conversations.db [--tree-id N] [-o out.json]

Node shape (faithful; every committed turn is its own node):
  { id, parent_turn_id (effective, post-prune), role, content,
    created_at (ISO-8601 UTC), committed, context_turns, branched,
    paragraph_index, model_name, name, state, tags,
    sibling_index, sibling_count, children: [...] }

Rules:
  - Uncommitted turns (committed = 0) are pruned; their committed descendants are
    reattached to the nearest committed ancestor (discards don't cascade in the DB).
  - Orphaned turns (parent id references a row that doesn't exist — only possible
    via manual DB edits; deletes reparent at delete time) are logged and skipped,
    along with their unreachable descendants.
  - Recall blocks and embeddings are deliberately excluded (derivative content).
"""

import argparse
import json
import re
import sqlite3
import sys

# Columns surfaced when present (tolerant of older DBs missing some).
FIELDS = [
    "id", "parent_turn_id", "role", "content", "created_at", "committed",
    "context_turns", "branched", "paragraph_index", "model_name", "name",
    "state", "tags",
]


def _iso(ts):
    """SQLite datetime('now') text (UTC) -> ISO-8601 with Z. Pass through others."""
    if not ts:
        return ts
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})", str(ts).strip())
    return f"{m.group(1)}T{m.group(2)}Z" if m else str(ts)


def _parse_tags(raw):
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(t) for t in raw]
    try:
        v = json.loads(raw)
        if isinstance(v, list):
            return [str(t) for t in v]
    except Exception:
        pass
    return [t.strip() for t in str(raw).split(",") if t.strip()]


def load_turns(conn):
    """Return {id: raw_turn_dict} for all turns, using whichever FIELDS exist."""
    cur = conn.cursor()
    present = {r[1] for r in cur.execute("PRAGMA table_info(turns)")}
    cols = [c for c in FIELDS if c in present]
    turns = {}
    for row in cur.execute(f"SELECT {', '.join(cols)} FROM turns").fetchall():
        d = dict(zip(cols, row))
        turns[d["id"]] = d
    return turns


def _committed(turn):
    return bool(turn.get("committed", 1))


def _effective_parent(turns, tid):
    """Nearest committed ancestor of turn tid, skipping uncommitted rows.

    Returns (parent_id | None, orphaned). orphaned=True when the chain hits a
    parent id whose row doesn't exist (broken link), rather than a true root.
    """
    pid = turns[tid].get("parent_turn_id")
    seen = set()
    while pid is not None:
        if pid in seen:
            return None, True  # cycle: treat as broken
        seen.add(pid)
        parent = turns.get(pid)
        if parent is None:
            return None, True  # dangling reference
        if _committed(parent):
            return pid, False
        pid = parent.get("parent_turn_id")
    return None, False  # walked to a genuine root


def _node(turn):
    return {
        "id": turn["id"],
        "parent_turn_id": None,  # effective parent, set in build_forest
        "role": turn.get("role"),
        "content": turn.get("content"),
        "created_at": _iso(turn.get("created_at")),
        "committed": _committed(turn),
        "context_turns": turn.get("context_turns"),
        "branched": bool(turn.get("branched", 0)),
        "paragraph_index": turn.get("paragraph_index"),
        "model_name": turn.get("model_name"),
        "name": turn.get("name"),
        "state": turn.get("state"),
        "tags": _parse_tags(turn.get("tags")),
        "children": [],
    }


def build_forest(turns, log=None):
    """Build the committed-only forest. Returns a list of root nodes (by id).

    Orphan heads (broken parent link) are logged and left out of the roots list,
    which drops their whole unreachable subtree from the output.
    """
    log = log or (lambda msg: None)
    nodes = {tid: _node(t) for tid, t in turns.items() if _committed(t)}

    roots = []
    for tid in sorted(nodes):
        eff, orphaned = _effective_parent(turns, tid)
        nodes[tid]["parent_turn_id"] = eff
        if orphaned:
            log(f"orphaned turn {tid}: parent chain is broken -> skipped (with its subtree)")
            continue
        if eff is None:
            roots.append(nodes[tid])
        elif eff in nodes:
            nodes[eff]["children"].append(nodes[tid])

    # Order children by id and annotate sibling position/count.
    for node in nodes.values():
        node["children"].sort(key=lambda n: n["id"])
        for i, child in enumerate(node["children"]):
            child["sibling_index"] = i
            child["sibling_count"] = len(node["children"])
    roots.sort(key=lambda n: n["id"])
    for i, root in enumerate(roots):
        root["sibling_index"] = i
        root["sibling_count"] = len(roots)
    return roots


def find_tree(roots, turn_id):
    """Find the node with id == turn_id anywhere in the forest (subtree export)."""
    stack = list(roots)
    while stack:
        node = stack.pop()
        if node["id"] == turn_id:
            return node
        stack.extend(node["children"])
    return None


def export_forest(conn, log=None):
    """Convenience: load turns from an open connection and build the forest."""
    return build_forest(load_turns(conn), log=log)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Export turns as nested JSON trees.")
    ap.add_argument("--db", required=True, help="path to conversations.db")
    ap.add_argument("--tree-id", type=int, default=None,
                    help="export only the subtree rooted at this turn id")
    ap.add_argument("-o", "--output", default=None,
                    help="write JSON to this file (default: stdout)")
    ap.add_argument("--quiet", action="store_true", help="suppress warnings on stderr")
    args = ap.parse_args(argv)

    def log(msg):
        if not args.quiet:
            print(f"warning: {msg}", file=sys.stderr)

    try:
        conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
        try:
            roots = export_forest(conn, log=log)
        finally:
            conn.close()
    except sqlite3.OperationalError as e:
        print(f"error: cannot read db {args.db}: {e}", file=sys.stderr)
        return 1

    if args.tree_id is not None:
        node = find_tree(roots, args.tree_id)
        if node is None:
            log(f"no committed turn {args.tree_id} found")
        roots = [node] if node else []

    payload = json.dumps(roots, indent=2, ensure_ascii=False)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(payload + "\n")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
