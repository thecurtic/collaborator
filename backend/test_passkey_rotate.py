"""Passkey rotation: a new passkey for the SAME identity, old one dead,
every session logged out, nothing on disk moved.

Same runtime-only auth world as test_sessions.py (temp passkeys DB per test)."""

import importlib.util
import os
import tempfile

import pytest

os.environ.setdefault("AUTH_ENABLED", "false")
os.environ.setdefault("DB_PATH",
                      os.path.join(tempfile.mkdtemp(), "conversations.db"))
import config
config.get_config._config = config.load_config()
import auth, main

_spec = importlib.util.spec_from_file_location(
    "passkey_cli", os.path.join(os.path.dirname(__file__), "data", "passkey.py"))
passkey_cli = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(passkey_cli)


@pytest.fixture(autouse=True)
def _auth_enabled_world():
    cfg = config.get_config()["authentication"]
    saved = dict(cfg)
    saved_enabled = main.auth_enabled
    saved_schema = auth._schema_ready
    cfg.update({
        "enabled": True,
        "passkeys_db_path": os.path.join(tempfile.mkdtemp(), "passkeys.db"),
        "users_dir": tempfile.mkdtemp(),
    })
    main.auth_enabled = True
    auth._schema_ready = False
    auth._last_seen_cache.clear()
    try:
        yield
    finally:
        cfg.clear()
        cfg.update(saved)
        main.auth_enabled = saved_enabled
        auth._schema_ready = saved_schema


def test_rotate_keeps_identity_kills_old_passkey_and_sessions():
    old = passkey_cli.create_passkey()
    identity = auth.user_hash_for_passkey(old)
    assert identity

    session = auth.create_session(identity, "phone")
    assert auth.validate_session(session["token"])[0] == identity

    new = passkey_cli.rotate_passkey(identity[:12])
    assert new and new != old

    assert auth.user_hash_for_passkey(new) == identity
    assert auth.user_hash_for_passkey(old) is None
    assert auth.validate_session(session["token"]) is None

    # A second rotation works from the full hash too, and the first new key dies.
    newer = passkey_cli.rotate_passkey(identity)
    assert auth.user_hash_for_passkey(newer) == identity
    assert auth.user_hash_for_passkey(new) is None


def test_rotate_refuses_unknown_short_or_ambiguous(capsys):
    a = passkey_cli.create_passkey()
    b = passkey_cli.create_passkey()
    ha, hb = auth.user_hash_for_passkey(a), auth.user_hash_for_passkey(b)

    assert passkey_cli.rotate_passkey("0000000000000000deadbeef") is None
    assert passkey_cli.rotate_passkey(ha[:4]) is None
    # Common prefix of two live identities (only possible for short prefixes,
    # so simulate with the empty-ish case above and a direct ambiguity check).
    conn = passkey_cli.get_db_connection()
    try:
        assert passkey_cli._resolve_identity(conn.cursor(), "") is None
    finally:
        conn.close()
    # Both keys still work: nothing was rotated.
    assert auth.user_hash_for_passkey(a) == ha
    assert auth.user_hash_for_passkey(b) == hb
    out = capsys.readouterr().out
    assert "no active passkey" in out and "at least 8" in out


def test_rotated_row_never_verifies_by_legacy_sha(monkeypatch):
    """Even with argon2 unavailable at verify time, the old passkey must not
    sneak back in through the legacy SHA-256 path: rotation re-salts."""
    old = passkey_cli.create_passkey()
    identity = auth.user_hash_for_passkey(old)
    new = passkey_cli.rotate_passkey(identity)
    assert new
    monkeypatch.setattr(auth, "_hasher", None)
    assert auth.user_hash_for_passkey(old) is None
