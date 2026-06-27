"""Initialize authentication and user data directories."""

import os
import sqlite3


def _get_project_root() -> str:
    """Get the project root directory (one level up from backend)."""
    # Backend is at /project/backend, so go up one level
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


def init_authentication_db():
    """Initialize passkeys database with schema."""
    config = __import__('config', fromlist=['get_config']).get_config()
    passkey_db_path = config.get("authentication", {}).get("passkeys_db_path")
    
    if not passkey_db_path:
        # Default relative path
        db_path = os.path.join(_get_project_root(), "backend", "data", "authentication", "passkeys.db")
    else:
        # Resolve the path
        db_path = _resolve_path(passkey_db_path)
    
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
    config = __import__('config', fromlist=['get_config']).get_config()
    users_dir = config.get("authentication", {}).get("users_dir")
    
    if not users_dir:
        # Default relative path
        users_dir = os.path.join(_get_project_root(), "backend", "data", "users")
    else:
        # Resolve the path
        users_dir = _resolve_path(users_dir)
    
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

