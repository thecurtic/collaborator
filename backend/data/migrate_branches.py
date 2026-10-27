"""CLI: retire manual branch names and without-context branches (2026-10-27).

Branches are no longer named by hand (labels are generated) and every branch
runs from the root. This migration, per conversation DB:

- clears `name` on every NON-root turn (chat names on roots are kept);
- splits each without-context branch (a user turn with context_turns == 0
  under a parent) off into its own chat: the turn becomes a root, keeps its
  subtree, inherits the old chat's state and tags, and its tool-log rows are
  re-pointed at the new root. The old root's title is marked for refresh and
  its card summary cleared, since either may have described the split part;
- resets context_turns == 0 rows to the configured default window, so
  nothing looks like a reset any more.

Each DB is migrated in one transaction. Safe to re-run: a migrated DB has
nothing left to change. Back the DBs up and stop the service first.

    backend/.venv/bin/python backend/data/migrate_branches.py --dry-run
    backend/.venv/bin/python backend/data/migrate_branches.py
    backend/.venv/bin/python backend/data/migrate_branches.py --db /path/to/conversations.db

Without --db it finds every conversation DB the app would use (one per user
under authentication, else the single DB).
"""

import argparse
import os
import sqlite3
import sys

backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)
from config import get_config, resolve_path  # noqa: E402
from db import ensure_conversation_schema  # noqa: E402


def _root_of(conn, turn_id: int) -> int:
    current = turn_id
    while True:
        row = conn.execute("SELECT parent_turn_id FROM turns WHERE id = ?",
                           (current,)).fetchone()
        if row is None or row[0] is None:
            return current
        current = row[0]


def _subtree(conn, turn_id: int):
    return [r[0] for r in conn.execute(
        """
        WITH RECURSIVE sub(id) AS (
            SELECT id FROM turns WHERE id = ?
            UNION ALL
            SELECT t.id FROM turns t JOIN sub ON t.parent_turn_id = sub.id
        )
        SELECT id FROM sub
        """, (turn_id,)).fetchall()]


def migrate_db(db_path: str, default_window: int, dry_run: bool = False,
               out=print) -> dict:
    """Migrate one conversation DB. Returns counts."""
    stats = {"names_cleared": 0, "chat_names_kept": 0, "branches_split": 0,
             "turns_moved": 0, "windows_reset": 0}
    conn = sqlite3.connect(db_path)
    try:
        # Bring an older DB up to the current columns first (what the app
        # would do on its next request anyway).
        ensure_conversation_schema(conn)
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        try:
            stats["chat_names_kept"] = conn.execute(
                "SELECT COUNT(*) FROM turns WHERE name IS NOT NULL "
                "AND parent_turn_id IS NULL").fetchone()[0]
            named = conn.execute(
                "SELECT id, name FROM turns WHERE name IS NOT NULL "
                "AND parent_turn_id IS NOT NULL ORDER BY id").fetchall()
            for tid, name in named:
                out(f"  {'would clear' if dry_run else 'cleared'} branch name "
                    f"on turn {tid}: {name!r}")
            stats["names_cleared"] = len(named)
            if not dry_run and named:
                conn.execute("UPDATE turns SET name = NULL "
                             "WHERE parent_turn_id IS NOT NULL")

            # Ancestors before descendants (children always have larger
            # ids), so a reset nested in another reset branch lands under the
            # already-split chat and inherits from it.
            resets = [r[0] for r in conn.execute(
                "SELECT id FROM turns WHERE role = 'user' AND context_turns = 0 "
                "AND parent_turn_id IS NOT NULL ORDER BY id").fetchall()]
            for tid in resets:
                old_root = _root_of(conn, tid)
                moved = _subtree(conn, tid)
                out(f"  {'would split' if dry_run else 'split'} turn {tid} "
                    f"({len(moved)} turns) off chat {old_root}")
                stats["branches_split"] += 1
                stats["turns_moved"] += len(moved)
                if dry_run:
                    continue
                state, tags = conn.execute(
                    "SELECT state, chat_tags FROM turns WHERE id = ?",
                    (old_root,)).fetchone()
                conn.execute(
                    "UPDATE turns SET parent_turn_id = NULL, branched = 0, "
                    "paragraph_index = NULL, state = ?, chat_tags = ?, "
                    "title = NULL, title_turns = NULL, summary = NULL "
                    "WHERE id = ?", (state, tags, tid))
                # The old chat's title/summary may have been about this part.
                conn.execute("UPDATE turns SET title_turns = 0, summary = NULL "
                             "WHERE id = ?", (old_root,))
                marks = ",".join("?" * len(moved))
                conn.execute(f"UPDATE tool_calls SET root_id = ? "
                             f"WHERE turn_id IN ({marks})", (tid, *moved))

            stats["windows_reset"] = conn.execute(
                "SELECT COUNT(*) FROM turns WHERE context_turns = 0").fetchone()[0]
            if not dry_run:
                conn.execute("UPDATE turns SET context_turns = ? "
                             "WHERE context_turns = 0", (default_window,))
            conn.execute("ROLLBACK" if dry_run else "COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return stats


def find_dbs(cfg: dict):
    """Every conversation DB the app would serve."""
    if cfg.get("authentication", {}).get("enabled", False):
        users_dir = cfg.get("authentication", {}).get("users_dir")
        users_dir = resolve_path(users_dir or "backend/data/users")
        if not os.path.isdir(users_dir):
            return []
        return [p for p in (os.path.join(users_dir, h, "conversations.db")
                            for h in sorted(os.listdir(users_dir)))
                if os.path.isfile(p)]
    db_path = cfg.get("memory", {}).get("db_path")
    return [resolve_path(db_path or "backend/data/conversations.db")]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Clear branch names and split without-context branches "
                    "into their own chats")
    parser.add_argument("--dry-run", action="store_true",
                        help="show what would change, write nothing")
    parser.add_argument("--db", action="append",
                        help="migrate this conversation DB only (repeatable)")
    args = parser.parse_args(argv)

    cfg = get_config()
    dbs = args.db or find_dbs(cfg)
    if not dbs:
        print("No conversation DBs found.")
        return 0
    window = cfg.get("memory", {}).get("default_context_window", 20)
    for path in dbs:
        print(f"{path}:")
        s = migrate_db(path, window, dry_run=args.dry_run)
        print(f"  branch names {'to clear' if args.dry_run else 'cleared'}: "
              f"{s['names_cleared']} (chat names kept: {s['chat_names_kept']}); "
              f"branches {'to split' if args.dry_run else 'split'}: "
              f"{s['branches_split']} ({s['turns_moved']} turns); "
              f"context windows reset: {s['windows_reset']}")
    if args.dry_run:
        print("Dry run: nothing written.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
