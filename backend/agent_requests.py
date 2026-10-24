"""Signed requests to the team: create a project, merge a milestone, withdraw.

Design: the Claude Doc "Projects and merges from Collaborator" (approved r6,
its "Collaborator side" brief). Collaborator holds one Ed25519 private key and
signs a request only from a button the user presses: Create on the New project
form, Merge on a merge question that carries a proposal, Withdraw in the
Requests list. The PM's manager carries the signed envelope to the team repo;
the forge keeper verifies it and does the work. Collaborator never talks to
the keeper or the forge.

Boundaries this module keeps:
  - Signing is not a model tool. Nothing on the tool dispatch path imports
    this module (test_agent_requests checks), and the private key is a file
    outside everything the model can read (agents.request_signing_key_file),
    loaded only here.
  - The signature covers the body only, every field, the id included. Ids
    are spent once the keeper processes them, so a replay is refused there.

The wire formats (also in API-SPEC.md §26 and the shared test vector,
docs/request-signing-test-vector.json):
  canonical bytes  json.dumps(body, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=False).encode("utf-8"): RFC 8785 for bodies of
                   ASCII keys, strings, integers and lists of strings
  sig              standard base64 (padded) of the 64-byte Ed25519 signature
  public_key       "ed25519:" + standard base64 (padded) of the raw 32-byte key
  fingerprint      SHA-256 over the raw 32 bytes, first 16 hex, groups of four
  id               "r-" + a ULID (26 Crockford base32 characters)
  issued_at        UTC to the second: 2026-10-24T17:05:00Z
  key_id           "collab-YYYY-MM", with "-2", "-3"… when a replacement
                   lands in the same month
"""

import base64
import datetime as _dt
import hashlib
import json
import os
import re
import secrets
import time
from typing import Dict, List, Optional

from config import get_config, resolve_path

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}$")
ROLE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}$")
FINAL_STATES = ("done", "refused", "failed", "withdrawn")
STATES = ("sending", "accepted", "progress", "waiting") + FINAL_STATES
KINDS = ("create_project", "merge", "withdraw")
CAPABILITIES = ("create_project", "merge")
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


class SigningError(Exception):
    """No key yet, or the crypto library is missing: the request can't be signed."""


# --- Formats ----------------------------------------------------------------------

def canonical_bytes(body: Dict) -> bytes:
    return json.dumps(body, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def public_key_text(raw32: bytes) -> str:
    return "ed25519:" + base64.b64encode(raw32).decode("ascii")


def key_fingerprint(raw32: bytes) -> str:
    h = hashlib.sha256(raw32).hexdigest()[:16]
    return "-".join(h[i:i + 4] for i in range(0, 16, 4))


def new_id(now_ms: Optional[int] = None) -> str:
    """"r-" + a ULID: 48 bits of milliseconds, 80 random bits, Crockford base32."""
    n = ((now_ms if now_ms is not None else int(time.time() * 1000)) << 80) \
        | secrets.randbits(80)
    chars = []
    for _ in range(26):
        chars.append(_CROCKFORD[n & 31])
        n >>= 5
    return "r-" + "".join(reversed(chars))


def issued_at_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _ed25519():
    try:
        from cryptography.hazmat.primitives.asymmetric import ed25519
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        raise SigningError("signing needs the cryptography package "
                           "(pip install cryptography)")
    return ed25519, serialization


def _raw_public(private_key) -> bytes:
    _, serialization = _ed25519()
    return private_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def sign_body(body: Dict, seed: bytes, key_id: str) -> Dict:
    """The envelope for a body: {body, key_id, sig}. `seed` is the raw
    32-byte private key."""
    ed25519, _ = _ed25519()
    priv = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
    sig = priv.sign(canonical_bytes(body))
    return {"body": body, "key_id": key_id, "sig": base64.b64encode(sig).decode("ascii")}


def verify_envelope(envelope: Dict, public_key: str) -> bool:
    """What the keeper does, for tests and the fake endpoint."""
    ed25519, _ = _ed25519()
    if not public_key.startswith("ed25519:"):
        return False
    try:
        pub = ed25519.Ed25519PublicKey.from_public_bytes(
            base64.b64decode(public_key[len("ed25519:"):], validate=True))
        pub.verify(base64.b64decode(envelope["sig"], validate=True),
                   canonical_bytes(envelope["body"]))
        return True
    except Exception:
        return False


# --- The key file -----------------------------------------------------------------

def key_path() -> str:
    cfg = get_config().get("agents", {}) or {}
    return resolve_path(cfg.get("request_signing_key_file")
                        or "backend/data/keys/request-signing.key")


def _load() -> Optional[Dict]:
    try:
        with open(key_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        seed = base64.b64decode(d["private_key"], validate=True)
        if len(seed) != 32 or not d.get("key_id"):
            return None
        return {"key_id": d["key_id"], "seed": seed}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def signing_key() -> Optional[Dict]:
    """{key_id, public_key, fingerprint}, or None before one is made."""
    k = _load()
    if k is None:
        return None
    ed25519, _ = _ed25519()
    raw = _raw_public(ed25519.Ed25519PrivateKey.from_private_bytes(k["seed"]))
    return {"key_id": k["key_id"], "public_key": public_key_text(raw),
            "fingerprint": key_fingerprint(raw)}


def create_key(replace: bool = False) -> Dict:
    """Generate the pair once. Replacing makes a new pair with a new key_id
    and discards the old private key (the keeper keeps the old public key
    for requests already signed)."""
    old = _load()
    if old and not replace:
        raise FileExistsError("a signing key already exists")
    ed25519, serialization = _ed25519()
    priv = ed25519.Ed25519PrivateKey.generate()
    seed = priv.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                              serialization.NoEncryption())
    base_id = "collab-" + _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m")
    key_id = base_id
    if old and old["key_id"].startswith(base_id):
        key_id = f"{base_id}-{_suffix(old['key_id'], base_id) + 1}"
    path = key_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"key_id": key_id, "private_key": base64.b64encode(seed).decode("ascii"),
                   "created_at": _now_iso()}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return signing_key()


