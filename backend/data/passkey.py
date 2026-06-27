"""CLI tool for passkey management."""

import argparse
import hashlib
import os
import sqlite3
import secrets
from datetime import datetime, timedelta

# Import from parent package directory (backend/)
try:
    # Try relative import first
    from ..config import get_config, resolve_path
except ImportError:
    # Fall back to absolute import with sys.path manipulation
    import sys
    import os
    # Add backend directory to path
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)
    from config import get_config, resolve_path


def _get_passkeys_db_path() -> str:
    """Get authentication database path from config or default."""
    try:
        passkey_db_path = get_config().get("authentication", {}).get("passkeys_db_path")
        
        if not passkey_db_path:
            # Default relative path
            return resolve_path("backend/data/authentication/passkeys.db")
        
        return resolve_path(passkey_db_path)
    except ImportError:
        # Fallback
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return resolve_path("backend/data/authentication/passkeys.db")


PASSKEYS_DB_PATH = _get_passkeys_db_path()


def get_db_connection():
    """Get database connection."""
    return sqlite3.connect(PASSKEYS_DB_PATH)


def hash_passkey(passkey: str) -> tuple:
    """Hash a passkey with salt. Returns (hash, salt)."""
    salt = secrets.token_hex(16)
    salted = passkey + salt
    hash_value = hashlib.sha256(salted.encode()).hexdigest()
    return (hash_value, salt)


def generate_passkey() -> str:
    """Generate a secure random passkey."""
    return secrets.token_urlsafe(32)


def create_passkey() -> str:
    """Create a new passkey and store it in the database."""
    passkey = generate_passkey()
    hash_value, salt = hash_passkey(passkey)
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        cursor.execute(
            """
            INSERT INTO passkeys (hash, salt, created_at)
            VALUES (?, ?, ?)
            """,
            (hash_value, salt, datetime.now().isoformat())
        )
        conn.commit()
        print(f"✓ Generated passkey: {passkey}")
        print(f"  Hash (for revocation): {hash_value}")
    except sqlite3.IntegrityError:
        print("✗ Error: Passkey hash collision (extremely unlikely)")
    finally:
        conn.close()
    
    return passkey


def revoke_passkey(passkey_hash: str) -> bool:
    """Disable a passkey by hash."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Check if passkey exists
    cursor.execute("SELECT id, disabled FROM passkeys WHERE hash = ?", (passkey_hash,))
    row = cursor.fetchone()
    
    if not row:
        print(f"✗ Error: Passkey hash not found")
        conn.close()
        return False
    
    passkey_id, is_disabled = row
    
    if is_disabled:
        print(f"✗ Error: Passkey already revoked")
        conn.close()
        return False
    
    cursor.execute("UPDATE passkeys SET disabled = 1 WHERE id = ?", (passkey_id,))
    conn.commit()
    print(f"✓ Revoked passkey ID {passkey_id}")
    
    conn.close()
    return True


def list_passkeys():
    """List all passkeys."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT id, hash, created_at, disabled FROM passkeys ORDER BY id DESC")
    rows = cursor.fetchall()
    
    if not rows:
        print("No passkeys found.")
        conn.close()
        return
    
    print(f"{'ID':<6} {'Hash (first 10)':<18} {'Created':<25} {'Status'}")
    print("-" * 70)
    
    for row in rows:
        passkey_id, hash_val, created_at, disabled = row
        status = "REVOKED" if disabled else "ACTIVE"
        print(f"{passkey_id:<6} {hash_val[:10]:<18} {created_at:<25} {status}")
    
    conn.close()


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Passkey management for Collaborator"
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    # Generate command
    gen_parser = subparsers.add_parser("generate", help="Generate a new passkey")
    
    # Revoke command
    revoke_parser = subparsers.add_parser("revoke", help="Revoke a passkey")
    revoke_parser.add_argument("hash", help="Passkey hash to revoke")
    
    # List command
    subparsers.add_parser("list", help="List all passkeys")
    
    args = parser.parse_args()
    
    if args.command == "generate":
        create_passkey()
    elif args.command == "revoke":
        revoke_passkey(args.hash)
    elif args.command == "list":
        list_passkeys()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

