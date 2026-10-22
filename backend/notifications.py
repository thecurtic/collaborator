"""Notifications: kinds, per-user settings, a stored log, and delivery.

UX doc, Notifications: none of this existed. Every kind is optional, listed
in settings so new kinds slot in later. Every notification is stored in the
per-user DB (the warm feed reads them later); delivery to the phone goes
through ntfy, a server the user runs themselves, and stays dormant until
notifications.ntfy is configured. Nothing leaves the box otherwise.

Stops the user caused (flipping the inference switch) never notify:
producers pass user_caused=True and the notification is dropped here, in
Collaborator, which is the thing that knows the user flipped it.
"""

import os
import sqlite3
import threading
from typing import Dict, List, Optional

import requests

from config import get_config

# The settings list, in display order. Adding a kind = one entry here.
KINDS: List[Dict] = [
    {"kind": "agent_stops", "label": "Agents need you",
     "description": "A question from an agent, or a message its backend flags "
                    "as needing you. It notifies once and clears when the "
                    "question closes. Trouble with an endpoint never notifies; "
                    "it shows as a badge on the project.",
     "default": True},
    {"kind": "transcript_ready", "label": "Transcript ready",
     "description": "A long video finished transcribing in the background, or "
                    "couldn't be transcribed.",
     "default": True},
]
_KIND_IDS = {k["kind"] for k in KINDS}


def _cfg() -> dict:
    return get_config().get("notifications", {}) or {}


def ensure_schema(conn) -> None:
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT,
            link TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            delivered TEXT
        )
    """)
    cols = {r[1] for r in cur.execute("PRAGMA table_info(notifications)")}
    if "sequence_id" not in cols:
        # ntfy's sequence id: a later clear() dismisses it on the phone.
        cur.execute("ALTER TABLE notifications ADD COLUMN sequence_id TEXT")
    if "cleared_at" not in cols:
        cur.execute("ALTER TABLE notifications ADD COLUMN cleared_at TEXT")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS notification_settings (
            kind TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL
        )
    """)
    conn.commit()


def get_settings(conn) -> List[Dict]:
    """The settings list: every kind with its current on/off."""
    ensure_schema(conn)
    stored = dict(conn.execute(
        "SELECT kind, enabled FROM notification_settings").fetchall())
    return [{**k, "enabled": bool(stored.get(k["kind"], k["default"]))}
            for k in KINDS]


def set_settings(conn, changes: Dict[str, bool]) -> List[Dict]:
    """Turn kinds on/off. Unknown kinds raise ValueError."""
    unknown = sorted(set(changes) - _KIND_IDS)
    if unknown:
        raise ValueError(f"unknown notification kind(s): {', '.join(unknown)}")
    ensure_schema(conn)
    conn.executemany(
        "INSERT INTO notification_settings (kind, enabled) VALUES (?, ?) "
        "ON CONFLICT(kind) DO UPDATE SET enabled = excluded.enabled",
        [(k, 1 if v else 0) for k, v in changes.items()])
    conn.commit()
    return get_settings(conn)


