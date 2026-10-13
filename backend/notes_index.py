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
    "event_start", "event_end", "event_all_day", "fields",
]
_COLS = ", ".join(NOTES_INDEX_COLUMNS)

# Per-type frontmatter keys mirrored into the generic `fields` JSON column —
# one column, so the whitelist can grow without index migrations.
INDEXED_FIELD_KEYS = ("location", "people", "repeat", "exceptions", "aliases", "kind",
                      "relation", "birthday", "area",
                      "name", "dob", "resides_in", "timezone")


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


def _plain(value):
    """YAML structures -> JSON-safe ones (dates/datetimes to ISO strings)."""
    import datetime as _dt
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, (_dt.date, _dt.datetime)):
        return _norm_when(value)
    return value


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

    fields = {}
    for key in INDEXED_FIELD_KEYS:
        value = front.get(key)
        if value in (None, "", []):
            continue
        if key in ("people", "aliases"):
            if not isinstance(value, list):
                value = [str(value)]
            fields[key] = [str(v) for v in value if str(v).strip()]
        elif key in ("repeat", "exceptions"):
            # Structured (recurrence rule / per-occurrence overrides); YAML
            # hands back dates as date objects, the JSON column wants strings.
            fields[key] = _plain(value)
        else:
            fields[key] = _norm_when(value) if key == "dob" else str(value)

    # Graph edges = body [[wikilinks]] UNION event `people` (frontmatter is
    # file content, so the rebuildable-from-files invariant holds; one source
    # of truth for who-was-there).
    links = extract_wikilinks(body)
    for person in fields.get("people", []):
        if person and person not in links:
            links.append(person)

    return {
        "filename": os.path.basename(path),
        "title": title,
        "created": str(front.get("created")) if front.get("created") is not None else None,
        "tags": [str(t) for t in tags],
        "source_turns": [int(i) for i in source_turns if isinstance(i, (int, float))],
        "links": links,
        "body": body,
        "content_hash": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        "mtime": os.path.getmtime(path),
        "event_start": event_start,
        "event_end": event_end,
        "event_all_day": event_all_day,
        "fields": fields,
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
    try:
        d["fields"] = json.loads(d["fields"]) if d.get("fields") else {}
        if not isinstance(d["fields"], dict):
            d["fields"] = {}
    except Exception:
        d["fields"] = {}
    d["event_all_day"] = bool(d.get("event_all_day"))
    return d


def _upsert(conn, note: dict, embedding=None) -> None:
    conn.cursor().execute(
        """
        INSERT INTO notes_index
            (filename, title, created, tags, source_turns, links, body,
             content_hash, mtime, event_start, event_end, event_all_day,
             fields, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(filename) DO UPDATE SET
            title = excluded.title, created = excluded.created,
            tags = excluded.tags, source_turns = excluded.source_turns,
            links = excluded.links, body = excluded.body,
            content_hash = excluded.content_hash, mtime = excluded.mtime,
            event_start = excluded.event_start, event_end = excluded.event_end,
            event_all_day = excluded.event_all_day, fields = excluded.fields,
            embedding = COALESCE(excluded.embedding, notes_index.embedding)
        """,
        (note["filename"], note["title"], note["created"],
         json.dumps(note["tags"]), json.dumps(note["source_turns"]),
         json.dumps(note["links"]), note["body"],
         note["content_hash"], note["mtime"],
         note.get("event_start"), note.get("event_end"),
         1 if note.get("event_all_day") else 0,
         json.dumps(note.get("fields") or {}), embedding),
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
            vecs = embed_fn([_embed_text(note)])
            blob = _embed_blob(vecs[0] if vecs else None)
        except Exception:
            blob = None
    _upsert(conn, note, embedding=blob)
    return note


# USER.md: the profile hub. Fixed section headings are GUARDRAILS — the LLM
# only ever proposes edits within them (reviewed), never invents structure.
# Each section is a branch point: satellite user-profile notes (frontmatter
# `area`) hang off it via [[wikilinks]].
USER_NOTE_SECTIONS = [
    "Background", "Significant Relationships", "Work", "Interests",
    "Philosophy & Values", "Health & Habits", "Preferences", "Current Focus",
]


def ensure_user_note(vault_dir: str) -> bool:
    """Seed USER.md (empty sections, app-stamped frontmatter) if absent.
    Structure only — every word of content still arrives via the review queue.
    Returns True when the file was created."""
    import time as _time
    os.makedirs(vault_dir, exist_ok=True)
    path = os.path.join(vault_dir, "USER.md")
    if any(f.lower() == "user.md" for f in os.listdir(vault_dir)):
        return False
    sections = "\n\n".join(
        f"## {s}\n\n_Nothing recorded yet._" for s in USER_NOTE_SECTIONS)
    content = ("---\n"
               f"created: {_time.strftime('%Y-%m-%d')}\n"
               "tags: [user-profile]\n"
               "---\n\n"
               "# USER\n\n"
               "The hub of the user profile. Each section below is a branch "
               "point — satellite notes tagged `user-profile` (frontmatter "
               "`area`) link from here.\n\n" + sections + "\n")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def reindex_vault(conn, vault_dir: str, embed_fn=None,
                  ensure_user: bool = True) -> dict:
    """Reconcile the index against the vault directory (files win, always).

    New/changed files (by content hash) are re-parsed and re-embedded; rows whose
    files vanished are removed. Seeds USER.md when absent. Returns
    {"added", "updated", "removed", "total", "user_note_created",
    "updated_titles"}.
    """
    user_created = False
    if ensure_user:
        try:
            user_created = ensure_user_note(vault_dir)
        except OSError as e:
            print(f"Warning: could not seed USER.md: {e}")
    cursor = conn.cursor()
    on_disk = {}
    if os.path.isdir(vault_dir):
        for name in os.listdir(vault_dir):
            if name.endswith(".md") and not name.startswith("."):
                on_disk[name] = os.path.join(vault_dir, name)

    existing = dict(cursor.execute(
        "SELECT filename, content_hash FROM notes_index").fetchall())

    added, updated, changed, updated_titles = 0, 0, [], []
    for name, path in on_disk.items():
        note = parse_note_file(path)
        if name not in existing:
            added += 1
            changed.append(note)
        elif existing[name] != note["content_hash"]:
            updated += 1
            changed.append(note)
            updated_titles.append(note["title"])

    # Embed changed notes in batches (one model call per chunk).
    embeddings = {}
    if embed_fn is not None and changed:
        CHUNK = 64
        for start in range(0, len(changed), CHUNK):
            chunk = changed[start:start + CHUNK]
            try:
                vecs = embed_fn([_embed_text(n) for n in chunk])
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
    return {"added": added, "updated": updated, "removed": removed,
            "total": total, "user_note_created": user_created,
            # Existing notes whose content changed (e.g. edited in Obsidian):
            # the warm feed treats these as "changed"; first-time adds don't.
            "updated_titles": sorted(updated_titles)}


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


def _embed_text(note: dict) -> str:
    """Text embedded for a note: title + aliases (a person's nicknames should
    hit their note) + body."""
    aliases = (note.get("fields") or {}).get("aliases") or []
    alias_line = f"\n{' / '.join(aliases)}" if aliases else ""
    return f"{note['title']}{alias_line}\n{note['body']}"


def _note_matches_area(note: dict, area: str = None) -> bool:
    if not area:
        return True
    return (note.get("fields") or {}).get("area") == area


def _note_in_created_range(note: dict, created_from: str = None,
                           created_to: str = None) -> bool:
    """created is day-granular ISO (the approval date); range is inclusive.
    Notes without a created date are excluded from any date-filtered query."""
    if not created_from and not created_to:
        return True
    created = (note.get("created") or "")[:10]
    if not created:
        return False
    if created_from and created < created_from[:10]:
        return False
    if created_to and created > created_to[:10]:
        return False
    return True


def search_notes_semantic(conn, query_vector, limit: int = 10, tag: str = None,
                          created_from: str = None, created_to: str = None,
                          area: str = None):
    """Cosine similarity over indexed note embeddings. Optional tag and
    created-date-range filters (composable)."""
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
        if not _note_in_created_range(note, created_from, created_to):
            continue
        if not _note_matches_area(note, area):
            continue
        note["score"] = float(np.dot(q, vec) / denom)
        scored.append(note)
    scored.sort(key=lambda n: n["score"], reverse=True)
    return scored[:limit]


def graph_neighborhood(conn, title: str, depth: int = 1, max_nodes: int = 40):
    """BFS subgraph around a note, across [[links]] AND backlinks.

    Returns {"center", "nodes": [{title, tags, created, distance, preview,
    missing?}], "edges": [{"from", "to"}], "truncated"} or None when the
    center note doesn't exist. Link targets with no note yet appear as
    missing: True nodes (Obsidian's unresolved links are potential notes) but
    are not expanded. Edges are directed from linker to target; every edge
    among included nodes is reported, deduped. Depth capped by the caller.
    """
    center = get_note_by_title(conn, title)
    if center is None:
        return None

    # Whole-index adjacency in one pass (personal-scale corpus).
    notes = {}
    outgoing = {}
    display = {}                 # lower key -> original casing (notes win)
    for row in conn.cursor().execute(f"SELECT {_COLS} FROM notes_index").fetchall():
        note = _row_to_note(row)
        key = note["title"].lower()
        notes[key] = note
        display[key] = note["title"]
        outgoing[key] = [l for l in note["links"]]
    incoming = {}
    for src, targets in outgoing.items():
        for t in targets:
            incoming.setdefault(t.lower(), []).append(src)
            display.setdefault(t.lower(), t)   # keep wikilink casing for missing

    start = center["title"].lower()
    distance = {start: 0}
    order = [start]
    frontier = [start]
    truncated = False
    for d in range(1, depth + 1):
        next_frontier = []
        for key in frontier:
            neighbors = ([t.lower() for t in outgoing.get(key, [])]
                         + incoming.get(key, []))
            for n in neighbors:
                if n in distance:
                    continue
                if len(order) >= max_nodes:
                    truncated = True
                    break
                distance[n] = d
                order.append(n)
                if n in notes:          # missing notes are recorded, not expanded
                    next_frontier.append(n)
        frontier = next_frontier
    included = set(order)

    def _display(key):
        return display.get(key, key)

    nodes = []
    for key in order:
        if key in notes:
            n = notes[key]
            nodes.append({"title": n["title"], "tags": n["tags"],
                          "created": n["created"], "distance": distance[key],
                          "preview": (n.get("body") or "")[:160]})
        else:
            nodes.append({"title": _display(key), "distance": distance[key],
                          "missing": True})

    edges, seen = [], set()
    for src in included:
        if src not in notes:
            continue
        for t in outgoing.get(src, []):
            tkey = t.lower()
            if tkey in included and (src, tkey) not in seen:
                seen.add((src, tkey))
                edges.append({"from": _display(src), "to": _display(tkey)})

    return {"center": center["title"], "nodes": nodes, "edges": edges,
            "truncated": truncated}


def list_events(conn, window_start: str = None, window_end: str = None,
                expand: bool = True):
    """Notes tagged 'event' with a start, optionally within an inclusive window.

    window_start/window_end are ISO dates (YYYY-MM-DD) or datetimes; an event
    overlaps the window if any part of its [start, end-or-start] span does.
    Comparison is on local wall-clock strings (offsets ignored) — fine for a
    single-user, single-timezone corpus. Sorted by start.

    Recurring events (frontmatter `repeat`, NOTES-FORMAT.md) are EXPANDED into
    their occurrences inside the window: each comes back as its own entry with
    event_start/event_end for that occurrence plus `occurrence` (the original
    date), `recurring: True` and `moved`. Nothing about occurrences is stored.
    With expand=False, or no window to expand into, a series is returned once
    as the note itself (`recurring: True`, no `occurrence`) — the ICS export
    writes it as one VEVENT with RRULE.
    """
    import recurrence

    def _cmp(value, end_of_day):
        if len(value) > 10:
            return value[:16]
        return value + ("T23:59" if end_of_day else "T00:00")

    ws = _cmp(window_start, False) if window_start else None
    we = _cmp(window_end, True) if window_end else None
    events = []
    for row in conn.cursor().execute(f"SELECT {_COLS} FROM notes_index").fetchall():
        note = _row_to_note(row)
        if not note.get("event_start") or not _note_has_tag(note, "event"):
            continue
        rule = (note.get("fields") or {}).get("repeat")
        if isinstance(rule, dict) and rule.get("freq"):
            if not expand or not (window_start and window_end):
                events.append({**note, "recurring": True})
                continue
            for occ in recurrence.expand(
                    note["event_start"], note.get("event_end"), rule,
                    (note.get("fields") or {}).get("exceptions"),
                    window_start, window_end):
                events.append({**note, "event_start": occ["start"],
                               "event_end": occ["end"], "occurrence": occ["date"],
                               "recurring": True, "moved": occ["moved"]})
            continue
        start = note["event_start"]
        end = note.get("event_end") or start
        if ws and _cmp(end, True) < ws:
            continue
        if we and _cmp(start, False) > we:
            continue
        events.append({**note, "recurring": False})
    events.sort(key=lambda n: (n["event_start"], n["title"]))
    return events


def search_notes_keyword(conn, query: str, limit: int = 10, tag: str = None,
                         created_from: str = None, created_to: str = None,
                         area: str = None):
    """Lexical search over title/body/tags by term overlap. Optional tag and
    created-date-range filters (composable).

    With filters and NO query terms, returns every note passing the filters
    (e.g. the full user profile via tag, or "everything from this week" via
    a date range alone).
    """
    terms = [t.lower() for t in re.split(r"\W+", query or "") if len(t) >= 2]
    if not terms and not tag and not created_from and not created_to:
        return []
    scored = []
    for row in conn.cursor().execute(f"SELECT {_COLS} FROM notes_index").fetchall():
        note = _row_to_note(row)
        if tag and not _note_has_tag(note, tag):
            continue
        if not _note_in_created_range(note, created_from, created_to):
            continue
        if not _note_matches_area(note, area):
            continue
        if not terms:
            note["score"] = 1
            scored.append(note)
            continue
        aliases = " ".join((note.get("fields") or {}).get("aliases") or [])
        haystack = (f"{note['title']}\n{aliases}\n{note['body']}\n"
                    f"{' '.join(note['tags'])}").lower()
        hits = sum(1 for t in set(terms) if t in haystack)
        if hits:
            note["score"] = hits
            scored.append(note)
    scored.sort(key=lambda n: (-n["score"], n["title"]))
    return scored[:limit]
