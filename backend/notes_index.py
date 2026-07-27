"""Index over the notes vault: parse, reconcile, search.

Files are the source of truth; this index is a pure, REBUILDABLE cache.

INVARIANT (Nostr foresight): everything graph-relevant — titles (the `# H1`),
[[wikilink]] edges (in the body), and tags (frontmatter, which a future converter
maps to kind-1 event `t` tags) — is derived from note content alone and never
stored index-only. Dropping this index and rebuilding from files must always yield
the identical graph; the same property is what lets notes round-trip through Nostr
relays and remain reconstructable. Do not add graph state that lives only here.
"""

import hashlib
import json
import os
import re

import yaml

# [[Target]], [[Target|alias]], [[Target#heading]] -> "Target"
WIKILINK_RE = re.compile(r"\[\[([^\[\]]+?)\]\]")

NOTES_INDEX_COLUMNS = [
    "filename", "title", "created", "tags", "source_turns", "links",
    "body", "content_hash", "mtime",
    "event_start", "event_end", "event_all_day",
]
_COLS = ", ".join(NOTES_INDEX_COLUMNS)


def extract_wikilinks(body: str):
    """Return link target titles from [[wikilinks]] (alias/heading parts stripped)."""
    targets = []
    for match in WIKILINK_RE.finditer(body or ""):
        target = match.group(1).split("|")[0].split("#")[0].strip()
        if target and target not in targets:
            targets.append(target)
    return targets


def _norm_when(value):
    """Frontmatter start/end -> normalized ISO string (YAML may hand us date or
    datetime objects). Timed: YYYY-MM-DDTHH:MM[±HH:MM]; all-day: YYYY-MM-DD."""
    import datetime as _dt
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        s = value.strftime("%Y-%m-%dT%H:%M")
        if value.utcoffset() is not None:
            off = value.strftime("%z")
            s += f"{off[:3]}:{off[3:]}"
        return s
    if isinstance(value, _dt.date):
        return value.isoformat()
    s = str(value).strip()
    return s or None


def parse_note_file(path: str) -> dict:
    """Parse one vault note: frontmatter + H1 title + body prose + link edges."""
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()

    front, body = {}, raw
    if raw.startswith("---"):
        end = raw.find("\n---", 3)
        if end != -1:
            try:
                front = yaml.safe_load(raw[4:end]) or {}
                if not isinstance(front, dict):
                    front = {}
            except yaml.YAMLError:
                front = {}
            body = raw[end + 4:]

    body = body.strip()
    lines = body.splitlines()
    title = None
    if lines and lines[0].startswith("# "):
        title = lines[0][2:].strip()
        body = "\n".join(lines[1:]).strip()
    if not title:  # fall back to the filename (identity and H1 should agree)
        title = os.path.splitext(os.path.basename(path))[0]

    tags = front.get("tags") or []
    if not isinstance(tags, list):
        tags = [t.strip() for t in str(tags).split(",") if t.strip()]
    source_turns = front.get("source_turns") or []
    if not isinstance(source_turns, list):
        source_turns = []

    event_start = _norm_when(front.get("start"))
    event_end = _norm_when(front.get("end"))
    # Date-only start implies all-day even without the explicit flag.
    event_all_day = bool(event_start) and (bool(front.get("all_day"))
                                           or len(event_start) == 10)

    return {
        "filename": os.path.basename(path),
        "title": title,
        "created": str(front.get("created")) if front.get("created") is not None else None,
        "tags": [str(t) for t in tags],
        "source_turns": [int(i) for i in source_turns if isinstance(i, (int, float))],
        "links": extract_wikilinks(body),
        "body": body,
        "content_hash": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        "mtime": os.path.getmtime(path),
        "event_start": event_start,
        "event_end": event_end,
        "event_all_day": event_all_day,
        # Full frontmatter dict (incl. unknown keys) — NOT indexed; used by editing
        # so tooling preserves keys it doesn't understand (NOTES-FORMAT.md rule).
        "front": front,
    }


def compose_note_file(front: dict, title: str, body: str) -> str:
    """Render a note file: YAML frontmatter (all keys preserved) + H1 + body."""
    lines = (body or "").strip().splitlines()
    if lines and lines[0].strip().startswith("# "):
        lines = lines[1:]  # never double the H1
    clean_body = "\n".join(lines).strip()

    parts = []
    if front:
        parts += ["---", yaml.safe_dump(front, default_flow_style=None,
                                        sort_keys=False, allow_unicode=True).strip(), "---", ""]
    parts += [f"# {title}", "", clean_body]
    return "\n".join(parts) + "\n"


