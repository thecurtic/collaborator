"""Initialize authentication and user data directories."""

import os
import sqlite3


def init_authentication_db():
    """Initialize passkeys database with schema."""
    db_path = "/home/chat/collaborator/backend/data/authentication/passkeys.db"
    
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
    users_dir = "/home/chat/collaborator/backend/data/users"
    
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
