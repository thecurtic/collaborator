"""The warm feed (UX doc, Feed): one list ordered by warmth.

Warmth is dumb on purpose: an item's warmth is the later of "I last touched
it" and "it last changed". Nothing is scored; shape weight only breaks ties.
Pinned items sit on top regardless.

Item types and what "changed" means for each:
  chat        the newest turn in the tree; touched = opened
  note        the app's own record of a change (approval, edit, an Obsidian
              edit seen by reindex) — never file mtimes, which migrations and
              data moves rewrite wholesale; touched = opened
  event       an event note starting within the window; within a day of
              starting it counts as warm right now, every load, so close
              events stay near the top
  approval    a pending draft (its creation)
  transcript  a finished or failed transcription (its finish)
  merged      merged agent work — a supported type with no producer until the
              agent layer exists; producers call record_merged()

Activity (touched/changed) and pins live in the per-user DB; nothing here is
stored in the vault, so the notes-index invariant is untouched.
"""

import datetime as _dt
import sqlite3
from typing import Dict, List, Optional

# Tie-break order (higher wins at equal warmth): what needs me first.
SHAPE_WEIGHT = {"approval": 6, "event": 5, "merged": 4, "chat": 3,
                "transcript": 2, "note": 1}
EVENT_WINDOW_DAYS = 14
EVENT_WARMS_HOURS = 24
FEED_LIMIT = 50


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


def _iso(ts: Optional[_dt.datetime]) -> Optional[str]:
    """UTC ISO with microseconds, so two actions in the same second still
    order correctly."""
    return (ts.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
            if ts else None)


def _parse(value) -> Optional[_dt.datetime]:
    """SQLite UTC "YYYY-MM-DD HH:MM:SS", ISO with/without offset, or a date.
    Naive values are taken as UTC (SQLite) — except event starts, which the
    caller passes through _parse_local."""
    if not value:
        return None
    s = str(value).strip().replace(" ", "T").replace("Z", "+00:00")
    try:
        ts = _dt.datetime.fromisoformat(s)
    except ValueError:
        try:
            ts = _dt.datetime.fromisoformat(s[:10])
        except ValueError:
            return None
    return ts if ts.tzinfo else ts.replace(tzinfo=_dt.timezone.utc)


def _parse_local(value) -> Optional[_dt.datetime]:
    """Event wall-clock: naive values are in the server's local time."""
    if not value:
        return None
    s = str(value).strip()
    try:
        ts = _dt.datetime.fromisoformat(s if len(s) > 10 else s + "T00:00")
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.astimezone()


