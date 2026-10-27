"""Unified search: one search over my own world (UX doc, Search) — chats,
notes, Scratch, transcripts, attachments and agent conversations at once, grouped by pile. A
search bar inside a screen is the same search, scoped to that pile.

THIS IS THE USER'S SEARCH, NOT THE MODEL'S. It includes Scratch, which the
conversation agent must never reach, so nothing here may be wired into a
tool (main._build_tools) or into recall. test_unified_search.py checks that
line. Keyword matching only: fast, no model, nothing leaves the box.
"""

import re
import sqlite3
from typing import Dict, List, Optional

import agents
import attachments
import notes_index
from db import _parse_tags, get_root_id, list_scratch, search_keyword_turns, search_transcripts

SCOPES = ("chats", "notes", "scratch", "transcripts", "attachments", "agents")


def _terms(q: str) -> List[str]:
    return [t.lower() for t in re.split(r"\W+", q or "") if len(t) >= 2]


def _snippet(text: str, terms: List[str], width: int = 160) -> str:
    text = " ".join((text or "").split())
    low = text.lower()
    pos = min((low.find(t) for t in terms if low.find(t) >= 0), default=-1)
    if pos < 0:
        return text[:width] + ("…" if len(text) > width else "")
    start = max(0, pos - width // 3)
    end = min(len(text), start + width)
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")


def _chats(conn, q: str, limit: int) -> Dict:
    """One result per chat: its best-matching turn, how many turns matched.
    The chat's name and tags count as matches too."""
    terms = _terms(q)
    if not terms:
        return {"total": 0, "items": []}
    hits = search_keyword_turns(conn, q, limit=10_000)
    by_root: Dict[int, Dict] = {}
    for h in hits:
        root = h.get("branch_root_id") or get_root_id(conn, h["turn_id"])
        cur = by_root.setdefault(root, {"best": h, "count": 0, "last": h["created_at"]})
        cur["count"] += 1
        if (h["score"], h["turn_id"]) > (cur["best"]["score"], cur["best"]["turn_id"]):
            cur["best"] = h
        cur["last"] = max(cur["last"], h["created_at"] or "")
    # Names and chat tags (on the root).
    for rid, name, content, tags, created in conn.execute(
            "SELECT id, name, content, chat_tags, created_at FROM turns "
            "WHERE parent_turn_id IS NULL AND committed = 1").fetchall():
        words = set(_terms(f"{name or ''} {tags or ''}"))
        if any(t in words for t in terms) and rid not in by_root:
            by_root[rid] = {"best": {"turn_id": rid, "text": content, "score": 0.5},
                            "count": 0, "last": created}
    roots = {}
    if by_root:
        marks = ",".join("?" * len(by_root))
        for rid, name, content, tags in conn.execute(
                f"SELECT id, name, content, chat_tags FROM turns WHERE id IN ({marks})",
                list(by_root)).fetchall():
            roots[rid] = (name, content, tags)
    items = []
    for rid, r in by_root.items():
        name, first, tags = roots.get(rid, (None, "", None))
        tag_list = _parse_tags(tags)
        title = (name or "").strip() or " ".join((first or "").split())[:80] or f"Chat {rid}"
        items.append({"type": "chat", "id": rid, "turn_id": r["best"]["turn_id"],
                      "title": title, "snippet": _snippet(r["best"].get("text") or "", terms),
                      "tags": tag_list, "matches": r["count"], "when": r["last"],
                      "_score": r["best"]["score"]})
    items.sort(key=lambda i: (i["_score"], i["matches"], i["when"] or ""), reverse=True)
    for i in items:
        i.pop("_score")
    return {"total": len(items), "items": items[:limit]}


def _notes(conn, q: str, limit: int) -> Dict:
    terms = _terms(q)
    if not terms:
        return {"total": 0, "items": []}
    found = notes_index.search_notes_keyword(conn, q, limit=10_000)
    items = [{"type": "note", "id": n["title"], "title": n["title"],
              "snippet": _snippet(n.get("body") or "", terms), "tags": n.get("tags") or [],
              "when": n.get("event_start") or n.get("created")} for n in found]
    return {"total": len(items), "items": items[:limit]}


_KIND_TITLE = {"image": "Photo", "audio": "Voice note", "video": "Video",
               "file": "File", "url": "Link", "text": "Note"}


def _scratch(conn, q: str, limit: int) -> Dict:
    terms = _terms(q)
    if not terms:
        return {"total": 0, "items": []}
    rows = list_scratch(conn, limit=10_000, q=q)
    items = []
    for r in rows:
        text = r.get("content") or ""
        title = (r.get("preview_title") or r.get("media_name")
                 or " ".join(text.split())[:80] or _KIND_TITLE.get(r["kind"], "Note"))
        body = r.get("transcript") or text
        snippet = _snippet(body, terms)
        if snippet.strip("…") == title:
            snippet = ""                     # a short note: the title says it all
        items.append({"type": "scratch", "id": r["id"], "kind": r["kind"], "title": title,
                      "snippet": snippet, "when": r["created_at"],
                      "pinned": r.get("pinned", False)})
    return {"total": len(items), "items": items[:limit]}


def _transcripts(conn, q: str, limit: int) -> Dict:
    if not _terms(q):
        return {"total": 0, "items": []}
    found = search_transcripts(conn, query=q)
    items = [{"type": "transcript", "id": t["id"], "title": t.get("title") or t.get("url"),
              "snippet": t.get("snippet") or "", "channel": t.get("channel"),
              "tags": t.get("tags") or [], "when": t.get("created_at")} for t in found]
    return {"total": len(items), "items": items[:limit]}


def _attachments(conn, q: str, limit: int) -> Dict:
    if not _terms(q):
        return {"total": 0, "items": []}
    found = attachments.list_all(conn, q=q, limit=200)
    items = [{"type": "attachment", "id": a["id"], "title": a["filename"], "kind": a["kind"],
              "mime": a.get("mime"), "size": a.get("size"),
              "snippet": a.get("snippet") or "", "when": a.get("created_at")} for a in found]
    return {"total": len(items), "items": items[:limit]}


def _agents(conn, q: str, limit: int) -> Dict:
    """Stored agent conversations (the user's search only: channel content
    stays out of recall and the model's tools; the firehose is never stored)."""
    terms = _terms(q)
    if not terms:
        return {"total": 0, "items": []}
    found = agents.search_messages(conn, terms, limit=200)
    labels = {(e, p, c): l for e, p, c, l in conn.execute(
        "SELECT endpoint_id, project, channel, label FROM agent_channels")}
    items = [{"type": "agent", "id": m["id"], "project": m["project"],
              "endpoint_id": m["endpoint_id"], "channel_id": m["channel"],
              "title": labels.get((m["endpoint_id"], m["project"], m["channel"]), m["channel"]),
              "from": m["from"], "snippet": _snippet(m["text"], terms),
              "when": m["created_at"]} for m in found]
    return {"total": len(items), "items": items[:limit]}


_PILES = {"chats": _chats, "notes": _notes, "scratch": _scratch,
          "transcripts": _transcripts, "attachments": _attachments, "agents": _agents}


def search(db_path: str, q: str, scopes: Optional[List[str]] = None,
           limit: int = 5) -> Dict:
    """{q, groups: [{scope, total, items}]} in SCOPES order, empty piles
    left out. `limit` is per pile."""
    scopes = [s for s in SCOPES if not scopes or s in scopes]
    conn = sqlite3.connect(db_path)
    try:
        groups = []
        for scope in scopes:
            g = _PILES[scope](conn, q, limit)
            if g["total"]:
                groups.append({"scope": scope, **g})
    finally:
        conn.close()
    return {"q": q, "groups": groups}
