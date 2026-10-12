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
    "parent_turn_id", "paragraph_index", "branched", "name", "state",
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
            branched INTEGER NOT NULL DEFAULT 0,
            name TEXT,
            state TEXT NOT NULL DEFAULT 'seed',
            recall_content TEXT,
            recall_sources TEXT,
            embedding BLOB,
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

    # Single-row store for the current (ephemeral) recall block. Overwritten each
    # time recall runs; shared with the frontend for display.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS recall_blocks (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            content TEXT,
            sources TEXT,
            query TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)

    # Rebuildable index over the notes vault (files are the source of truth; see
    # notes_index.py for the derived-from-content-only invariant).
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS notes_index (
            filename TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created TEXT,
            tags TEXT,
            source_turns TEXT,
            links TEXT,
            body TEXT,
            content_hash TEXT,
            mtime REAL,
            event_start TEXT,
            event_end TEXT,
            event_all_day INTEGER,
            fields TEXT,
            embedding BLOB
        )
    """)

    # LLM-synthesized note drafts awaiting user approval. Drafts are app state,
    # NOT knowledge: they never touch the notes vault until approved (Obsidian
    # indexes everything it sees, so unapproved files would leak into the graph).
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS note_drafts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT,
            tree_root_id INTEGER,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            tags TEXT,
            links TEXT,
            source_turns TEXT,
            duplicate_of TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            decided_at TEXT,
            kind TEXT NOT NULL DEFAULT 'new',
            target_title TEXT,
            reason TEXT,
            fields TEXT
        )
    """)
    # Migrate older draft tables (columns added later).
    draft_cols = {row[1] for row in cursor.execute("PRAGMA table_info(note_drafts)").fetchall()}
    if "duplicate_of" not in draft_cols:
        cursor.execute("ALTER TABLE note_drafts ADD COLUMN duplicate_of TEXT")
    # kind 'new' = a fresh note; 'edit' = a proposed change to an existing vault
    # note (target_title names it; title/body/tags hold the proposed state).
    if "kind" not in draft_cols:
        cursor.execute("ALTER TABLE note_drafts ADD COLUMN kind TEXT NOT NULL DEFAULT 'new'")
        cursor.execute("ALTER TABLE note_drafts ADD COLUMN target_title TEXT")
        cursor.execute("ALTER TABLE note_drafts ADD COLUMN reason TEXT")
    # fields = JSON dict of whitelisted structured frontmatter the draft proposes
    # (event start/end/all_day; later: goal state). The model proposes structure
    # through typed tool parameters only; the app alone writes frontmatter at
    # approval (NOTES-FORMAT.md boundary).
    if "fields" not in draft_cols:
        cursor.execute("ALTER TABLE note_drafts ADD COLUMN fields TEXT")
    # Scratch (notes-to-self): a SEPARATE table by design — the conversation
    # agent's queries physically cannot touch it (isolation by construction,
    # not by WHERE-clause discipline). Media lives on disk, content-addressed
    # (media_hash = sha256) for future sync integrations. Pending graph
    # proposals are note_drafts rows (run_id 'scratch-…') linked by draft_id;
    # committed/rejected state is derived by joining the draft, never copied.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS scratch (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            kind TEXT NOT NULL DEFAULT 'text',
            content TEXT,
            media_path TEXT,
            media_mime TEXT,
            media_size INTEGER,
            media_hash TEXT,
            transcript TEXT,
            status TEXT NOT NULL DEFAULT 'inert',
            llm_readable INTEGER NOT NULL DEFAULT 0,
            action_result TEXT,
            draft_id INTEGER,
            transcript_id INTEGER
        )
    """)

    # Video transcripts (STT on video audio). Short videos transcribe in-turn;
    # long ones populate this table from a background thread and are surfaced
    # via GET /api/transcripts (and re-asking the transcribe_video tool).
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS transcripts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL,
            title TEXT,
            duration_s INTEGER,
            status TEXT NOT NULL DEFAULT 'processing',
            text TEXT,
            error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            finished_at TEXT
        )
    """)

    # Event columns + the generic per-type fields JSON on the notes index
    # (parsed from frontmatter at index time).
    ni_cols = {row[1] for row in cursor.execute("PRAGMA table_info(notes_index)").fetchall()}
    for col in ("event_start TEXT", "event_end TEXT", "event_all_day INTEGER",
                "fields TEXT"):
        if ni_cols and col.split()[0] not in ni_cols:
            cursor.execute(f"ALTER TABLE notes_index ADD COLUMN {col}")
    conn.commit()

    _migrate_turns_branching(conn)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(parent_turn_id)")
    conn.commit()


