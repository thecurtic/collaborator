"""Tests for Phase A auth: Argon2 migration, sessions, lockout.

Auth is enabled at TEST time via the autouse fixture (import-time env/reloads
would leak into the rest of the suite — see the test-isolation note in the
project backlog). Temp passkeys DB per test."""

import hashlib
import os
import secrets
import sqlite3
import tempfile

import pytest

os.environ.setdefault("AUTH_ENABLED", "false")
os.environ.setdefault("DB_PATH",
                      os.path.join(tempfile.mkdtemp(), "conversations.db"))
import config
config.get_config._config = config.load_config()
import auth, db, main
from starlette.testclient import TestClient

PASSKEY = "correct-horse-battery-staple"


@pytest.fixture(autouse=True)
def _auth_enabled_world():
    """Point auth at a fresh temp DB and enable it — runtime only, restored."""
    cfg = config.get_config()["authentication"]
    saved = dict(cfg)
    saved_enabled = main.auth_enabled
    saved_schema = auth._schema_ready
    cfg.update({
        "enabled": True,
        "passkeys_db_path": os.path.join(tempfile.mkdtemp(), "passkeys.db"),
        "users_dir": tempfile.mkdtemp(),
        "session_idle_days": 30, "session_absolute_days": 90,
        "lockout_threshold": 5, "lockout_base_seconds": 60,
        "lockout_max_seconds": 3600,
    })
    main.auth_enabled = True
    auth._schema_ready = False
    auth._last_seen_cache.clear()
    auth._reset_lockout_for_tests()
    try:
        yield
    finally:
        cfg.clear()
        cfg.update(saved)
        main.auth_enabled = saved_enabled
        auth._schema_ready = saved_schema
        auth._reset_lockout_for_tests()


def _seed_legacy_passkey(passkey=PASSKEY):
    """Insert a pre-Argon2 row exactly as the old code wrote it."""
    salt = secrets.token_hex(16)
    h = hashlib.sha256((passkey + salt).encode()).hexdigest()
    conn = auth.get_auth_db()
    conn.cursor().execute(
        "INSERT OR IGNORE INTO passkeys (hash, salt) VALUES (?, ?)", (h, salt))
    conn.commit()
    conn.close()
    return h


def test_legacy_verify_and_transparent_upgrade():
    identity = _seed_legacy_passkey()

    assert auth.validate_passkey(PASSKEY) is True          # legacy path works
    conn = auth.get_auth_db()
    kdf = conn.cursor().execute(
        "SELECT kdf_hash FROM passkeys WHERE hash = ?", (identity,)).fetchone()[0]
    conn.close()
    assert kdf and kdf.startswith("$argon2")               # upgraded in place

    # Post-upgrade: argon2 is authoritative and still validates; identity
    # hash (-> data dir name) unchanged.
    assert auth.validate_passkey(PASSKEY) is True
    assert auth.user_hash_for_passkey(PASSKEY) == identity
    assert auth.validate_passkey("wrong") is False
    print("✓ legacy sha256 verifies, upgrades to argon2, identity stable")