def list_notifications(conn, limit: int = 50) -> List[Dict]:
    ensure_schema(conn)
    rows = conn.execute(
        "SELECT id, kind, title, body, link, created_at, delivered "
        "FROM notifications ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    cols = ["id", "kind", "title", "body", "link", "created_at", "delivered"]
    return [dict(zip(cols, r)) for r in rows]


# --- Delivery: ntfy (self-hosted) ----------------------------------------------

def user_key_for_db(db_path: str) -> str:
    """Per-user config key: the identity hash under auth, else "default"
    (the same idiom as tools.nwc.connections)."""
    if (get_config().get("authentication", {}) or {}).get("enabled"):
        return os.path.basename(os.path.dirname(db_path))
    return "default"


def ntfy_topic_for(user_key: str) -> str:
    ncfg = _cfg().get("ntfy") or {}
    return str((ncfg.get("topics") or {}).get(user_key) or "").strip()


def delivery_status(db_path: str) -> Dict:
    """What the settings screen shows about delivery (never secrets)."""
    ncfg = _cfg().get("ntfy") or {}
    configured = bool((ncfg.get("url") or "").strip()
                      and ntfy_topic_for(user_key_for_db(db_path)))
    return {"ntfy": configured}


# The Android shell's own link scheme (MainActivity): a tap on a
# "collaborator://open/…" link opens the app, not the phone's browser.
APP_SCHEME = "collaborator://open"


def _click_url(link: Optional[str]) -> Optional[str]:
    """Where tapping the phone notification goes: the in-app link, in the
    Android app (open_in: app) or at app_url in the browser (the default)."""
    if not link:
        return None
    if str(_cfg().get("open_in") or "browser").lower() == "app":
        return f"{APP_SCHEME}/{link.lstrip('/')}"
    base = (_cfg().get("app_url") or "").strip().rstrip("/")
    if not base:
        return None
    return f"{base}/{link.lstrip('/')}"


def send_ntfy(user_key: str, title: str, body: str,
               link: Optional[str], sequence_id: Optional[str] = None) -> str:
    """POST to the user's ntfy topic. Returns a short delivery status."""
    ncfg = _cfg().get("ntfy") or {}
    url = (ncfg.get("url") or "").strip().rstrip("/")
    topic = ntfy_topic_for(user_key)
    if not url or not topic:
        return "not configured"
    # JSON publishing (POST to the server root): UTF-8 safe, unlike headers.
    payload = {"topic": topic, "title": title, "message": body or title}
    if sequence_id:
        payload["sequence_id"] = sequence_id
    click = _click_url(link)
    if click:
        payload["click"] = click
    headers = {}
    if ncfg.get("token"):
        headers["Authorization"] = f"Bearer {ncfg['token']}"
    try:
        r = requests.post(url, json=payload, headers=headers,
                          timeout=ncfg.get("timeout", 10))
        r.raise_for_status()
        return "ntfy"
    except Exception as e:
        # The URL stays out of the stored status; the log keeps the detail.
        print(f"Warning: ntfy delivery failed: {e}")
        return f"ntfy failed ({e.__class__.__name__})"


def notify(db_path: str, kind: str, title: str, body: str = "",
           link: Optional[str] = None, user_caused: bool = False,
           background: bool = True,
           sequence_id: Optional[str] = None) -> Optional[Dict]:
    """Record a notification and deliver it. Returns the stored row, or None
    when it was suppressed (kind off, or a stop the user caused).

    `link` is an in-app path like "?open=transcript:12"; with
    notifications.app_url set, tapping the phone notification opens it.
    Delivery runs on a daemon thread unless background=False (tests).
    `sequence_id` names it for ntfy, so clear() can dismiss it later.
    """
    if kind not in _KIND_IDS:
        raise ValueError(f"unknown notification kind: {kind}")
    if user_caused:
        return None
    conn = sqlite3.connect(db_path)
    try:
        enabled = {s["kind"]: s["enabled"] for s in get_settings(conn)}
        if not enabled.get(kind):
            return None
        cur = conn.execute(
            "INSERT INTO notifications (kind, title, body, link, sequence_id) "
            "VALUES (?, ?, ?, ?, ?)", (kind, title, body, link, sequence_id))
        conn.commit()
        nid = cur.lastrowid
    finally:
        conn.close()

    user_key = user_key_for_db(db_path)

    def _deliver():
        status = send_ntfy(user_key, title, body, link, sequence_id)
        c = sqlite3.connect(db_path)
        try:
            c.execute("UPDATE notifications SET delivered = ? WHERE id = ?",
                      (status, nid))
            c.commit()
        finally:
            c.close()

    if background:
        threading.Thread(target=_deliver, daemon=True,
                         name=f"notify-{nid}").start()
    else:
        _deliver()
    return get_notification(db_path, nid)


def get_notification(db_path: str, nid: int) -> Optional[Dict]:
    conn = sqlite3.connect(db_path)
    try:
        ensure_schema(conn)
        row = conn.execute(
            "SELECT id, kind, title, body, link, created_at, delivered "
            "FROM notifications WHERE id = ?", (nid,)).fetchone()
    finally:
        conn.close()
    cols = ["id", "kind", "title", "body", "link", "created_at", "delivered"]
    return dict(zip(cols, row)) if row else None


def clear(db_path: str, sequence_id: str, background: bool = True) -> None:
    """The thing a notification was about stopped waiting (a question closed
    or was answered): mark it cleared here and dismiss it on the phone
    (ntfy: PUT /<topic>/<sequence_id>/clear)."""
    conn = sqlite3.connect(db_path)
    try:
        ensure_schema(conn)
        cur = conn.execute(
            "UPDATE notifications SET cleared_at = datetime('now') "
            "WHERE sequence_id = ? AND cleared_at IS NULL", (sequence_id,))
        conn.commit()
        if not cur.rowcount:
            return
    finally:
        conn.close()
    user_key = user_key_for_db(db_path)

    def _clear():
        ncfg = _cfg().get("ntfy") or {}
        url = (ncfg.get("url") or "").strip().rstrip("/")
        topic = ntfy_topic_for(user_key)
        if not url or not topic:
            return
        headers = {}
        if ncfg.get("token"):
            headers["Authorization"] = f"Bearer {ncfg['token']}"
        try:
            requests.put(f"{url}/{topic}/{sequence_id}/clear", headers=headers,
                         timeout=ncfg.get("timeout", 10)).raise_for_status()
        except Exception as e:
            print(f"Warning: ntfy clear failed: {e}")

    if background:
        threading.Thread(target=_clear, daemon=True, name=f"notify-clear").start()
    else:
        _clear()