def rewrite_wikilinks(content: str, old_title: str, new_title: str) -> str:
    """Rewrite [[Old]] / [[Old|alias]] / [[Old#heading]] references to a new title."""
    pattern = re.compile(r"\[\[\s*" + re.escape(old_title) + r"\s*(?=[\]|#])",
                         re.IGNORECASE)
    return pattern.sub("[[" + new_title, content)


def _row_to_note(row) -> dict:
    d = dict(zip(NOTES_INDEX_COLUMNS, row))
    for key in ("tags", "source_turns", "links"):
        try:
            d[key] = json.loads(d[key]) if d[key] else []
        except Exception:
            d[key] = []
    d["event_all_day"] = bool(d.get("event_all_day"))
    return d


def _upsert(conn, note: dict, embedding=None) -> None:
    conn.cursor().execute(
        """
        INSERT INTO notes_index
            (filename, title, created, tags, source_turns, links, body,
             content_hash, mtime, event_start, event_end, event_all_day, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(filename) DO UPDATE SET
            title = excluded.title, created = excluded.created,
            tags = excluded.tags, source_turns = excluded.source_turns,
            links = excluded.links, body = excluded.body,
            content_hash = excluded.content_hash, mtime = excluded.mtime,
            event_start = excluded.event_start, event_end = excluded.event_end,
            event_all_day = excluded.event_all_day,
            embedding = COALESCE(excluded.embedding, notes_index.embedding)
        """,
        (note["filename"], note["title"], note["created"],
         json.dumps(note["tags"]), json.dumps(note["source_turns"]),
         json.dumps(note["links"]), note["body"],
         note["content_hash"], note["mtime"],
         note.get("event_start"), note.get("event_end"),
         1 if note.get("event_all_day") else 0, embedding),
    )
    conn.commit()


def _embed_blob(vector):
    if not vector:
        return None
    import numpy as np
    return np.asarray(vector, dtype="float32").tobytes()


def index_note_file(conn, path: str, embed_fn=None) -> dict:
    """Parse + upsert a single note file (used right after approval). Best-effort
    embedding via embed_fn(texts)->vectors."""
    note = parse_note_file(path)
    blob = None
    if embed_fn is not None:
        try:
            vecs = embed_fn([f"{note['title']}\n{note['body']}"])
            blob = _embed_blob(vecs[0] if vecs else None)
        except Exception:
            blob = None
    _upsert(conn, note, embedding=blob)
    return note


def reindex_vault(conn, vault_dir: str, embed_fn=None) -> dict:
    """Reconcile the index against the vault directory (files win, always).

    New/changed files (by content hash) are re-parsed and re-embedded; rows whose
    files vanished are removed. Returns {"added", "updated", "removed", "total"}.
    """
    cursor = conn.cursor()
    on_disk = {}
    if os.path.isdir(vault_dir):
        for name in os.listdir(vault_dir):
            if name.endswith(".md") and not name.startswith("."):
                on_disk[name] = os.path.join(vault_dir, name)

    existing = dict(cursor.execute(
        "SELECT filename, content_hash FROM notes_index").fetchall())

    added, updated, changed = 0, 0, []
    for name, path in on_disk.items():
        note = parse_note_file(path)
        if name not in existing:
            added += 1
            changed.append(note)
        elif existing[name] != note["content_hash"]:
            updated += 1
            changed.append(note)

    # Embed changed notes in batches (one model call per chunk).
    embeddings = {}
    if embed_fn is not None and changed:
        CHUNK = 64
        for start in range(0, len(changed), CHUNK):
            chunk = changed[start:start + CHUNK]
            try:
                vecs = embed_fn([f"{n['title']}\n{n['body']}" for n in chunk])
            except Exception:
                vecs = [None] * len(chunk)
            for note, vec in zip(chunk, vecs):
                embeddings[note["filename"]] = _embed_blob(vec)

    for note in changed:
        _upsert(conn, note, embedding=embeddings.get(note["filename"]))

    removed = 0
    for name in set(existing) - set(on_disk):
        cursor.execute("DELETE FROM notes_index WHERE filename = ?", (name,))
        removed += 1
    conn.commit()

    total = cursor.execute("SELECT COUNT(*) FROM notes_index").fetchone()[0]
    return {"added": added, "updated": updated, "removed": removed, "total": total}


