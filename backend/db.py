import sqlite3
from typing import Optional
from contextlib import contextmanager

DB_PATH = os.environ.get("DB_PATH", "/home/chat/collaborator/backend/data/conversations.db")


def get_db():
    """Get a database connection."""
    return sqlite3.connect(DB_PATH)


@contextmanager
def get_db_cursor():
    """Context manager for database connections."""
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn.cursor()
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()


def init_db():
    """Initialize the database with required tables."""
    with get_db_cursor() as cursor:
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
                tags TEXT
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


def create_turn(
    db,
    user_id: Optional[str],
    role: str,
    content: str,
    context_turns: int = 5,
    committed: bool = True,
    model_name: Optional[str] = None,
    token_count: Optional[int] = None
) -> dict:
    """Create a new turn in the database."""
    cursor = db.cursor()
    cursor.execute(
        """
        INSERT INTO turns (user_id, role, content, context_turns, committed, model_name, token_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (user_id, role, content, context_turns, committed, model_name, token_count)
    )
    db.commit()
    
    turn_id = cursor.lastrowid
    return get_turn_by_id(db, turn_id)


def get_turn_by_id(db, turn_id: int) -> Optional[dict]:
    """Get a single turn by ID."""
    cursor = db.cursor()
    cursor.execute("SELECT * FROM turns WHERE id = ?", (turn_id,))
    row = cursor.fetchone()
    
    if not row:
        return None
    
    columns = ['id', 'user_id', 'role', 'content', 'context_turns', 'committed', 'created_at', 'model_name', 'token_count', 'tags']
    return dict(zip(columns, row))


def get_recent_turns(db, limit: int = 10, offset: int = 0) -> list:
    """Get recent committed turns."""
    cursor = db.cursor()
    cursor.execute(
        """
        SELECT * FROM turns 
        WHERE committed = 1 
        ORDER BY id DESC 
        LIMIT ? OFFSET ?
        """,
        (limit, offset)
    )
    
    rows = cursor.fetchall()
    columns = ['id', 'user_id', 'role', 'content', 'context_turns', 'committed', 'created_at', 'model_name', 'token_count', 'tags']
    return [dict(zip(columns, row)) for row in rows]


def update_turn_committed(db, turn_id: int, committed: bool) -> bool:
    """Update the committed status of a turn."""
    cursor = db.cursor()
    cursor.execute("UPDATE turns SET committed = ? WHERE id = ?", (committed, turn_id))
    db.commit()
    return cursor.rowcount > 0


def get_context_for_turn(db, after_turn_id: int, limit: int = 5) -> list:
    """Get committed turns after a specific turn ID."""
    cursor = db.cursor()
    cursor.execute(
        """
        SELECT * FROM turns 
        WHERE committed = 1 AND id > ?
        ORDER BY id DESC 
        LIMIT ?
        """,
        (after_turn_id, limit)
    )
    
    rows = cursor.fetchall()
    columns = ['id', 'user_id', 'role', 'content', 'context_turns', 'committed', 'created_at', 'model_name', 'token_count', 'tags']
    return [dict(zip(columns, row)) for row in rows]
