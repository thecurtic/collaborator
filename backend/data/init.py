"""Initialize authentication and user data directories."""

import os
import sqlite3

try:
    from ..config import resolve_path, get_config
except ImportError:
    import sys
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)
    from config import resolve_path, get_config


def _resolve_auth_path(path: str) -> str:
    """Resolve a path using the shared resolve_path helper."""
    if not path:
        # Default relative paths
        return resolve_path("backend/data/authentication/passkeys.db")
    return resolve_path(path)


def init_authentication_db():
    """Initialize passkeys database with schema."""
    try:
        config = get_config()
        passkey_db_path = config.get("authentication", {}).get("passkeys_db_path")
    except Exception:
        passkey_db_path = None
    
    if not passkey_db_path:
        # Default relative path
        db_path = resolve_path("backend/data/authentication/passkeys.db")
    else:
        # Resolve the path
        db_path = resolve_path(passkey_db_path)
    
    # Ensure directory exists
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Create passkeys table
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
    
    # Create index on hash for lookups
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_passkeys_hash ON passkeys(hash)")
    
    conn.commit()
    conn.close()
    
    print(f"Initialized authentication database at {db_path}")


def init_user_data():
    """Ensure user data directory structure exists."""
    try:
        config = get_config()
        users_dir = config.get("authentication", {}).get("users_dir")
    except Exception:
        users_dir = None
    
    if not users_dir:
        # Default relative path
        users_dir = resolve_path("backend/data/users")
    else:
        # Resolve the path
        users_dir = resolve_path(users_dir)
    
    # Create users directory
    os.makedirs(users_dir, exist_ok=True)
    
    # Create .gitkeep to keep directory in git
    gitkeep_path = os.path.join(users_dir, ".gitkeep")
    if not os.path.exists(gitkeep_path):
        with open(gitkeep_path, 'w') as f:
            f.write("# Keep this directory in git\n")
    
    print(f"Initialized user data directory at {users_dir}")


def init_all():
    """Initialize all data directories and databases."""
    init_authentication_db()
    init_user_data()


if __name__ == "__main__":
    init_all()