def _migrate_turns_branching(conn) -> None:
    """Add branching/recall columns to an existing turns table; backfill a chain."""
    cursor = conn.cursor()
    existing = {row[1] for row in cursor.execute("PRAGMA table_info(turns)").fetchall()}

    added_parent = False
    if "parent_turn_id" not in existing:
        cursor.execute("ALTER TABLE turns ADD COLUMN parent_turn_id INTEGER")
        added_parent = True
    if "paragraph_index" not in existing:
        cursor.execute("ALTER TABLE turns ADD COLUMN paragraph_index INTEGER")
    if "branched" not in existing:
        cursor.execute("ALTER TABLE turns ADD COLUMN branched INTEGER NOT NULL DEFAULT 0")
    if "name" not in existing:
        cursor.execute("ALTER TABLE turns ADD COLUMN name TEXT")
    if "state" not in existing:
        cursor.execute("ALTER TABLE turns ADD COLUMN state TEXT NOT NULL DEFAULT 'seed'")
    if "recall_content" not in existing:
        cursor.execute("ALTER TABLE turns ADD COLUMN recall_content TEXT")
    if "recall_sources" not in existing:
        cursor.execute("ALTER TABLE turns ADD COLUMN recall_sources TEXT")
    if "embedding" not in existing:
        cursor.execute("ALTER TABLE turns ADD COLUMN embedding BLOB")
    if "tool_activity" not in existing:
        # JSON list of the turn's tool calls ({tool, query/url/title, outcome,
        # count, error, urls}) — persisted "Sources" for assistant turns.
        cursor.execute("ALTER TABLE turns ADD COLUMN tool_activity TEXT")
    if "title" not in existing:
        # LLM-generated conversation title, stored on ROOT turns only, separate
        # from the user-set name (manual renames always win in the UI).
        # title_turns = tree turn count when it was generated (lazy regeneration).
        cursor.execute("ALTER TABLE turns ADD COLUMN title TEXT")
        cursor.execute("ALTER TABLE turns ADD COLUMN title_turns INTEGER")
    if "location" not in existing:
        # JSON {lat, lon, accuracy, ts} — populated ONLY when location.store is
        # enabled (togglable; ephemeral-by-default is the privacy default).
        cursor.execute("ALTER TABLE turns ADD COLUMN location TEXT")
    if "chat_tags" not in existing:
        # Chat-level tags, ROOT turns only (UX doc: the root is stable across
        # promotion and branching). JSON list. Separate from per-turn `tags`,
        # which feed recall boosts; chat tags organize and don't (2026-10-12).
        cursor.execute("ALTER TABLE turns ADD COLUMN chat_tags TEXT")
    if "summary" not in existing:
        # The chat card's on-demand summary, ROOT turns only. JSON {text,
        # proposed_tags, turns (tree size at generation), generated_at}.
        cursor.execute("ALTER TABLE turns ADD COLUMN summary TEXT")
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
    branched: bool = False,
    state: str = "seed",
    location: Optional[dict] = None,
) -> dict:
    """Create a new turn in the database.

    parent_turn_id is the fork point this turn descends from (None = root).
    paragraph_index, when set, records which paragraph of the parent turn the
    branch was taken from. branched=True marks a turn created via an explicit
    fork (POST /api/branches). state is the conversation stage: "seed" (a new
    provisional chat) or "tree" (a promoted full conversation).
    """
    cursor = db.cursor()
    cursor.execute(
        """
        INSERT INTO turns
            (user_id, role, content, context_turns, committed, model_name,
             token_count, parent_turn_id, paragraph_index, branched, state,
             location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (user_id, role, content, context_turns, committed, model_name,
         token_count, parent_turn_id, paragraph_index, 1 if branched else 0, state,
         _json.dumps(location) if location else None)
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
    """Walk parent_turn_id from turn_id up to the root (or a context reset).

    Returns the chain oldest-first, INCLUDING turn_id itself, so a branch inherits
    context up to and including its parent. When limit is set, only the most recent
    `limit` turns are returned.

    A "context reset" — a USER turn generated with context_turns == 0 (a
    without-context branch start) — is the boundary: it is INCLUDED, but the walk
    stops there and does not reach the turns above it. Only the user turn is the
    reset; its assistant reply (also stored with context_turns == 0) is internal to
    the branch, so a branch still shares its own prior turns as context.
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
        # Stop at (but include) a context reset: a user turn with context_turns == 0.
        if turn.get("role") == "user" and turn.get("context_turns") == 0:
            break
        current = turn["parent_turn_id"]

    chain.reverse()  # oldest first

    if committed_only:
        chain = [t for t in chain if t["committed"]]
    if limit is not None:
        chain = chain[-limit:] if limit > 0 else []
    return chain


def set_turn_tool_activity(db, turn_id: int, activity: List[dict]) -> None:
    """Persist a turn's tool-call records (the frontend's per-reply "Sources")."""
    db.cursor().execute(
        "UPDATE turns SET tool_activity = ? WHERE id = ?",
        (_json.dumps(activity or []), turn_id),
    )
    db.commit()


def set_turn_title(db, turn_id: int, title: str, title_turns: int) -> None:
    """Store a generated conversation title on a ROOT turn (separate from the
    user-set name; title_turns records tree size at generation for lazy regen)."""
    db.cursor().execute(
        "UPDATE turns SET title = ?, title_turns = ? WHERE id = ?",
        (title, title_turns, turn_id),
    )
    db.commit()


def get_turn_title_state(db, turn_id: int):
    """(title, title_turns) for a turn — None fields when never generated."""
    row = db.cursor().execute(
        "SELECT title, title_turns FROM turns WHERE id = ?", (turn_id,)).fetchone()
    return (row[0], row[1]) if row else (None, None)


def count_tree_turns(db, root_id: int) -> int:
    """Number of committed turns in the tree rooted at root_id."""
    row = db.cursor().execute(
        """
        WITH RECURSIVE tree(id) AS (
            SELECT id FROM turns WHERE id = ?
            UNION ALL
            SELECT t.id FROM turns t JOIN tree ON t.parent_turn_id = tree.id
        )
        SELECT COUNT(*) FROM tree JOIN turns ON turns.id = tree.id
        WHERE turns.committed = 1
        """, (root_id,)).fetchone()
    return row[0] if row else 0


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

    # Attach each turn's own persisted recall block (per-branch recall), so the
    # frontend can show a branch's recall on load independent of the latest one.
    for (tid, content, sources) in cursor.execute(
        "SELECT id, recall_content, recall_sources FROM turns WHERE recall_content IS NOT NULL"
    ).fetchall():
        if tid in nodes:
            try:
                parsed = _json.loads(sources) if sources else []
            except Exception:
                parsed = []
            nodes[tid]["recall"] = {"content": content, "sources": parsed}

    # Attach persisted tool activity (per-reply "Sources") and generated titles
    # (root rows; the UI renders name ?? title ?? preview).
    for (tid, activity) in cursor.execute(
        "SELECT id, tool_activity FROM turns WHERE tool_activity IS NOT NULL"
    ).fetchall():
        if tid in nodes:
            try:
                nodes[tid]["tools"] = _json.loads(activity)
            except Exception:
                pass
    for (tid, title) in cursor.execute(
        "SELECT id, title FROM turns WHERE title IS NOT NULL"
    ).fetchall():
        if tid in nodes:
            nodes[tid]["title"] = title
    for (tid, raw) in cursor.execute(
        "SELECT id, chat_tags FROM turns WHERE chat_tags IS NOT NULL"
    ).fetchall():
        if tid in nodes:
            nodes[tid]["chat_tags"] = _parse_tags(raw)

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
    if parent_id is None and reparented:
        # A root went: its children are roots now, and the chat's tags go
        # with them rather than vanishing with the row.
        (raw,) = cursor.execute(
            "SELECT chat_tags FROM turns WHERE id = ?", (turn_id,)).fetchone()
        if raw:
            cursor.executemany(
                "UPDATE turns SET chat_tags = ? WHERE id = ? AND chat_tags IS NULL",
                [(raw, cid) for cid in reparented])
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


# --- Recall: embeddings, tags, similarity search, ephemeral recall block -------

import json as _json


def _parse_tags(raw) -> List[str]:
    """Parse the free-form tags column (JSON list, CSV, or empty) into a list."""
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    try:
        parsed = _json.loads(raw)
        if isinstance(parsed, list):
            return [str(t).strip() for t in parsed if str(t).strip()]
    except Exception:
        pass
    return [t.strip() for t in str(raw).split(",") if t.strip()]


def get_root_id(db, turn_id: int) -> Optional[int]:
    """Walk parent_turn_id to the root; returns the root turn id (the branch id)."""
    cursor = db.cursor()
    current = turn_id
    seen = set()
    root = turn_id
    while current is not None and current not in seen:
        seen.add(current)
        row = cursor.execute("SELECT parent_turn_id FROM turns WHERE id = ?", (current,)).fetchone()
        if row is None:
            break
        root = current
        current = row[0]
    return root


def set_turn_embedding(db, turn_id: int, vector: List[float]) -> None:
    """Store an embedding (float32 bytes) for a turn."""
    if vector is None:
        return
    import numpy as np
    blob = np.asarray(vector, dtype="float32").tobytes()
    cursor = db.cursor()
    cursor.execute("UPDATE turns SET embedding = ? WHERE id = ?", (blob, turn_id))
    db.commit()


def get_turns_missing_embeddings(db, limit: int = 500) -> List[dict]:
    """Committed turns that don't yet have an embedding (for backfill)."""
    cursor = db.cursor()
    rows = cursor.execute(
        "SELECT id, content FROM turns WHERE committed = 1 AND embedding IS NULL LIMIT ?",
        (limit,),
    ).fetchall()
    return [{"id": r[0], "content": r[1]} for r in rows]


def search_similar_turns(db, query_vector: List[float], limit: int = 10,
                         tag_boosts: Optional[Dict[str, float]] = None,
                         exclude_ids: Optional[List[int]] = None) -> List[dict]:
    """Brute-force cosine similarity over committed turns with embeddings.

    Applies per-tag multiplicative boosts, returns top `limit` matches with
    content + metadata (incl. branch_root_id). The corpus is personal-scale, so a
    full numpy scan is plenty.
    """
    if query_vector is None:
        return []
    import numpy as np

    tag_boosts = {k.lower(): v for k, v in (tag_boosts or {}).items()}
    exclude = set(exclude_ids or [])

    cursor = db.cursor()
    rows = cursor.execute(
        "SELECT id, role, content, tags, created_at, parent_turn_id, embedding "
        "FROM turns WHERE committed = 1 AND embedding IS NOT NULL"
    ).fetchall()
    if not rows:
        return []

    q = np.asarray(query_vector, dtype="float32")
    q_norm = np.linalg.norm(q)
    if q_norm == 0:
        return []

    scored = []
    for (tid, role, content, tags_raw, created_at, parent_id, blob) in rows:
        if tid in exclude or not blob:
            continue
        vec = np.frombuffer(blob, dtype="float32")
        if vec.shape != q.shape:
            continue
        denom = q_norm * np.linalg.norm(vec)
        if denom == 0:
            continue
        similarity = float(np.dot(q, vec) / denom)
        tags = _parse_tags(tags_raw)
        boost = 1.0
        for t in tags:
            boost *= tag_boosts.get(t.lower(), 1.0)
        scored.append({
            "turn_id": tid,
            "role": role,
            "text": content,
            "tags": tags,
            "created_at": created_at,
            "parent_turn_id": parent_id,
            "branch_root_id": get_root_id(db, tid),
            "similarity": similarity,
            "score": similarity * boost,
        })

    scored.sort(key=lambda m: m["score"], reverse=True)
    return scored[:limit]


def search_keyword_turns(db, query: str, limit: int = 10,
                         tag_boosts: Optional[Dict[str, float]] = None,
                         exclude_ids: Optional[List[int]] = None) -> List[dict]:
    """Lexical search over committed turns by term overlap (no embeddings needed).

    Scores each turn by how many query terms it contains (case-insensitive), times
    any per-tag boost. Returns the top matches with the same shape as the semantic
    search (incl. branch_root_id). Turns in `exclude_ids` are skipped.
    """
    if not query or not query.strip():
        return []
    import re
    terms = [t.lower() for t in re.split(r"\W+", query) if len(t) >= 2]
    if not terms:
        return []
    tag_boosts = {k.lower(): v for k, v in (tag_boosts or {}).items()}
    exclude = set(exclude_ids or [])

    cursor = db.cursor()
    rows = cursor.execute(
        "SELECT id, role, content, tags, created_at, parent_turn_id "
        "FROM turns WHERE committed = 1"
    ).fetchall()

    scored = []
    for (tid, role, content, tags_raw, created_at, parent_id) in rows:
        if tid in exclude:
            continue
        low = (content or "").lower()
        hits = sum(1 for t in set(terms) if t in low)
        if hits == 0:
            continue
        tags = _parse_tags(tags_raw)
        boost = 1.0
        for t in tags:
            boost *= tag_boosts.get(t.lower(), 1.0)
        scored.append({
            "turn_id": tid, "role": role, "text": content, "tags": tags,
            "created_at": created_at, "parent_turn_id": parent_id,
            "branch_root_id": get_root_id(db, tid),
            "matches": hits, "score": hits * boost,
        })
    scored.sort(key=lambda m: m["score"], reverse=True)
    return scored[:limit]


def update_turn_tags(db, turn_id: int, add: Optional[List[str]] = None,
                     remove: Optional[List[str]] = None) -> Optional[List[str]]:
    """Add/remove free-form tags on a turn (case-insensitive). Returns new tags."""
    cursor = db.cursor()
    row = cursor.execute("SELECT tags FROM turns WHERE id = ?", (turn_id,)).fetchone()
    if row is None:
        return None

    tags = _parse_tags(row[0])
    lower = {t.lower(): t for t in tags}
    for t in (add or []):
        t = str(t).strip()
        if t and t.lower() not in lower:
            lower[t.lower()] = t
    for t in (remove or []):
        lower.pop(str(t).strip().lower(), None)

    new_tags = list(lower.values())
    cursor.execute("UPDATE turns SET tags = ? WHERE id = ?", (_json.dumps(new_tags), turn_id))
    db.commit()
    return new_tags


def update_subtree_state(db, turn_id: int, state: str):
    """Set the conversation `state` for a turn and its whole subtree.

    Used to promote a seed to a tree (or back). Returns (found, updated_ids).
    """
    cursor = db.cursor()
    if cursor.execute("SELECT 1 FROM turns WHERE id = ?", (turn_id,)).fetchone() is None:
        return False, []

    ids: List[int] = []
    frontier = [turn_id]
    seen = set()
    while frontier:
        current = frontier.pop()
        if current in seen:
            continue
        seen.add(current)
        ids.append(current)
        for (cid,) in cursor.execute(
            "SELECT id FROM turns WHERE parent_turn_id = ?", (current,)
        ).fetchall():
            frontier.append(cid)

    cursor.executemany("UPDATE turns SET state = ? WHERE id = ?",
                       [(state, i) for i in ids])
    db.commit()
    return True, sorted(ids)


def update_turn_name(db, turn_id: int, name: Optional[str]):
    """Set/clear a turn's display name. Returns (found: bool, stored_name)."""
    value = (name or "").strip() or None
    cursor = db.cursor()
    cursor.execute("UPDATE turns SET name = ? WHERE id = ?", (value, turn_id))
    db.commit()
    return cursor.rowcount > 0, value


# --- Chat-level state (ROOT turns only): tags + the card's summary -------------

def get_chat_tags(db, root_id: int) -> List[str]:
    row = db.cursor().execute(
        "SELECT chat_tags FROM turns WHERE id = ?", (root_id,)).fetchone()
    return _parse_tags(row[0]) if row else []


def set_chat_tags(db, root_id: int, tags: List[str]) -> List[str]:
    """Replace a chat's tags (caller normalizes). Empty list clears."""
    db.cursor().execute("UPDATE turns SET chat_tags = ? WHERE id = ?",
                        (_json.dumps(tags) if tags else None, root_id))
    db.commit()
    return list(tags)


def get_chat_summary(db, root_id: int) -> Optional[dict]:
    row = db.cursor().execute(
        "SELECT summary FROM turns WHERE id = ?", (root_id,)).fetchone()
    if not row or not row[0]:
        return None
    try:
        parsed = _json.loads(row[0])
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def set_chat_summary(db, root_id: int, summary: dict) -> None:
    db.cursor().execute("UPDATE turns SET summary = ? WHERE id = ?",
                        (_json.dumps(summary), root_id))
    db.commit()


def all_chat_tags(db) -> List[str]:
    """Every tag worn by any chat (for the shared tag vocabulary)."""
    out: List[str] = []
    for (raw,) in db.cursor().execute(
            "SELECT chat_tags FROM turns WHERE chat_tags IS NOT NULL").fetchall():
        out.extend(_parse_tags(raw))
    return out


def set_turn_recall(db, turn_id: int, content: str, sources: List[dict]) -> None:
    """Persist the recall block that was used for a turn (per-branch recall)."""
    cursor = db.cursor()
    cursor.execute(
        "UPDATE turns SET recall_content = ?, recall_sources = ? WHERE id = ?",
        (content, _json.dumps(sources or []), turn_id),
    )
    db.commit()


def set_current_recall(db, content: str, sources: List[dict], query: str = "") -> None:
    """Store/overwrite the single current (ephemeral) recall block."""
    cursor = db.cursor()
    cursor.execute("DELETE FROM recall_blocks")
    cursor.execute(
        "INSERT INTO recall_blocks (id, content, sources, query) VALUES (1, ?, ?, ?)",
        (content, _json.dumps(sources), query),
    )
    db.commit()


def get_current_recall(db) -> Optional[dict]:
    """Return the current recall block, or None."""
    cursor = db.cursor()
    row = cursor.execute(
        "SELECT content, sources, query, created_at FROM recall_blocks WHERE id = 1"
    ).fetchone()
    if row is None:
        return None
    try:
        sources = _json.loads(row[1]) if row[1] else []
    except Exception:
        sources = []
    return {"content": row[0], "sources": sources, "query": row[2], "created_at": row[3]}


def clear_current_recall(db) -> None:
    cursor = db.cursor()
    cursor.execute("DELETE FROM recall_blocks")
    db.commit()


# --- Note drafts (LLM output awaiting user approval) ---------------------------

NOTE_DRAFT_COLUMNS = [
    "id", "run_id", "tree_root_id", "title", "body", "tags", "links",
    "source_turns", "duplicate_of", "status", "created_at", "decided_at",
    "kind", "target_title", "reason", "fields",
]
_DRAFT_COLS = ", ".join(NOTE_DRAFT_COLUMNS)


def _row_to_draft(row) -> Dict:
    d = dict(zip(NOTE_DRAFT_COLUMNS, row))
    for key in ("tags", "links", "source_turns", "duplicate_of"):
        try:
            d[key] = _json.loads(d[key]) if d[key] else []
        except Exception:
            d[key] = []
    try:
        d["fields"] = _json.loads(d["fields"]) if d.get("fields") else {}
        if not isinstance(d["fields"], dict):
            d["fields"] = {}
    except Exception:
        d["fields"] = {}
    return d


def create_note_draft(db, title: str, body: str,
                      tags: Optional[List[str]] = None,
                      links: Optional[List[str]] = None,
                      source_turns: Optional[List[int]] = None,
                      tree_root_id: Optional[int] = None,
                      run_id: Optional[str] = None,
                      duplicate_of: Optional[List[dict]] = None,
                      kind: str = "new",
                      target_title: Optional[str] = None,
                      reason: Optional[str] = None,
                      fields: Optional[dict] = None) -> dict:
    """Insert a pending note draft. duplicate_of lists near-duplicate existing
    notes ([{title, score}]) so the user can reject/merge during review.

    kind 'new' proposes a fresh note; kind 'edit' proposes changes to the existing
    vault note named by target_title — title/body/tags then hold the full proposed
    state of that note (approving applies exactly what was reviewed)."""
    cursor = db.cursor()
    cursor.execute(
        """
        INSERT INTO note_drafts
            (run_id, tree_root_id, title, body, tags, links, source_turns,
             duplicate_of, kind, target_title, reason, fields)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (run_id, tree_root_id, title, body,
         _json.dumps(tags or []), _json.dumps(links or []),
         _json.dumps(source_turns or []), _json.dumps(duplicate_of or []),
         kind, target_title, reason,
         _json.dumps(fields) if fields else None),
    )
    db.commit()
    return get_note_draft(db, cursor.lastrowid)


def stamp_note_draft_provenance(db, draft_id: int,
                                source_turns: List[int],
                                tree_root_id: Optional[int]) -> None:
    """Backfill a draft's provenance once its turn exists (chat-proposed drafts are
    created mid-stream, before the assistant turn row is written)."""
    db.cursor().execute(
        "UPDATE note_drafts SET source_turns = ?, tree_root_id = ? WHERE id = ?",
        (_json.dumps(source_turns or []), tree_root_id, draft_id),
    )
    db.commit()


def get_note_draft(db, draft_id: int) -> Optional[dict]:
    row = db.cursor().execute(
        f"SELECT {_DRAFT_COLS} FROM note_drafts WHERE id = ?", (draft_id,)
    ).fetchone()
    return _row_to_draft(row) if row else None


def list_note_drafts(db, status: Optional[str] = None,
                     run_id: Optional[str] = None) -> List[dict]:
    where, params = [], []
    if status:
        where.append("status = ?"); params.append(status)
    if run_id:
        where.append("run_id = ?"); params.append(run_id)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    rows = db.cursor().execute(
        f"SELECT {_DRAFT_COLS} FROM note_drafts {clause} ORDER BY id ASC", params
    ).fetchall()
    return [_row_to_draft(r) for r in rows]


def update_note_draft(db, draft_id: int, *, title: Optional[str] = None,
                      body: Optional[str] = None,
                      tags: Optional[List[str]] = None,
                      links: Optional[List[str]] = None,
                      fields: Optional[dict] = None) -> Optional[dict]:
    """Edit a draft during review (title/body/tags/links/fields). Returns updated draft."""
    if get_note_draft(db, draft_id) is None:
        return None
    sets, params = [], []
    if title is not None:
        sets.append("title = ?"); params.append(title)
    if body is not None:
        sets.append("body = ?"); params.append(body)
    if tags is not None:
        sets.append("tags = ?"); params.append(_json.dumps(tags))
    if links is not None:
        sets.append("links = ?"); params.append(_json.dumps(links))
    if fields is not None:
        sets.append("fields = ?"); params.append(_json.dumps(fields) if fields else None)
    if sets:
        params.append(draft_id)
        db.cursor().execute(f"UPDATE note_drafts SET {', '.join(sets)} WHERE id = ?", params)
        db.commit()
    return get_note_draft(db, draft_id)


# --- Scratch (notes-to-self) ----------------------------------------------------

SCRATCH_COLUMNS = ["id", "created_at", "kind", "content", "media_path",
                   "media_mime", "media_size", "media_hash", "transcript",
                   "status", "llm_readable", "action_result", "draft_id",
                   "transcript_id"]
_SCRATCH_COLS = ", ".join("s." + c for c in SCRATCH_COLUMNS)


def _row_to_scratch(row) -> Dict:
    d = dict(zip(SCRATCH_COLUMNS + ["draft_status"], row))
    d["llm_readable"] = bool(d["llm_readable"])
    try:
        d["action_result"] = _json.loads(d["action_result"]) if d["action_result"] else None
    except Exception:
        d["action_result"] = None
    # Effective status folds in the linked draft's fate (approve/reject happen
    # through the normal drafts endpoints; we derive, never duplicate).
    if d["status"] == "pending" and d.get("draft_status") in ("approved", "rejected"):
        d["status"] = "committed" if d["draft_status"] == "approved" else "inert"
    return d


def create_scratch(db, kind: str, content: Optional[str] = None,
                   media_path: Optional[str] = None,
                   media_mime: Optional[str] = None,
                   media_size: Optional[int] = None,
                   media_hash: Optional[str] = None) -> dict:
    cursor = db.cursor()
    cursor.execute(
        "INSERT INTO scratch (kind, content, media_path, media_mime, "
        "media_size, media_hash) VALUES (?, ?, ?, ?, ?, ?)",
        (kind, content, media_path, media_mime, media_size, media_hash))
    db.commit()
    return get_scratch(db, cursor.lastrowid)


def get_scratch(db, scratch_id: int) -> Optional[dict]:
    row = db.cursor().execute(
        f"SELECT {_SCRATCH_COLS}, d.status FROM scratch s "
        "LEFT JOIN note_drafts d ON d.id = s.draft_id WHERE s.id = ?",
        (scratch_id,)).fetchone()
    return _row_to_scratch(row) if row else None


def list_scratch(db, limit: int = 50, before_id: Optional[int] = None,
                 q: Optional[str] = None) -> List[dict]:
    where, params = [], []
    if before_id:
        where.append("s.id < ?"); params.append(before_id)
    if q and q.strip():
        where.append("(s.content LIKE ? OR s.transcript LIKE ?)")
        like = f"%{q.strip()}%"
        params += [like, like]
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    rows = db.cursor().execute(
        f"SELECT {_SCRATCH_COLS}, d.status FROM scratch s "
        f"LEFT JOIN note_drafts d ON d.id = s.draft_id {clause} "
        "ORDER BY s.id DESC LIMIT ?", params + [limit]).fetchall()
    return [_row_to_scratch(r) for r in rows]


def set_scratch_action(db, scratch_id: int, status: str,
                       action_result: Optional[dict] = None,
                       draft_id: Optional[int] = None,
                       transcript_id: Optional[int] = None,
                       transcript: Optional[str] = None,
                       llm_readable: Optional[bool] = None) -> Optional[dict]:
    sets, params = ["status = ?"], [status]
    if action_result is not None:
        sets.append("action_result = ?"); params.append(_json.dumps(action_result))
    if draft_id is not None:
        sets.append("draft_id = ?"); params.append(draft_id)
    if transcript_id is not None:
        sets.append("transcript_id = ?"); params.append(transcript_id)
    if transcript is not None:
        sets.append("transcript = ?"); params.append(transcript)
    if llm_readable is not None:
        sets.append("llm_readable = ?"); params.append(1 if llm_readable else 0)
    params.append(scratch_id)
    db.cursor().execute(f"UPDATE scratch SET {', '.join(sets)} WHERE id = ?", params)
    db.commit()
    return get_scratch(db, scratch_id)


def set_scratch_readable(db, scratch_id: int, readable: bool) -> Optional[dict]:
    db.cursor().execute("UPDATE scratch SET llm_readable = ? WHERE id = ?",
                        (1 if readable else 0, scratch_id))
    db.commit()
    return get_scratch(db, scratch_id)


def delete_scratch(db, scratch_id: int) -> Optional[dict]:
    """Delete a row; returns it (with media info intact) so the caller can
    remove the file when no other row shares the hash."""
    row = get_scratch(db, scratch_id)
    if row is None:
        return None
    db.cursor().execute("DELETE FROM scratch WHERE id = ?", (scratch_id,))
    db.commit()
    if row.get("media_hash"):
        remaining = db.cursor().execute(
            "SELECT COUNT(*) FROM scratch WHERE media_hash = ?",
            (row["media_hash"],)).fetchone()[0]
        row["media_shared"] = remaining > 0
    return row


# --- Video transcripts (STT jobs) ----------------------------------------------

TRANSCRIPT_COLUMNS = ["id", "url", "title", "duration_s", "status", "text",
                      "error", "created_at", "finished_at"]
_TRANSCRIPT_COLS = ", ".join(TRANSCRIPT_COLUMNS)


def create_transcript(db, url: str, title: Optional[str],
                      duration_s: Optional[int]) -> dict:
    cursor = db.cursor()
    cursor.execute(
        "INSERT INTO transcripts (url, title, duration_s) VALUES (?, ?, ?)",
        (url, title, duration_s))
    db.commit()
    return get_transcript(db, cursor.lastrowid)


def set_transcript_result(db, transcript_id: int, text: Optional[str] = None,
                          error: Optional[str] = None) -> None:
    db.cursor().execute(
        "UPDATE transcripts SET status = ?, text = ?, error = ?, "
        "finished_at = datetime('now') WHERE id = ?",
        ("error" if error else "done", text, error, transcript_id))
    db.commit()


def get_transcript(db, transcript_id: int) -> Optional[dict]:
    row = db.cursor().execute(
        f"SELECT {_TRANSCRIPT_COLS} FROM transcripts WHERE id = ?",
        (transcript_id,)).fetchone()
    return dict(zip(TRANSCRIPT_COLUMNS, row)) if row else None


def get_transcript_by_url(db, url: str) -> Optional[dict]:
    """Most recent transcript row for a URL — INCLUDING errored attempts, so
    failures surface to the model instead of masquerading as fresh jobs."""
    row = db.cursor().execute(
        f"SELECT {_TRANSCRIPT_COLS} FROM transcripts WHERE url = ? "
        "ORDER BY id DESC LIMIT 1", (url,)).fetchone()
    return dict(zip(TRANSCRIPT_COLUMNS, row)) if row else None


def search_transcripts(db, query: Optional[str] = None,
                       limit: int = 10) -> List[dict]:
    """Find stored transcripts by keyword over title + text (or list recent
    when query is empty). Returns metadata + a snippet around the first match —
    never the full text (the model fetches that by URL via transcribe_video)."""
    rows = db.cursor().execute(
        f"SELECT {_TRANSCRIPT_COLS} FROM transcripts WHERE status != 'error' "
        "ORDER BY id DESC").fetchall()
    out = []
    terms = [t for t in (query or "").lower().split() if len(t) >= 2]
    for row in rows:
        d = dict(zip(TRANSCRIPT_COLUMNS, row))
        text = d.pop("text") or ""
        haystack = f"{d.get('title') or ''}\n{text}".lower()
        if terms and not all(t in haystack for t in terms):
            continue
        snippet = ""
        if terms:
            pos = text.lower().find(terms[0])
            if pos >= 0:
                snippet = text[max(0, pos - 120):pos + 200].strip()
        d.pop("error", None)
        d["snippet"] = snippet
        d["chars"] = len(text)
        out.append(d)
        if len(out) >= limit:
            break
    return out


def list_transcripts(db) -> List[dict]:
    rows = db.cursor().execute(
        f"SELECT {_TRANSCRIPT_COLS} FROM transcripts ORDER BY id DESC").fetchall()
    out = []
    for row in rows:
        d = dict(zip(TRANSCRIPT_COLUMNS, row))
        d["chars"] = len(d.pop("text") or "")   # listing omits the body
        out.append(d)
    return out


def set_note_draft_status(db, draft_id: int, status: str) -> Optional[dict]:
    """Mark a draft approved/rejected (stamps decided_at). Returns updated draft."""
    if get_note_draft(db, draft_id) is None:
        return None
    db.cursor().execute(
        "UPDATE note_drafts SET status = ?, decided_at = datetime('now') WHERE id = ?",
        (status, draft_id),
    )
    db.commit()
    return get_note_draft(db, draft_id)