def _suffix(key_id: str, base_id: str) -> int:
    rest = key_id[len(base_id):]
    return int(rest[1:]) if rest.startswith("-") and rest[1:].isdigit() else 1


def sign(body: Dict) -> Dict:
    k = _load()
    if k is None:
        raise SigningError("create the request signing key first (Settings → Agents)")
    return sign_body(body, k["seed"], k["key_id"])


# --- Bodies -----------------------------------------------------------------------

def _plain(value) -> bool:
    """Bodies hold only strings, integers and lists of strings."""
    if isinstance(value, bool):
        return False
    if isinstance(value, (str, int)):
        return True
    return isinstance(value, list) and all(isinstance(x, str) for x in value)


def _stamp(body: Dict) -> Dict:
    body["id"] = new_id()
    body["issued_at"] = issued_at_now()
    return body


def create_body(name: str, description: str, intents_md: str,
                roles: Optional[List[str]] = None,
                kickoff: Optional[str] = None) -> Dict:
    name = (name or "").strip()
    if not NAME_RE.match(name):
        raise ValueError("the name is 2–39 characters: lowercase letters, digits and "
                         "hyphens, starting with a letter or digit")
    description = " ".join((description or "").split())
    if not description:
        raise ValueError("a one-line description is needed")
    if len(description) > 300:
        raise ValueError("keep the description to one line (300 characters)")
    if not (intents_md or "").strip():
        raise ValueError("the intents are needed (type them or pick a note)")
    body = {"v": 1, "kind": "create_project", "name": name, "description": description,
            "intents_md": intents_md}
    roles = [r.strip() for r in roles or [] if r and r.strip()]
    if roles:
        bad = [r for r in roles if not ROLE_RE.match(r)]
        if bad:
            raise ValueError(f"role names are lowercase letters, digits and hyphens: {', '.join(bad)}")
        body["roles"] = list(dict.fromkeys(roles))
    if kickoff and kickoff.strip():
        body["kickoff"] = kickoff
    return _stamp(body)


def withdraw_body(target: str) -> Dict:
    return _stamp({"v": 1, "kind": "withdraw", "target": target})


def merge_body(proposal_body: Dict) -> Dict:
    """Exactly the body fields the proposal carried, plus our id and
    issued_at: nothing else added or removed."""
    body = dict(proposal_body)
    return _stamp(body)


def normalize_proposal(raw, option_ids: List[str]) -> Optional[Dict]:
    """A merge question's proposal, or None when it isn't one we can sign."""
    if not isinstance(raw, dict):
        return None
    body, approve = raw.get("body"), raw.get("approve_option")
    if not isinstance(body, dict) or approve not in option_ids:
        return None
    if body.get("v") != 1 or body.get("kind") != "merge" or not body.get("project"):
        return None
    if not all(isinstance(k, str) and k.isascii() and _plain(v) for k, v in body.items()):
        return None
    body = {k: v for k, v in body.items() if k not in ("id", "issued_at")}
    out = {"approve_option": approve, "body": body}
    if isinstance(raw.get("summary"), str):
        out["summary"] = raw["summary"][:500]
    if isinstance(raw.get("commits"), int) and not isinstance(raw.get("commits"), bool):
        out["commits"] = raw["commits"]
    return out


