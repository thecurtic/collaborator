"""Live updates between a user's devices (GET /api/live, server-sent events).

When something of a user's changes, every app they have open hears which
area changed ("chats", "notes", ...) and reloads what it shows of it. The
message says nothing more: the data itself still comes over the normal API,
so a missed message costs nothing but freshness, and a client that
reconnects after a gap (a phone that slept) simply reloads everything.

Who publishes:
  - the session middleware, after every successful write request (areas
    from the path, `areas_for`), tagged with the writing client's id so
    that client can skip its own echo;
  - work that changes data with no request behind it: a reply saved at the
    end of its stream, a generated title, branch summaries, a transcription
    job, a link preview.

Users are keyed by their conversation DB path. Publishing is thread-safe
(background jobs run in threads); delivery happens on the server's loop.
"""

import asyncio
import os
import threading
from typing import Dict, Iterable, List, Optional, Set

_lock = threading.Lock()
_subscribers: Dict[str, Set[asyncio.Queue]] = {}
_loop: Optional[asyncio.AbstractEventLoop] = None

# Path prefixes → areas, first match wins. Paths not listed publish nothing
# (auth, tickets, TTS, previews of a decode, settings tests, ...).
_AREAS = [
    ("/api/messages", ["chats"]),
    ("/api/branches", ["chats"]),
    ("/api/turns", ["chats"]),
    ("/api/chats", ["chats"]),
    ("/api/notes/drafts", ["drafts"]),
    ("/api/notes/synthesize", ["drafts"]),
    ("/api/notes", ["notes"]),
    ("/api/events", ["notes"]),
    ("/api/scratch", ["scratch"]),
    ("/api/spending", ["spending"]),
    ("/api/transcripts", ["transcripts"]),
    ("/api/transcribe", ["transcripts"]),
    ("/api/projects", ["projects"]),
    ("/api/feed/pin", ["feed"]),
    ("/api/wallet/send", ["wallet"]),
    ("/api/wallet/receive", ["wallet"]),
]


def areas_for(path: str) -> List[str]:
    for prefix, areas in _AREAS:
        if path == prefix or path.startswith(prefix + "/"):
            return areas
    return []


def _key(db_path: str) -> str:
    return os.path.realpath(db_path)


def subscribe(db_path: str) -> asyncio.Queue:
    """A queue of this user's changes. Call on the server's loop."""
    global _loop
    _loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    with _lock:
        _subscribers.setdefault(_key(db_path), set()).add(q)
    return q


def unsubscribe(db_path: str, q: asyncio.Queue) -> None:
    with _lock:
        subs = _subscribers.get(_key(db_path))
        if subs:
            subs.discard(q)
            if not subs:
                _subscribers.pop(_key(db_path), None)


def _deliver(queues: List[asyncio.Queue], msg: Dict) -> None:
    for q in queues:
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass  # a stalled client resyncs when it reconnects


def publish(db_path: Optional[str], areas: Iterable[str],
            origin: Optional[str] = None) -> None:
    """Tell this user's open apps that `areas` changed. Safe from any thread."""
    areas = sorted(set(areas))
    if areas:
        _send(db_path, {"areas": areas}, origin)


def _send(db_path: Optional[str], msg: Dict, origin: Optional[str]) -> None:
    if not db_path:
        return
    with _lock:
        queues = list(_subscribers.get(_key(db_path), ()))
    loop = _loop
    if not queues or loop is None or loop.is_closed():
        return
    if origin:
        msg = {**msg, "origin": origin}
    try:
        loop.call_soon_threadsafe(_deliver, queues, msg)
    except RuntimeError:
        pass  # loop shutting down


def publish_reply(db_path: Optional[str], reply: Dict,
                  origin: Optional[str] = None) -> None:
    """A reply in progress, for the user's other devices: {id, parent,
    paragraph, user, text, done}. Unlike area changes this carries content,
    so a device with that chat open can show the reply as it arrives."""
    _send(db_path, {"areas": ["reply"], "reply": reply}, origin)


def publish_conn(conn, areas: Iterable[str]) -> None:
    """publish() for code that holds a SQLite connection, not a path."""
    try:
        row = conn.execute("PRAGMA database_list").fetchone()
    except Exception:
        return
    if row and row[2]:
        publish(row[2], areas)