def ensure_schema(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS feed_activity (
            key TEXT PRIMARY KEY,
            touched_at TEXT,
            changed_at TEXT
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS feed_pins (
            key TEXT PRIMARY KEY,
            pinned_at TEXT NOT NULL
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS feed_merged (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            project TEXT,
            detail TEXT,
            merged_at TEXT NOT NULL
        )""")
    conn.commit()


def note_key(title: str) -> str:
    return f"note:{(title or '').strip().lower()}"


def _record(conn, key: str, column: str) -> None:
    ensure_schema(conn)
    conn.execute(
        f"INSERT INTO feed_activity (key, {column}) VALUES (?, ?) "
        f"ON CONFLICT(key) DO UPDATE SET {column} = excluded.{column}",
        (key, _iso(_now())))
    conn.commit()


def record_touch(conn, key: str) -> None:
    _record(conn, key, "touched_at")


def record_change(conn, key: str) -> None:
    _record(conn, key, "changed_at")


def forget(conn, key: str) -> None:
    """An item went away (deleted note, renamed title): drop its activity
    and pin so a later item reusing the key starts cold."""
    ensure_schema(conn)
    conn.execute("DELETE FROM feed_activity WHERE key = ?", (key,))
    conn.execute("DELETE FROM feed_pins WHERE key = ?", (key,))
    conn.commit()


def rename(conn, old_key: str, new_key: str) -> None:
    ensure_schema(conn)
    for table in ("feed_activity", "feed_pins"):
        conn.execute(f"DELETE FROM {table} WHERE key = ?", (new_key,))
        conn.execute(f"UPDATE {table} SET key = ? WHERE key = ?", (new_key, old_key))
    conn.commit()


def set_pin(conn, key: str, pinned: bool) -> None:
    ensure_schema(conn)
    if pinned:
        conn.execute("INSERT OR IGNORE INTO feed_pins (key, pinned_at) VALUES (?, ?)",
                     (key, _iso(_now())))
    else:
        conn.execute("DELETE FROM feed_pins WHERE key = ?", (key,))
    conn.commit()


def record_merged(conn, title: str, project: Optional[str] = None,
                  detail: Optional[str] = None) -> int:
    """Producer hook for the agent layer: a piece of work was merged."""
    ensure_schema(conn)
    cur = conn.execute(
        "INSERT INTO feed_merged (title, project, detail, merged_at) VALUES (?, ?, ?, ?)",
        (title, project, detail, _iso(_now())))
    conn.commit()
    return cur.lastrowid


def _activity(conn) -> Dict[str, tuple]:
    return {k: (_parse(t), _parse(c)) for k, t, c in conn.execute(
        "SELECT key, touched_at, changed_at FROM feed_activity").fetchall()}


def _later(*stamps) -> Optional[_dt.datetime]:
    present = [s for s in stamps if s]
    return max(present) if present else None


def _chat_items(conn, activity) -> List[Dict]:
    """One item per conversation root: changed = its newest committed turn."""
    import db as _db
    out = []
    for root in _db.get_turn_tree(conn):
        newest, count, stack = root, 0, [root]
        while stack:
            node = stack.pop()
            count += 1
            if node["id"] > newest["id"]:
                newest = node
            stack.extend(node.get("children") or [])
        key = f"chat:{root['id']}"
        touched, _ = activity.get(key, (None, None))
        changed = _parse(newest.get("created_at"))
        title = (root.get("name") or root.get("title")
                 or " ".join((root.get("content") or "").split())[:80] or "Untitled")
        last = " ".join((newest.get("content") or "").split())[:140]
        out.append({"key": key, "type": "chat", "title": title,
                    "subtitle": last, "warmth": _later(touched, changed),
                    "tags": root.get("chat_tags") or [],
                    "ref": {"root_id": root["id"], "leaf_id": newest["id"],
                            "state": root.get("state")}})
    return out


def _note_and_event_items(conn, activity, now) -> List[Dict]:
    import notes_index
    out = []
    horizon = now + _dt.timedelta(days=EVENT_WINDOW_DAYS)
    try:
        notes = notes_index.list_notes(conn)
    except sqlite3.OperationalError:
        return out                                  # no notes index yet
    for n in notes:
        key = note_key(n["title"])
        touched, changed = activity.get(key, (None, None))
        tags = [t.lower() for t in n.get("tags") or []]
        start = _parse_local(n.get("event_start")) if "event" in tags else None
        if start and now - _dt.timedelta(hours=6) <= start <= horizon:
            # Within a day of starting (or just started), an event is warm
            # NOW on every load, so close events stay near the top. A
            # deliberate bend of the touched/changed rule (2026-10-13).
            close = start - _dt.timedelta(hours=EVENT_WARMS_HOURS) <= now
            moved = now if close else None
            out.append({"key": key, "type": "event", "title": n["title"],
                        "subtitle": n.get("event_start"),
                        "warmth": _later(touched, changed, moved),
                        "tags": n.get("tags") or [],
                        "ref": {"title": n["title"], "start": n.get("event_start"),
                                "all_day": bool(n.get("event_all_day"))}})
            continue
        warmth = _later(touched, changed)
        if warmth is None:
            continue                                # never touched or changed in-app
        out.append({"key": key, "type": "note", "title": n["title"],
                    "subtitle": ", ".join(n.get("tags") or []), "warmth": warmth,
                    "tags": n.get("tags") or [], "ref": {"title": n["title"]}})
    return out


def _approval_items(conn) -> List[Dict]:
    import db as _db
    out = []
    for d in _db.list_note_drafts(conn, status="pending"):
        kind = d.get("kind") or "new"
        out.append({"key": f"approval:{d['id']}", "type": "approval",
                    "title": d["title"],
                    "subtitle": (f"Edit to {d.get('target_title')}" if kind == "edit"
                                 else "New note awaiting review"),
                    "warmth": _parse(d.get("created_at")), "tags": d.get("tags") or [],
                    "ref": {"draft_id": d["id"], "run_id": d.get("run_id")}})
    return out


def _transcript_items(conn, activity) -> List[Dict]:
    out = []
    try:
        rows = conn.execute(
            "SELECT id, title, channel, status, finished_at FROM transcripts "
            "WHERE status IN ('done', 'error') AND finished_at IS NOT NULL").fetchall()
    except sqlite3.OperationalError:
        return out
    for tid, title, channel, status, finished in rows:
        key = f"transcript:{tid}"
        touched, _ = activity.get(key, (None, None))
        out.append({"key": key, "type": "transcript", "title": title or "Transcript",
                    "subtitle": ("Transcription failed" if status == "error"
                                 else channel or "Transcript ready"),
                    "warmth": _later(touched, _parse(finished)), "tags": [],
                    "ref": {"transcript_id": tid, "status": status}})
    return out


def _merged_items(conn, activity) -> List[Dict]:
    out = []
    for mid, title, project, detail, merged_at in conn.execute(
            "SELECT id, title, project, detail, merged_at FROM feed_merged").fetchall():
        key = f"merged:{mid}"
        touched, _ = activity.get(key, (None, None))
        out.append({"key": key, "type": "merged", "title": title,
                    "subtitle": project or detail or "Merged",
                    "warmth": _later(touched, _parse(merged_at)),
                    "tags": [project] if project else [],
                    "ref": {"merged_id": mid, "project": project}})
    return out


def build_feed(conn, limit: int = FEED_LIMIT) -> Dict:
    """{pinned: [...], items: [...]}, each item {key, type, title, subtitle,
    warmth (ISO UTC), tags, ref, pinned}. Pinned items are pulled out on top
    (newest pin first) and never count against the limit."""
    ensure_schema(conn)
    now = _now()
    activity = _activity(conn)
    items = (_chat_items(conn, activity) + _note_and_event_items(conn, activity, now)
             + _approval_items(conn) + _transcript_items(conn, activity)
             + _merged_items(conn, activity))
    pins = dict(conn.execute("SELECT key, pinned_at FROM feed_pins").fetchall())
    epoch = _dt.datetime.min.replace(tzinfo=_dt.timezone.utc)
    items.sort(key=lambda i: (i["warmth"] or epoch, SHAPE_WEIGHT.get(i["type"], 0)),
               reverse=True)
    pinned, rest = [], []
    for item in items:
        item["pinned"] = item["key"] in pins
        (pinned if item["pinned"] else rest).append(item)
    pinned.sort(key=lambda i: pins[i["key"]], reverse=True)
    for item in pinned + rest:
        item["warmth"] = _iso(item["warmth"])
    return {"pinned": pinned, "items": rest[:limit]}
