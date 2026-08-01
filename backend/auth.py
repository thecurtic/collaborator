"""Authentication for Collaborator: passkeys, sessions, lockout.

Extended-cognition data deserves better than a forever-credential in
localStorage (gitea issue #1 / audit finding #2). Three layers:

- PASSKEYS: the master credential, entered once per device at login. Verified
  with Argon2id. Legacy rows (unsalted-stretch SHA-256) still verify and are
  TRANSPARENTLY upgraded on first successful use — the legacy hash column is
  never removed because it doubles as the user's identity (per-user data dirs
  are named by it); after upgrade it is identity-only, never a verifier.
- SESSIONS: what clients actually hold. High-entropy tokens (stored hashed),
  device-labeled, listable, revocable, idle + absolute expiry. Sent as an
  httpOnly cookie or an X-Session header (Capacitor wrapper).
- LOCKOUT: global exponential backoff on failed passkey attempts (the app is
  internet-facing). Sessions keep working during a lockout, so an attacker
  can slow down NEW logins but can't lock the user out of their devices.
"""

import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time
from contextvars import ContextVar
from typing import Optional

from config import get_config, resolve_path

try:
    from argon2 import PasswordHasher
    from argon2.exceptions import VerifyMismatchError
    _hasher = PasswordHasher()          # argon2id, library defaults
except ImportError:                     # tolerated absent: legacy verify only
    _hasher = None


# --- DB ------------------------------------------------------------------------

def _get_passkeys_db_path() -> str:
    config = get_config()
    passkey_db_path = config.get("authentication", {}).get("passkeys_db_path")
    if not passkey_db_path:
        return resolve_path("backend/data/authentication/passkeys.db")
    return resolve_path(passkey_db_path)


_schema_ready = False


def get_auth_db():
    """Connection to the auth DB, with the schema ensured once per process."""
    global _schema_ready
    conn = sqlite3.connect(_get_passkeys_db_path())
    if not _schema_ready:
        ensure_auth_schema(conn)
        _schema_ready = True
    return conn


def ensure_auth_schema(conn) -> None:
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS passkeys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT UNIQUE NOT NULL,
            salt TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            disabled BOOLEAN NOT NULL DEFAULT 0,
            expires_at TEXT,
            kdf_hash TEXT
        )
    """)
    cols = {row[1] for row in cursor.execute("PRAGMA table_info(passkeys)").fetchall()}
    if "kdf_hash" not in cols:
        # Argon2id verifier. The legacy `hash` column stays as the user's
        # IDENTITY (data dirs are named by it) — post-upgrade it is never
        # consulted for verification again.
        cursor.execute("ALTER TABLE passkeys ADD COLUMN kdf_hash TEXT")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT UNIQUE NOT NULL,
            user_hash TEXT NOT NULL,
            label TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            revoked BOOLEAN NOT NULL DEFAULT 0
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash)")
    conn.commit()


# --- Passkey verification (Argon2id, transparent legacy upgrade) ---------------

def _legacy_verify(passkey: str, stored_hash: str, salt: str) -> bool:
    computed = hashlib.sha256((passkey + salt).encode()).hexdigest()
    return hmac.compare_digest(computed, stored_hash)


def kdf_hash(passkey: str) -> Optional[str]:
    """Argon2id hash for a passkey (None when argon2 is unavailable)."""
    return _hasher.hash(passkey) if _hasher else None


def _find_passkey_row(passkey: str):
    """Match a passkey against enabled rows. Returns (identity_hash, row_id) or
    None. Argon2 kdf_hash is authoritative when present; legacy rows verify by
    SHA-256 and are upgraded in place."""
    conn = get_auth_db()
    try:
        rows = conn.cursor().execute(
            "SELECT id, hash, salt, kdf_hash, expires_at FROM passkeys "
            "WHERE disabled = 0").fetchall()
        for row_id, stored_hash, salt, stored_kdf, expires_at in rows:
            if expires_at and str(expires_at) <= time.strftime("%Y-%m-%dT%H:%M:%S"):
                continue
            if stored_kdf and _hasher:
                try:
                    _hasher.verify(stored_kdf, passkey)
                    return stored_hash, row_id
                except VerifyMismatchError:
                    continue
                except Exception:
                    continue
            if _legacy_verify(passkey, stored_hash, salt):
                if _hasher and not stored_kdf:
                    # Transparent upgrade: from here on Argon2 is authoritative.
                    conn.cursor().execute(
                        "UPDATE passkeys SET kdf_hash = ? WHERE id = ?",
                        (_hasher.hash(passkey), row_id))
                    conn.commit()
                    print(f"Auth: passkey row {row_id} upgraded to Argon2id")
                return stored_hash, row_id
        return None
    finally:
        conn.close()


def is_passkey_active(passkey: str) -> bool:
    return _find_passkey_row(passkey) is not None


def validate_passkey(passkey: str) -> bool:
    """Validate passkey - returns True if valid."""
    if not passkey:
        return False
    config = get_config()
    if not config.get("authentication", {}).get("enabled", False):
        return True
    return is_passkey_active(passkey)


def user_hash_for_passkey(passkey: str) -> Optional[str]:
    """The stable identity hash for a valid passkey (names the user's data dir)."""
    found = _find_passkey_row(passkey)
    return found[0] if found else None


# --- Lockout (global exponential backoff on failed passkey attempts) -----------

_lockout_lock = threading.Lock()
_lockout = {"failures": 0, "locked_until": 0.0}


def _lockout_cfg() -> dict:
    return get_config().get("authentication", {}) or {}


def lockout_remaining() -> int:
    """Seconds until passkey attempts are accepted again (0 = not locked)."""
    with _lockout_lock:
        return max(0, int(_lockout["locked_until"] - time.time()))


def record_auth_failure() -> None:
    cfg = _lockout_cfg()
    threshold = cfg.get("lockout_threshold", 5)
    base = cfg.get("lockout_base_seconds", 60)
    cap = cfg.get("lockout_max_seconds", 3600)
    with _lockout_lock:
        _lockout["failures"] += 1
        over = _lockout["failures"] - threshold
        if over >= 0:
            delay = min(cap, base * (2 ** over))
            _lockout["locked_until"] = time.time() + delay
            print(f"Warning: auth lockout engaged — {_lockout['failures']} "
                  f"consecutive failed passkey attempts; new logins blocked "
                  f"for {delay}s (existing sessions unaffected)")
        else:
            print(f"Warning: failed passkey attempt "
                  f"({_lockout['failures']}/{threshold} before lockout)")


def record_auth_success() -> None:
    with _lockout_lock:
        _lockout["failures"] = 0
        _lockout["locked_until"] = 0.0


def _reset_lockout_for_tests() -> None:
    record_auth_success()


# --- Sessions -------------------------------------------------------------------

# Set per-request by the session middleware: (user_hash, session_id) or None.
current_session: ContextVar[Optional[tuple]] = ContextVar(
    "current_session", default=None)

_LAST_SEEN_THROTTLE = 60  # write last_seen at most once a minute per session
_last_seen_cache: dict = {}


def _token_hash(token: str) -> str:
    # Session tokens are 256-bit random — a fast hash is fine here; the KDF is
    # for the human-scale passkey, not for machine-generated tokens.
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(user_hash: str, label: Optional[str] = None) -> dict:
    """Mint a session. Returns {token, id, label, expires_at} — the token is
    shown ONCE; only its hash is stored."""
    cfg = _lockout_cfg()
    absolute_days = cfg.get("session_absolute_days", 90)
    token = secrets.token_urlsafe(32)
    expires_at = time.strftime(
        "%Y-%m-%dT%H:%M:%S", time.localtime(time.time() + absolute_days * 86400))
    conn = get_auth_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO sessions (token_hash, user_hash, label, expires_at) "
            "VALUES (?, ?, ?, ?)",
            (_token_hash(token), user_hash, (label or "").strip()[:80] or None,
             expires_at))
        conn.commit()
        return {"token": token, "id": cursor.lastrowid,
                "label": (label or "").strip()[:80] or None,
                "expires_at": expires_at}
    finally:
        conn.close()


