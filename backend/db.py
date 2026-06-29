import os
import sqlite3
from typing import Optional, List, Dict
from contextlib import contextmanager


# Canonical turn column order. Queries select these explicitly (not SELECT *) so
# row->dict mapping is stable regardless of physical column order — important
# because migrated tables get new columns appended at the end while freshly
# created tables define them inline.
TURN_COLUMNS = [
    "id", "user_id", "role", "content", "context_turns", "committed",
    "created_at", "model_name", "token_count", "tags",
    "parent_turn_id", "paragraph_index",
]
_SELECT_COLS = ", ".join(TURN_COLUMNS)


def _row_to_turn(row) -> Dict:
    """Map a SELECT _SELECT_COLS row to a turn dict."""
    return dict(zip(TURN_COLUMNS, row))


def _get_project_root() -> str:
    """Get the project root directory (one level up from backend)."""
    return os.path.dirname(os.getcwd())


def _resolve_path(path: str) -> str:
    """Resolve a relative path - if it starts with backend/, it's already relative to project root.
    Otherwise, add 'backend/' prefix."""
    if os.path.isabs(path):
        return path
    
    # If path already starts with backend/, it's correct
    if path.startswith("backend/"):
        return os.path.join(_get_project_root(), path)
    
    # Otherwise, it's relative to project root but doesn't have backend/ prefix
    return os.path.join(_get_project_root(), "backend", path)


def _db_path() -> str:
    """Get database path from config or environment."""
    env = os.environ.get("DB_PATH")
    if env:
        return _resolve_path(env)
    
    try:
        from config import get_config
        db_path = get_config().get("memory", {}).get("db_path")
        
        if not db_path:
            return os.path.join(_get_project_root(), "backend", "data", "conversations.db")
        
        return _resolve_path(db_path)
    except Exception:
        return os.path.join(_get_project_root(), "backend", "data", "conversations.db")


def get_db():
    """Get a database connection."""
    return sqlite3.connect(_db_path())


@contextmanager
def get_db_cursor():
    """Context manager for database connections."""
    conn = sqlite3.connect(_db_path())
    try:
        yield conn.cursor()
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()


def ensure_conversation_schema(conn) -> None:
    """Create the turns + conversations tables if missing and migrate older DBs.

    Safe to call on any conversation database (the default DB and each per-user DB).
    """
    cursor = conn.cursor()

    # Create turns table (includes branching columns for fresh DBs)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            context_turns INTEGER NOT NULL DEFAULT 5,
            committed BOOLEAN NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            model_name TEXT,
            token_count INTEGER,
            tags TEXT,
            parent_turn_id INTEGER,
            paragraph_index INTEGER,
            FOREIGN KEY (parent_turn_id) REFERENCES turns(id)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            first_turn_id INTEGER,
            last_updated TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (first_turn_id) REFERENCES turns(id)
        )
    """)
    conn.commit()

    _migrate_turns_branching(conn)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(parent_turn_id)")
    conn.commit()


def _migrate_turns_branching(conn) -> None:
    """Add branching columns to an existing turns table and backfill a linear chain."""
    cursor = conn.cursor()
    existing = {row[1] for row in cursor.execute("PRAGMA table_info(turns)").fetchall()}

    added_parent = False
    if "parent_turn_id" not in existing:
        cursor.execute("ALTER TABLE turns ADD COLUMN parent_turn_id INTEGER")
        added_parent = True
    if "paragraph_index" not in existing:
        cursor.execute("ALTER TABLE turns ADD COLUMN paragraph_index INTEGER")
    conn.commit()

    # When parent_turn_id was just introduced, link pre-existing turns into one
    # linear chain (oldest = root) so prior history stays navigable as a branch.
    if added_parent:
        rows = cursor.execute("SELECT id FROM turns ORDER BY id ASC").fetchall()
        prev = None
        for (tid,) in rows:
            if prev is not None:
                cursor.execute(
                    "UPDATE turns SET parent_turn_id = ? WHERE id = ? AND parent_turn_id IS NULL",
                    (prev, tid),
                )
            prev = tid
        conn.commit()


def init_db():
    """Initialize the database with required tables."""
    db_path = _db_path()

    # Ensure parent directory exists
    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Create passkeys table (for auth)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS passkeys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT UNIQUE NOT NULL,
            salt TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            disabled BOOLEAN NOT NULL DEFAULT 0,
            expires_at TEXT
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_passkeys_hash ON passkeys(hash)")

    # Create users table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            passkey_hash TEXT UNIQUE NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (passkey_hash) REFERENCES passkeys(hash)
        )
    """)
    conn.commit()

    # Conversation tables (turns + conversations) with branching support
    ensure_conversation_schema(conn)
    conn.close()