def list_notes(conn, tag: str = None):
    """All indexed notes (metadata only, no body/embedding)."""
    rows = conn.cursor().execute(
        f"SELECT {_COLS} FROM notes_index ORDER BY filename ASC").fetchall()
    notes = [_row_to_note(r) for r in rows]
    for n in notes:
        n.pop("body", None)
    if tag:
        wanted = tag.lower()
        notes = [n for n in notes if wanted in [t.lower() for t in n["tags"]]]
    return notes


def get_note_by_title(conn, title: str):
    """Fetch one note (with body) by title, case-insensitive."""
    row = conn.cursor().execute(
        f"SELECT {_COLS} FROM notes_index WHERE lower(title) = lower(?)", (title,)
    ).fetchone()
    return _row_to_note(row) if row else None


def get_backlinks(conn, title: str):
    """Notes whose bodies link to `title` (edges derived from content, inverted)."""
    wanted = title.lower()
    result = []
    for row in conn.cursor().execute(f"SELECT {_COLS} FROM notes_index").fetchall():
        note = _row_to_note(row)
        if wanted in [l.lower() for l in note["links"]]:
            note.pop("body", None)
            result.append(note)
    return result


def _note_has_tag(note: dict, tag: str) -> bool:
    return tag.lower() in [t.lower() for t in note.get("tags") or []]


def search_notes_semantic(conn, query_vector, limit: int = 10, tag: str = None):
    """Cosine similarity over indexed note embeddings. Optional tag filter."""
    if not query_vector:
        return []
    import numpy as np
    q = np.asarray(query_vector, dtype="float32")
    q_norm = np.linalg.norm(q)
    if q_norm == 0:
        return []
    scored = []
    for row in conn.cursor().execute(
            f"SELECT {_COLS}, embedding FROM notes_index").fetchall():
        blob = row[-1]
        if not blob:
            continue
        vec = np.frombuffer(blob, dtype="float32")
        if vec.shape != q.shape:
            continue
        denom = q_norm * np.linalg.norm(vec)
        if denom == 0:
            continue
        note = _row_to_note(row[:-1])
        if tag and not _note_has_tag(note, tag):
            continue
        note["score"] = float(np.dot(q, vec) / denom)
        scored.append(note)
    scored.sort(key=lambda n: n["score"], reverse=True)
    return scored[:limit]


def list_events(conn, window_start: str = None, window_end: str = None):
    """Notes tagged 'event' with a start, optionally within an inclusive window.

    window_start/window_end are ISO dates (YYYY-MM-DD) or datetimes; an event
    overlaps the window if any part of its [start, end-or-start] span does.
    Comparison is on local wall-clock strings (offsets ignored) — fine for a
    single-user, single-timezone corpus. Sorted by start.
    """
    events = []
    for row in conn.cursor().execute(f"SELECT {_COLS} FROM notes_index").fetchall():
        note = _row_to_note(row)
        if not note.get("event_start") or not _note_has_tag(note, "event"):
            continue
        start = note["event_start"]
        end = note.get("event_end") or start
        s_cmp = start[:16] if len(start) > 10 else start + "T00:00"
        e_cmp = end[:16] if len(end) > 10 else end + "T23:59"
        if window_start:
            ws = window_start[:16] if len(window_start) > 10 else window_start + "T00:00"
            if e_cmp < ws:
                continue
        if window_end:
            we = window_end[:16] if len(window_end) > 10 else window_end + "T23:59"
            if s_cmp > we:
                continue
        events.append(note)
    events.sort(key=lambda n: (n["event_start"], n["title"]))
    return events


def search_notes_keyword(conn, query: str, limit: int = 10, tag: str = None):
    """Lexical search over title/body/tags by term overlap. Optional tag filter.

    With a tag and NO query terms, returns every note carrying the tag (the
    "totality of notes tagged X" retrieval — e.g. the full user profile).
    """
    terms = [t.lower() for t in re.split(r"\W+", query or "") if len(t) >= 2]
    if not terms and not tag:
        return []
    scored = []
    for row in conn.cursor().execute(f"SELECT {_COLS} FROM notes_index").fetchall():
        note = _row_to_note(row)
        if tag and not _note_has_tag(note, tag):
            continue
        if not terms:
            note["score"] = 1
            scored.append(note)
            continue
        haystack = f"{note['title']}\n{note['body']}\n{' '.join(note['tags'])}".lower()
        hits = sum(1 for t in set(terms) if t in haystack)
        if hits:
            note["score"] = hits
            scored.append(note)
    scored.sort(key=lambda n: (-n["score"], n["title"]))
    return scored[:limit]
