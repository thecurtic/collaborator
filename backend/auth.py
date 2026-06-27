"""Authentication and passkey validation for Collaborator backend."""

import os
import hashlib
import sqlite3

from config import get_config


def _get_project_root() -> str:
    """Get the project root directory (two dirs up from backend)."""
    # Backend is at /project/backend, so go up two levels
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _get_passkeys_db_path() -> str:
    """Get authentication database path from config or default."""
    config = get_config()
    passkey_db = config.get("authentication", {}).get("passkeys_db_path")
    
    if not passkey_db:
        # Default relative path
        return os.path.join(_get_project_root(), "backend", "data", "authentication", "passkeys.db")
    
    # If absolute path, use as-is; otherwise relative to project root
    if os.path.isabs(passkey_db):
        return passkey_db
    return os.path.join(_get_project_root(), passkey_db)


def get_auth_db():
    """Get authentication database connection."""
    return sqlite3.connect(_get_passkeys_db_path())


def hash_passkey(passkey: str) -> tuple:
    """Hash a passkey with salt. Returns (hash, salt)."""
    conn = get_auth_db()
    cursor = conn.cursor()
    cursor.execute("SELECT hash, salt FROM passkeys WHERE disabled = 0")
    rows = cursor.fetchall()
    conn.close()
    
    # Try each stored hash/salt combination
    for stored_hash, salt in rows:
        if _verify_passkey(passkey, stored_hash, salt):
            return (stored_hash, salt)
    
    return None


def _verify_passkey(passkey: str, stored_hash: str, salt: str) -> bool:
    """Verify a passkey against stored hash and salt."""
    salted = passkey + salt
    computed_hash = hashlib.sha256(salted.encode()).hexdigest()
    return computed_hash == stored_hash


def is_passkey_active(passkey: str) -> bool:
    """Check if a passkey exists and is enabled."""
    conn = get_auth_db()
    cursor = conn.cursor()
    
    # Hash the provided passkey
    cursor.execute("SELECT hash, salt FROM passkeys WHERE disabled = 0")
    rows = cursor.fetchall()
    conn.close()
    
    for stored_hash, salt in rows:
        if _verify_passkey(passkey, stored_hash, salt):
            return True
    
    return False


def validate_passkey(passkey: str) -> bool:
    """Validate passkey - returns True if valid."""
    if not passkey:
        return False
    
    # If auth is disabled, allow all
    config = get_config()
    if not config.get("authentication", {}).get("enabled", False):
        return True
    
    return is_passkey_active(passkey)


def _get_user_db_path(passkey: str) -> str:
    """Get the user database path for a passkey."""
    config = get_config()
    users_dir = config.get("authentication", {}).get("users_dir")
    
    if not users_dir:
        # Default relative path
        users_dir = os.path.join(_get_project_root(), "backend", "data", "users")
    elif not os.path.isabs(users_dir):
        # Relative to project root
        users_dir = os.path.join(_get_project_root(), users_dir)
    
    # Hash the passkey to get user directory name
    conn = get_auth_db()
    cursor = conn.cursor()
    cursor.execute("SELECT hash FROM passkeys WHERE disabled = 0")
    rows = cursor.fetchall()
    conn.close()
    
    user_hash = None
    for stored_hash, salt in rows:
        if _verify_passkey(passkey, stored_hash, salt):
            user_hash = stored_hash
            break
    
    if not user_hash:
        raise ValueError("Invalid passkey")
    
    return os.path.join(users_dir, user_hash, "conversations.db")


def create_user_db(passkey: str) -> str:
    """Create user database if it doesn't exist."""
    from db import init_db
    
    config = get_config()
    users_dir = config.get("authentication", {}).get("users_dir")
    
    if not users_dir:
        # Default relative path
        users_dir = os.path.join(_get_project_root(), "backend", "data", "users")
    elif not os.path.isabs(users_dir):
        # Relative to project root
        users_dir = os.path.join(_get_project_root(), users_dir)
    
    # Get or create user hash
    conn = get_auth_db()
    cursor = conn.cursor()
    cursor.execute("SELECT hash, salt FROM passkeys WHERE disabled = 0")
    rows = cursor.fetchall()
    conn.close()
    
    user_hash = None
    for stored_hash, salt in rows:
        if _verify_passkey(passkey, stored_hash, salt):
            user_hash = stored_hash
            break
    
    if not user_hash:
        raise ValueError("Invalid passkey")
    
    # Create directory if needed
    user_dir = os.path.join(users_dir, user_hash)
    os.makedirs(user_dir, exist_ok=True)
    
    # Create database path
    db_path = os.path.join(user_dir, "conversations.db")
    
    # Initialize database schema if file doesn't exist
    if not os.path.exists(db_path):
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Create tables
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
        
        conn.commit()
        conn.close()
    
    return db_path