def create_turn(
    db,
    user_id: Optional[str],
    role: str,
    content: str,
    context_turns: int = 5,
    committed: bool = True,
    model_name: Optional[str] = None,
    token_count: Optional[int] = None,
    parent_turn_id: Optional[int] = None,
    paragraph_index: Optional[int] = None,
) -> dict:
    """Create a new turn in the database.

    parent_turn_id is the fork point this turn descends from (None = root).
    paragraph_index, when set, records which paragraph of the parent turn the
    branch was taken from.
    """
    cursor = db.cursor()
    cursor.execute(
        """
        INSERT INTO turns
            (user_id, role, content, context_turns, committed, model_name,
             token_count, parent_turn_id, paragraph_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (user_id, role, content, context_turns, committed, model_name,
         token_count, parent_turn_id, paragraph_index)
    )
    db.commit()

    turn_id = cursor.lastrowid
    return get_turn_by_id(db, turn_id)


def get_turn_by_id(db, turn_id: int) -> Optional[dict]:
    """Get a single turn by ID."""
    cursor = db.cursor()
    cursor.execute(f"SELECT {_SELECT_COLS} FROM turns WHERE id = ?", (turn_id,))
    row = cursor.fetchone()

    if not row:
        return None

    return _row_to_turn(row)


def get_recent_turns(db, limit: int = 10, offset: int = 0) -> List[dict]:
    """Get recent committed turns with pagination."""
    cursor = db.cursor()
    cursor.execute(
        f"""
        SELECT {_SELECT_COLS} FROM turns
        WHERE committed = 1
        ORDER BY id DESC
        LIMIT ? OFFSET ?
        """,
        (limit, offset)
    )

    rows = cursor.fetchall()
    return [_row_to_turn(row) for row in rows]


def get_latest_turn_id(db, committed_only: bool = True) -> Optional[int]:
    """Return the id of the most recent turn (the default head to continue from)."""
    cursor = db.cursor()
    where = "WHERE committed = 1" if committed_only else ""
    row = cursor.execute(f"SELECT id FROM turns {where} ORDER BY id DESC LIMIT 1").fetchone()
    return row[0] if row else None


def get_ancestor_chain(db, turn_id: int, limit: Optional[int] = None,
                       committed_only: bool = True) -> List[dict]:
    """Walk parent_turn_id from turn_id up to the root.

    Returns the chain oldest-first, INCLUDING turn_id itself (the fork point), so
    a branch inherits context up to and including its parent. When limit is set,
    only the most recent `limit` turns of the chain are returned.
    """
    if turn_id is None:
        return []

    cursor = db.cursor()
    chain: List[dict] = []
    current = turn_id
    seen = set()
    while current is not None and current not in seen:
        seen.add(current)
        row = cursor.execute(f"SELECT {_SELECT_COLS} FROM turns WHERE id = ?", (current,)).fetchone()
        if not row:
            break
        turn = _row_to_turn(row)
        chain.append(turn)
        current = turn["parent_turn_id"]

    chain.reverse()  # oldest first

    if committed_only:
        chain = [t for t in chain if t["committed"]]
    if limit is not None:
        chain = chain[-limit:] if limit > 0 else []
    return chain


def get_turn_tree(db, committed_only: bool = True) -> List[dict]:
    """Return the conversation as a nested tree (list of roots).

    Each node is a turn dict with an added "children" list (ordered by id).
    """
    cursor = db.cursor()
    where = "WHERE committed = 1" if committed_only else ""
    rows = cursor.execute(
        f"SELECT {_SELECT_COLS} FROM turns {where} ORDER BY id ASC"
    ).fetchall()

    nodes: Dict[int, dict] = {}
    for row in rows:
        node = _row_to_turn(row)
        node["children"] = []
        nodes[node["id"]] = node

    roots: List[dict] = []
    for node in nodes.values():  # insertion order == ascending id
        parent_id = node["parent_turn_id"]
        if parent_id is not None and parent_id in nodes:
            nodes[parent_id]["children"].append(node)
        else:
            roots.append(node)
    return roots


def update_turn_committed(db, turn_id: int, committed: bool) -> bool:
    """Update the committed status of a turn."""
    cursor = db.cursor()
    cursor.execute("UPDATE turns SET committed = ? WHERE id = ?", (committed, turn_id))
    db.commit()
    return cursor.rowcount > 0


def delete_turn(db, turn_id: int, subtree: bool = False) -> Optional[dict]:
    """Hard-delete a turn (removes the row; ids are not reused).

    - subtree=False: delete just this turn and reparent its direct children to
      this turn's parent, so they rise one level instead of being orphaned.
    - subtree=True: delete this turn and all of its descendants (a whole branch).

    Returns a summary dict, or None if the turn does not exist.
    """
    cursor = db.cursor()
    row = cursor.execute("SELECT parent_turn_id FROM turns WHERE id = ?", (turn_id,)).fetchone()
    if row is None:
        return None
    parent_id = row[0]

    if subtree:
        # Collect this turn + all descendants (breadth-first over parent links).
        to_delete: List[int] = []
        frontier = [turn_id]
        seen = set()
        while frontier:
            current = frontier.pop()
            if current in seen:
                continue
            seen.add(current)
            to_delete.append(current)
            children = cursor.execute(
                "SELECT id FROM turns WHERE parent_turn_id = ?", (current,)
            ).fetchall()
            frontier.extend(cid for (cid,) in children)

        cursor.executemany("DELETE FROM turns WHERE id = ?", [(i,) for i in to_delete])
        db.commit()
        return {
            "removed_turn_ids": sorted(to_delete),
            "reparented_children": [],
            "reparented_to": None,
        }

    # Single delete: reparent direct children to this turn's parent, then remove it.
    child_rows = cursor.execute(
        "SELECT id FROM turns WHERE parent_turn_id = ?", (turn_id,)
    ).fetchall()
    reparented = sorted(cid for (cid,) in child_rows)
    cursor.execute(
        "UPDATE turns SET parent_turn_id = ? WHERE parent_turn_id = ?", (parent_id, turn_id)
    )
    cursor.execute("DELETE FROM turns WHERE id = ?", (turn_id,))
    db.commit()
    return {
        "removed_turn_ids": [turn_id],
        "reparented_children": reparented,
        "reparented_to": parent_id,
    }


def get_context_for_turn(db, after_turn_id: int, limit: int = 5) -> List[dict]:
    """Get committed turns BEFORE a specific turn_id (leading up to it).

    Args:
        db: Database connection
        after_turn_id: The turn ID to get context BEFORE (not after)
        limit: Maximum number of turns to return

    Returns:
        List of turn dictionaries ordered chronologically (oldest first)
    """
    cursor = db.cursor()
    cursor.execute(
        f"""
        SELECT {_SELECT_COLS} FROM turns
        WHERE committed = 1 AND id < ?
        ORDER BY id DESC
        LIMIT ?
        """,
        (after_turn_id, limit)
    )

    rows = cursor.fetchall()
    turns = [_row_to_turn(row) for row in rows]
    return list(reversed(turns))  # Return oldest first