# --- The store (per user) ---------------------------------------------------------

def ensure_schema(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agent_requests (
            id TEXT PRIMARY KEY,
            endpoint_id TEXT,
            kind TEXT NOT NULL,
            project TEXT,
            target TEXT,                      -- withdraw: the request it names
            envelope TEXT,                    -- JSON; NULL for one we only heard of
            state TEXT NOT NULL DEFAULT 'sending',
            step TEXT,
            text TEXT,
            message_id INTEGER,               -- merge: the question it answered
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            status_at TEXT,                   -- the first request_status: stop resending
            notified TEXT NOT NULL DEFAULT '',  -- states already notified (once each)
            hidden INTEGER NOT NULL DEFAULT 0
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agent_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agent_capabilities (
            endpoint_id TEXT PRIMARY KEY,
            capabilities TEXT NOT NULL DEFAULT '[]',
            warned INTEGER NOT NULL DEFAULT 0
        )""")
    conn.commit()


_COLS = ["id", "endpoint_id", "kind", "project", "target", "envelope", "state", "step",
         "text", "message_id", "created_at", "updated_at", "status_at", "notified", "hidden"]


def _row(r) -> Dict:
    d = dict(zip(_COLS, r))
    d["envelope"] = json.loads(d["envelope"]) if d["envelope"] else None
    d["hidden"] = bool(d["hidden"])
    return d


def public(r: Dict) -> Dict:
    return {k: r[k] for k in ("id", "kind", "project", "target", "state", "step", "text",
                              "message_id", "created_at", "updated_at", "hidden")}


def get(conn, rid: str) -> Optional[Dict]:
    ensure_schema(conn)
    r = conn.execute(f"SELECT {', '.join(_COLS)} FROM agent_requests WHERE id = ?",
                     (rid,)).fetchone()
    return _row(r) if r else None


def list_all(conn) -> List[Dict]:
    """Open ones first, then the newest."""
    ensure_schema(conn)
    rows = [_row(r) for r in conn.execute(
        f"SELECT {', '.join(_COLS)} FROM agent_requests ORDER BY created_at DESC")]
    rows.sort(key=lambda r: r["state"] in FINAL_STATES)
    return [public(r) for r in rows]


def by_message(conn, message_ids: List[int]) -> Dict[int, Dict]:
    ensure_schema(conn)
    if not message_ids:
        return {}
    q = ",".join("?" * len(message_ids))
    out = {}
    for r in conn.execute(f"SELECT {', '.join(_COLS)} FROM agent_requests "
                          f"WHERE message_id IN ({q}) ORDER BY created_at", message_ids):
        d = _row(r)
        out[d["message_id"]] = public(d)
    return out


def store(conn, envelope: Dict, endpoint_id: str, message_id: Optional[int] = None) -> Dict:
    ensure_schema(conn)
    b = envelope["body"]
    now = _now_iso()
    conn.execute(
        "INSERT INTO agent_requests (id, endpoint_id, kind, project, target, envelope, "
        "state, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?)",
        (b["id"], endpoint_id, b["kind"], b.get("project") or b.get("name"), b.get("target"),
         json.dumps(envelope), message_id, now, now))
    conn.commit()
    return get(conn, b["id"])


def unsent(conn, endpoint_id: str) -> List[Dict]:
    """Envelopes to resend on welcome: no request_status has come back yet."""
    ensure_schema(conn)
    return [_row(r) for r in conn.execute(
        f"SELECT {', '.join(_COLS)} FROM agent_requests WHERE endpoint_id = ? AND "
        "envelope IS NOT NULL AND status_at IS NULL ORDER BY created_at", (endpoint_id,))]


def apply_status(conn, f: Dict, endpoint_id: str) -> Optional[Dict]:
    """Upsert from a request_status frame (an unknown id is a new row).
    Returns {request, notify: bool} or None for a frame without an id."""
    ensure_schema(conn)
    rid = str(f.get("id") or "").strip()[:100]
    if not rid:
        return None
    state = f.get("state") if f.get("state") in STATES[1:] else "progress"
    now = _now_iso()
    step = str(f.get("step") or "")[:100] or None
    text = str(f.get("text") or "")[:2000]
    updated = str(f.get("updated_at") or "")[:40] or now
    cur = get(conn, rid)
    if cur is None:
        kind = f.get("kind") if f.get("kind") in KINDS else "create_project"
        conn.execute(
            "INSERT INTO agent_requests (id, endpoint_id, kind, project, target, state, step, "
            "text, created_at, updated_at, status_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (rid, endpoint_id, kind, str(f.get("project") or "")[:100] or None,
             str(f.get("target") or "")[:100] or None, state, step, text, updated, updated, now))
    else:
        conn.execute(
            "UPDATE agent_requests SET state = ?, step = ?, text = ?, updated_at = ?, "
            "status_at = COALESCE(status_at, ?), project = COALESCE(project, ?) WHERE id = ?",
            (state, step, text, updated, now, str(f.get("project") or "")[:100] or None, rid))
    conn.commit()
    r = get(conn, rid)
    # refused, failed and a creation's done notify once; the rest land quietly.
    notify = (state in ("refused", "failed") or (state == "done" and r["kind"] == "create_project")) \
        and state not in r["notified"].split(",")
    if notify:
        conn.execute("UPDATE agent_requests SET notified = ? WHERE id = ?",
                     (",".join(filter(None, [r["notified"], state])), rid))
        conn.commit()
    return {"request": r, "notify": notify}


def hide(conn, rid: str) -> Dict:
    r = get(conn, rid)
    if r is None:
        raise KeyError("no such request")
    if r["state"] not in FINAL_STATES:
        raise ValueError("only a finished request can be hidden")
    conn.execute("UPDATE agent_requests SET hidden = 1 WHERE id = ?", (rid,))
    conn.commit()
    return public(get(conn, rid))


def withdrawable(conn, target: str) -> Dict:
    r = get(conn, target)
    if r is None:
        raise KeyError("no such request")
    if r["kind"] == "withdraw":
        raise ValueError("a withdrawal can't itself be withdrawn")
    if r["state"] in FINAL_STATES:
        raise ValueError("that request has already finished")
    return r


# --- The PM mark and declared capabilities (per user) -----------------------------

def pm_endpoint(conn) -> Optional[str]:
    ensure_schema(conn)
    row = conn.execute("SELECT value FROM agent_settings WHERE key = 'pm_endpoint'").fetchone()
    return row[0] if row and row[0] else None


def set_pm_endpoint(conn, endpoint_id: Optional[str]) -> None:
    ensure_schema(conn)
    conn.execute("INSERT INTO agent_settings (key, value) VALUES ('pm_endpoint', ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (endpoint_id,))
    if endpoint_id:
        conn.execute("UPDATE agent_capabilities SET warned = 0 WHERE endpoint_id = ?",
                     (endpoint_id,))
    conn.commit()


def capabilities(conn, endpoint_id: str) -> List[str]:
    ensure_schema(conn)
    row = conn.execute("SELECT capabilities FROM agent_capabilities WHERE endpoint_id = ?",
                       (endpoint_id,)).fetchone()
    return json.loads(row[0]) if row else []


def set_capabilities(conn, endpoint_id: str, caps) -> bool:
    """Store what discovery declared. True when a non-PM endpoint declares
    any and hasn't been warned about yet: the caller raises the notice."""
    ensure_schema(conn)
    caps = sorted({c for c in (caps or []) if isinstance(c, str) and c in CAPABILITIES})
    row = conn.execute("SELECT warned FROM agent_capabilities WHERE endpoint_id = ?",
                       (endpoint_id,)).fetchone()
    conn.execute("INSERT INTO agent_capabilities (endpoint_id, capabilities) VALUES (?, ?) "
                 "ON CONFLICT(endpoint_id) DO UPDATE SET capabilities = excluded.capabilities",
                 (endpoint_id, json.dumps(caps)))
    conn.commit()
    return bool(caps) and pm_endpoint(conn) != endpoint_id and not (row and row[0])


def mark_warned(conn, endpoint_id: str) -> bool:
    """Once per endpoint until it's marked as the PM. True if newly marked."""
    ensure_schema(conn)
    conn.execute("INSERT OR IGNORE INTO agent_capabilities (endpoint_id) VALUES (?)",
                 (endpoint_id,))
    cur = conn.execute("UPDATE agent_capabilities SET warned = 1 WHERE endpoint_id = ? "
                       "AND warned = 0", (endpoint_id,))
    conn.commit()
    return cur.rowcount == 1