def validate_session(token: Optional[str]):
    """Resolve a session token -> (user_hash, session_id) or None.

    Enforces revocation, absolute expiry, and idle expiry (last_seen +
    session_idle_days). Touches last_seen (throttled)."""
    if not token:
        return None
    cfg = _lockout_cfg()
    idle_days = cfg.get("session_idle_days", 30)
    thash = _token_hash(token)
    now = time.time()
    conn = get_auth_db()
    try:
        row = conn.cursor().execute(
            "SELECT id, user_hash, last_seen, expires_at, revoked FROM sessions "
            "WHERE token_hash = ?", (thash,)).fetchone()
        if row is None:
            return None
        session_id, user_hash, last_seen, expires_at, revoked = row
        if revoked:
            return None
        now_str = time.strftime("%Y-%m-%dT%H:%M:%S")
        if str(expires_at).replace(" ", "T") <= now_str:
            return None
        try:
            seen_ts = time.mktime(time.strptime(
                str(last_seen).replace("T", " ")[:19], "%Y-%m-%d %H:%M:%S"))
            if now - seen_ts > idle_days * 86400:
                return None
        except ValueError:
            pass
        if now - _last_seen_cache.get(session_id, 0) > _LAST_SEEN_THROTTLE:
            _last_seen_cache[session_id] = now
            conn.cursor().execute(
                "UPDATE sessions SET last_seen = ? WHERE id = ?",
                (now_str, session_id))
            conn.commit()
        return user_hash, session_id
    finally:
        conn.close()


def list_sessions(user_hash: str, current_id: Optional[int] = None) -> list:
    conn = get_auth_db()
    try:
        rows = conn.cursor().execute(
            "SELECT id, label, created_at, last_seen, expires_at FROM sessions "
            "WHERE user_hash = ? AND revoked = 0 ORDER BY last_seen DESC",
            (user_hash,)).fetchall()
        return [{"id": r[0], "label": r[1], "created_at": r[2],
                 "last_seen": r[3], "expires_at": r[4],
                 "current": r[0] == current_id} for r in rows]
    finally:
        conn.close()


def revoke_session(user_hash: str, session_id: int) -> bool:
    conn = get_auth_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE sessions SET revoked = 1 WHERE id = ? AND user_hash = ?",
            (session_id, user_hash))
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


# --- Per-user DB provisioning ---------------------------------------------------

def _users_dir() -> str:
    users_dir = get_config().get("authentication", {}).get("users_dir")
    return resolve_path(users_dir) if users_dir else resolve_path("backend/data/users")


def create_user_db_from_hash(user_hash: str) -> str:
    """Provision (or migrate) the per-user conversation DB for an identity hash."""
    from db import ensure_conversation_schema
    user_dir = os.path.join(_users_dir(), user_hash)
    os.makedirs(user_dir, exist_ok=True)
    db_path = os.path.join(user_dir, "conversations.db")
    conn = sqlite3.connect(db_path)
    try:
        ensure_conversation_schema(conn)
    finally:
        conn.close()
    return db_path


def create_user_db(passkey: str) -> str:
    """Resolve a passkey to its per-user DB (legacy name, kept for callers)."""
    user_hash = user_hash_for_passkey(passkey)
    if not user_hash:
        raise ValueError("Invalid passkey")
    return create_user_db_from_hash(user_hash)
