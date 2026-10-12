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


def get_db_connection():
    """Connection to the passkeys DB (path resolved at call time so a config
    change, e.g. in tests, is honoured). Creates the directory on a fresh
    install; SQLite only creates the file."""
    path = _get_passkeys_db_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return sqlite3.connect(path)


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
    """Create a new passkey and store it in the database.

    Writes BOTH hashes: the SHA-256 identity hash (names the user's data dir,
    stable forever) and the Argon2id kdf_hash (the actual verifier)."""
    passkey = generate_passkey()
    hash_value, salt = hash_passkey(passkey)
    try:
        import auth as _auth
        kdf = _auth.kdf_hash(passkey)
    except ImportError:
        _auth = None
        kdf = None

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        if _auth is not None:
            # First run on a fresh install: create the tables (same schema the
            # server itself ensures at startup).
            _auth.ensure_auth_schema(conn)
        cursor.execute("PRAGMA table_info(passkeys)")
        cols = {row[1] for row in cursor.fetchall()}
        if "kdf_hash" not in cols:
            cursor.execute("ALTER TABLE passkeys ADD COLUMN kdf_hash TEXT")
        cursor.execute(
            """
            INSERT INTO passkeys (hash, salt, created_at, kdf_hash)
            VALUES (?, ?, ?, ?)
            """,
            (hash_value, salt, datetime.now().isoformat(), kdf)
        )
        conn.commit()
        print(f"✓ Generated passkey: {passkey}")
        print(f"  Identity hash: {hash_value}")
        print("  (names this user's data directory and keys per-user config; "
              "use it for rotate / revoke)")
    except sqlite3.IntegrityError:
        print("✗ Error: Passkey hash collision (extremely unlikely)")
    finally:
        conn.close()

    return passkey


def _resolve_identity(cursor, identity: str):
    """Find one enabled passkey row by full identity hash or unique prefix.
    Returns (row_id, hash) or None (prints why)."""
    identity = (identity or "").strip().lower()
    if len(identity) < 8:
        print("✗ Error: give at least 8 characters of the identity hash")
        return None
    rows = cursor.execute(
        "SELECT id, hash FROM passkeys WHERE disabled = 0 AND hash LIKE ?",
        (identity + "%",)).fetchall()
    if not rows:
        print("✗ Error: no active passkey matches that identity hash")
        return None
    if len(rows) > 1:
        print("✗ Error: prefix is ambiguous; give more characters")
        return None
    return rows[0]


def rotate_passkey(identity: str):
    """Issue a NEW passkey for an EXISTING identity and log every device out.

    The identity hash (the `hash` column) is untouched, so the user's data
    directory, wallet config and everything keyed by it stay exactly where
    they are. What changes: the Argon2id verifier (now of the new passkey)
    and the salt (so the legacy SHA-256 path can never verify the old
    passkey again). All sessions for the identity are revoked.

    Requires argon2-cffi: without it the new passkey would have no verifier.
    Returns the new passkey, or None on failure."""
    try:
        import auth as _auth
    except ImportError:
        print("✗ Error: cannot import the auth module")
        return None
    new_passkey = generate_passkey()
    kdf = _auth.kdf_hash(new_passkey)
    if not kdf:
        print("✗ Error: argon2-cffi is required to rotate a passkey "
              "(pip install argon2-cffi)")
        return None

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        _auth.ensure_auth_schema(conn)
        found = _resolve_identity(cursor, identity)
        if not found:
            return None
        row_id, identity_hash = found
        cursor.execute(
            "UPDATE passkeys SET salt = ?, kdf_hash = ? WHERE id = ?",
            (secrets.token_hex(16), kdf, row_id))
        cursor.execute(
            "UPDATE sessions SET revoked = 1 WHERE user_hash = ? AND revoked = 0",
            (identity_hash,))
        revoked = cursor.rowcount
        conn.commit()
        print(f"✓ Rotated passkey for identity {identity_hash[:12]}…")
        print(f"  New passkey: {new_passkey}")
        print(f"  Identity hash (unchanged): {identity_hash}")
        print(f"  Sessions logged out: {revoked}")
        print("  The old passkey no longer works. Nothing on disk moved.")
        return new_passkey
    finally:
        conn.close()


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

    subparsers.add_parser("create", aliases=["generate"],
                          help="Create a new passkey (a new identity)")

    rotate_parser = subparsers.add_parser(
        "rotate", help="Issue a new passkey for an existing identity; "
                       "keeps its data, logs every device out")
    rotate_parser.add_argument("identity",
                               help="Identity hash (or unique prefix, 8+ chars)")

    revoke_parser = subparsers.add_parser("revoke", help="Revoke a passkey")
    revoke_parser.add_argument("hash", help="Identity hash to revoke")

    subparsers.add_parser("list", help="List all passkeys")

    args = parser.parse_args()

    if args.command in ("create", "generate"):
        create_passkey()
    elif args.command == "rotate":
        rotate_passkey(args.identity)
    elif args.command == "revoke":
        revoke_passkey(args.hash)
    elif args.command == "list":
        list_passkeys()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