def test_login_session_flow():
    _seed_legacy_passkey()
    # https base: the cookie is Secure-flagged, so an http test client would
    # (correctly) refuse to send it back.
    c = TestClient(main.app, base_url="https://testserver")

    # Login mints a session: token in body + httpOnly cookie.
    r = c.post("/api/auth/login", json={"passkey": PASSKEY,
                                        "device_label": "my phone"})
    assert r.status_code == 200
    token = r.json()["token"]
    assert "collaborator_session" in r.cookies
    set_cookie = r.headers["set-cookie"]
    assert "HttpOnly" in set_cookie and "Secure" in set_cookie

    # Cookie authenticates a protected endpoint (no passkey header).
    r2 = c.get("/api/messages")            # TestClient carries the cookie jar
    assert r2.status_code == 200

    # Header mode (Capacitor): fresh client, X-Session only.
    c2 = TestClient(main.app)
    assert c2.get("/api/messages").status_code == 403
    assert c2.get("/api/messages", headers={"X-Session": token}).status_code == 200
    # Legacy X-Passkey keeps working during migration.
    assert c2.get("/api/messages",
                  headers={"X-Passkey": PASSKEY}).status_code == 200

    # Sessions list shows the device; revoking kills the token immediately.
    listing = c2.get("/api/auth/sessions",
                     headers={"X-Session": token}).json()["sessions"]
    mine = [s for s in listing if s["label"] == "my phone"]
    assert mine and mine[0]["current"] is True
    sid = mine[0]["id"]
    r3 = c2.delete(f"/api/auth/sessions/{sid}", headers={"X-Session": token})
    assert r3.status_code == 200
    assert c2.get("/api/messages", headers={"X-Session": token}).status_code == 403
    print("✓ login -> cookie + header sessions, list, revoke")


def test_logout_revokes_current():
    _seed_legacy_passkey()
    c = TestClient(main.app)
    token = c.post("/api/auth/login", json={"passkey": PASSKEY}).json()["token"]
    r = c.post("/api/auth/logout", headers={"X-Session": token})
    assert r.status_code == 200 and r.json()["logged_out"]
    assert c.get("/api/messages", headers={"X-Session": token}).status_code == 403
    print("✓ logout revokes the current session")


def test_session_expiry_paths():
    _seed_legacy_passkey()
    user_hash = auth.user_hash_for_passkey(PASSKEY)
    session = auth.create_session(user_hash, "old device")
    conn = auth.get_auth_db()
    # Absolute expiry in the past -> invalid.
    conn.cursor().execute(
        "UPDATE sessions SET expires_at = '2020-01-01T00:00:00' WHERE id = ?",
        (session["id"],))
    conn.commit()
    conn.close()
    assert auth.validate_session(session["token"]) is None

    # Idle expiry: last_seen far in the past.
    s2 = auth.create_session(user_hash, "idle device")
    conn = auth.get_auth_db()
    conn.cursor().execute(
        "UPDATE sessions SET last_seen = '2020-01-01T00:00:00' WHERE id = ?",
        (s2["id"],))
    conn.commit()
    conn.close()
    assert auth.validate_session(s2["token"]) is None
    assert auth.validate_session("bogus-token") is None
    print("✓ absolute + idle expiry, bogus tokens rejected")


def test_lockout_backoff_and_session_immunity():
    _seed_legacy_passkey()
    c = TestClient(main.app)
    good = c.post("/api/auth/login", json={"passkey": PASSKEY}).json()["token"]

    threshold = config.get_config()["authentication"]["lockout_threshold"]
    for _ in range(threshold):
        assert c.post("/api/auth/login",
                      json={"passkey": "wrong"}).status_code == 403
    # Threshold reached: passkey auth now 429s...
    r = c.post("/api/auth/login", json={"passkey": PASSKEY})
    assert r.status_code == 429 and "Retry-After" in r.headers
    r2 = c.get("/api/messages", headers={"X-Passkey": PASSKEY})
    assert r2.status_code == 429
    # ...but the established session sails through (no user lock-out).
    assert c.get("/api/messages", headers={"X-Session": good}).status_code == 200
    auth._reset_lockout_for_tests()
    print("✓ lockout blocks new passkey auth, never established sessions")


def test_new_passkeys_get_argon2_at_creation():
    """data/passkey.py writes both the identity hash and the argon2 verifier."""
    from data import passkey as pk
    import unittest.mock as mock
    with mock.patch.object(pk, "get_db_connection", lambda: auth.get_auth_db()):
        new_key = pk.create_passkey()
    conn = auth.get_auth_db()
    row = conn.cursor().execute(
        "SELECT kdf_hash FROM passkeys ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    assert row[0] and row[0].startswith("$argon2")
    assert auth.validate_passkey(new_key) is True
    print("✓ newly created passkeys are argon2 from birth")
