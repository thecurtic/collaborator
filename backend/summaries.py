"""Branch summaries and chat overviews, made ahead of time.

A BRANCH is the path from a chat's root to one of its leaves (a committed turn
with no committed children). Every branch gets its own summary and generated
label covering the leaf and every turn above it, never descendants or
siblings, which are only mentioned where the branch split off. A chat with
forks also gets an overview, built from its branch summaries (never raw
turns) and rebuilt whenever one of them changes. Discarded turns are never
part of a branch.

Rows are keyed by the leaf they cover. When a branch grows, its row is the
previous summary for a rolling update (previous summary + the turns since,
folded in chunk by chunk, so a long branch never loses its middle) and is
re-keyed to the new leaf. A row is stale when its branch has new committed
turns, a new fork appeared on its path (the "one branch of several" wording
changes), or a turn it covered was discarded or deleted (the row is then no
longer a prefix of the path, and the branch is summarized afresh).

A background thread in the backend process picks up chats that have been idle
summaries.idle_minutes and have summaries.min_exchanges exchanges, and fills
in what's missing or stale: branch summaries, the overview, the chat card's
summary (overview when forked, else the one branch summary) with its proposed
tags (never applied), and the title. Nothing here touches the vault.
"""

import datetime
import hashlib
import json
import live as live_updates
import os
import sqlite3
import threading
from typing import Callable, Dict, List, Optional

from config import get_config, resolve_path


def ensure_schema(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS branch_summaries (
            leaf_turn_id   INTEGER PRIMARY KEY,
            root_id        INTEGER NOT NULL,
            fork_turn_id   INTEGER,
            path_turns     INTEGER NOT NULL,
            fork_signature TEXT NOT NULL,
            label          TEXT,
            text           TEXT NOT NULL,
            tags           TEXT,
            generated_at   TEXT NOT NULL
        )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_branch_summaries_root "
                 "ON branch_summaries(root_id)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chat_overviews (
            root_id      INTEGER PRIMARY KEY,
            text         TEXT NOT NULL,
            tags         TEXT,
            source_sig   TEXT NOT NULL,
            generated_at TEXT NOT NULL
        )""")
    conn.commit()


def _cfg() -> Dict:
    return get_config().get("summaries", {}) or {}


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


# --- Tree shape (committed turns only) ------------------------------------------

class Shape:
    """One chat's committed turns. Each turn's parent is its nearest committed
    ancestor, so a discarded turn drops out and its committed children hang
    off the turn above it (the same path the model's context walks)."""

    def __init__(self, root: int, nodes: Dict[int, tuple]):
        self.root = root
        self.nodes = nodes                    # id -> (parent, role, created_at)
        self.children: Dict[int, List[int]] = {i: [] for i in nodes}
        for i in sorted(nodes):
            p = nodes[i][0]
            if p is not None and p in self.children:
                self.children[p].append(i)

    @property
    def turns(self) -> int:
        return len(self.nodes)

    @property
    def exchanges(self) -> int:
        return sum(1 for n in self.nodes.values() if n[1] == "assistant")

    @property
    def last_activity(self) -> str:
        return max((n[2] or "") for n in self.nodes.values())

    def leaves(self) -> List[int]:
        return [i for i in sorted(self.nodes) if not self.children[i]]

    def path(self, turn_id: int) -> List[int]:
        out, cur = [], turn_id
        while cur is not None and cur in self.nodes:
            out.append(cur)
            cur = self.nodes[cur][0]
        return out[::-1]

    def forks(self, path: List[int]) -> List[int]:
        return [i for i in path[:-1] if len(self.children[i]) > 1]

    def leaves_below(self, turn_id: int) -> List[int]:
        out, stack = [], [turn_id]
        while stack:
            i = stack.pop()
            kids = self.children.get(i) or []
            if not kids:
                out.append(i)
            stack.extend(kids)
        return sorted(out)

    def mainline_leaf(self, turn_id: int) -> int:
        """The leaf reached by always taking the oldest child: the line a
        turn's subtree continues on (its own forks are labeled where they
        split)."""
        cur = turn_id
        while self.children.get(cur):
            cur = self.children[cur][0]
        return cur

    @property
    def forked(self) -> bool:
        return len(self.leaves()) > 1


def _shapes_from_rows(rows) -> Dict[int, Shape]:
    parent = {r[0]: r[1] for r in rows}
    info = {r[0]: r for r in rows}
    root_of: Dict[int, int] = {}

    def find_root(i):
        trail = []
        while i not in root_of:
            trail.append(i)
            p = parent.get(i)
            if p is None or p not in parent:
                root_of[i] = i
                break
            i = p
        r = root_of[i]
        for t in trail:
            root_of[t] = r
        return r

    groups: Dict[int, Dict[int, tuple]] = {}
    for tid, _p, role, committed, created in rows:
        if not committed:
            continue
        root = find_root(tid)
        if not info[root][3]:
            continue                      # a chat whose root was discarded
        eff = parent.get(tid)
        while eff is not None and eff in info and not info[eff][3]:
            eff = parent.get(eff)
        if eff is not None and eff not in info:
            eff = None
        groups.setdefault(root, {})[tid] = (eff, role, created)
    return {root: Shape(root, nodes) for root, nodes in groups.items()}


def load_shapes(conn) -> Dict[int, Shape]:
    """Every chat's shape, keyed by root id (one query; personal scale)."""
    return _shapes_from_rows(conn.execute(
        "SELECT id, parent_turn_id, role, committed, created_at FROM turns").fetchall())


def load_shape(conn, root_id: int) -> Optional[Shape]:
    rows = conn.execute(
        """
        WITH RECURSIVE sub(id) AS (
            SELECT id FROM turns WHERE id = ?
            UNION ALL
            SELECT t.id FROM turns t JOIN sub ON t.parent_turn_id = sub.id
        )
        SELECT id, parent_turn_id, role, committed, created_at FROM turns
        WHERE id IN (SELECT id FROM sub)
        """, (root_id,)).fetchall()
    # The root's own parent is outside the subtree, so it reads as a root here.
    return _shapes_from_rows(rows).get(root_id)


def root_of(conn, turn_id: int) -> int:
    current = turn_id
    while True:
        row = conn.execute("SELECT parent_turn_id FROM turns WHERE id = ?",
                           (current,)).fetchone()
        if row is None or row[0] is None:
            return current
        current = row[0]


# --- Stored rows ------------------------------------------------------------------

_ROW_COLS = ["leaf_turn_id", "root_id", "fork_turn_id", "path_turns",
             "fork_signature", "label", "text", "tags", "generated_at"]


def _row(r) -> Dict:
    d = dict(zip(_ROW_COLS, r))
    try:
        d["tags"] = json.loads(d["tags"]) if d["tags"] else []
    except ValueError:
        d["tags"] = []
    return d


def branch_rows(conn, turn_ids) -> Dict[int, Dict]:
    """Stored branch summaries whose leaf is among turn_ids, by leaf."""
    ids = list(turn_ids)
    out = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for r in conn.execute(
                f"SELECT {', '.join(_ROW_COLS)} FROM branch_summaries "
                f"WHERE leaf_turn_id IN ({marks})", chunk).fetchall():
            out[r[0]] = _row(r)
    return out


def get_overview(conn, root_id: int) -> Optional[Dict]:
    r = conn.execute("SELECT text, tags, source_sig, generated_at FROM chat_overviews "
                     "WHERE root_id = ?", (root_id,)).fetchone()
    if not r:
        return None
    try:
        tags = json.loads(r[1]) if r[1] else []
    except ValueError:
        tags = []
    return {"text": r[0], "tags": tags, "source_sig": r[2], "generated_at": r[3]}


def _sig(rows: List[Dict]) -> str:
    """What an overview was built from: each branch's leaf, length and text."""
    return json.dumps(sorted(
        [r["leaf_turn_id"], r["path_turns"],
         hashlib.sha1(r["text"].encode()).hexdigest()[:12]] for r in rows))


# --- Planning (no model calls) ----------------------------------------------------

class Plan:
    def __init__(self, shape: Shape, rows: Dict[int, Dict], overview: Optional[Dict],
                 title_state, card: Optional[Dict]):
        self.shape = shape
        self.rows = rows
        self.overview = overview
        self.leaves = shape.leaves()
        self.branches = []                # [{leaf, path, sig, fork, base, fresh}]
        for leaf in self.leaves:
            path = shape.path(leaf)
            forks = shape.forks(path)
            sig = json.dumps(forks)
            row = rows.get(leaf)
            fresh = bool(row and row["path_turns"] == len(path)
                         and row["fork_signature"] == sig)
            base = None
            if not fresh:
                # The deepest stored row that is still an exact prefix of this
                # path: its leaf sits where its length says it should.
                for i in range(len(path) - 1, -1, -1):
                    cand = rows.get(path[i])
                    if cand and cand["path_turns"] == i + 1:
                        base = cand
                        break
            self.branches.append({"leaf": leaf, "path": path, "sig": sig,
                                  "fork": forks[-1] if forks else None,
                                  "base": base, "fresh": fresh})
        self.stale_branches = [b for b in self.branches if not b["fresh"]]
        self.orphans = [l for l in rows if l not in set(self.leaves)]
        self.title, self.title_turns = title_state
        self.card = card

    def overview_stale(self) -> bool:
        if not self.shape.forked:
            return False
        if self.stale_branches or self.overview is None:
            return True
        return self.overview["source_sig"] != _sig([self.rows[l] for l in self.leaves])

    def title_stale(self) -> bool:
        tcfg = get_config().get("titles", {}) or {}
        if not tcfg.get("enabled", True):
            return False
        if self.title is None:
            return True
        if self.shape.forked and self.overview is None:
            return True               # newly forked: retitle from the overview
        return (self.shape.turns - (self.title_turns or 0)
                >= tcfg.get("regenerate_after_turns", 6))

    def card_stale(self) -> bool:
        return (self.card is None or self.card.get("turns") != self.shape.turns
                or bool(self.stale_branches) or self.overview_stale())

    def needs_work(self) -> bool:
        return bool(self.stale_branches or self.orphans or self.overview_stale()
                    or (not self.shape.forked and self.overview is not None)
                    or self.card_stale() or self.title_stale())


def plan_chat(conn, shape: Shape) -> Plan:
    from db import get_chat_summary, get_turn_title_state
    return Plan(shape, branch_rows(conn, shape.nodes), get_overview(conn, shape.root),
                get_turn_title_state(conn, shape.root),
                get_chat_summary(conn, shape.root))


# --- Generation -------------------------------------------------------------------

class Hooks:
    """What reconcile calls out to. main.py builds one that resolves its
    generators at call time (so tests can patch them there)."""

    def __init__(self, branch_summary: Callable, overview: Callable, title: Callable,
                 vocabulary: Callable, propose_tags: Callable):
        self.branch_summary = branch_summary   # (previous, turns, fork_note, vocab) -> dict
        self.overview = overview               # (branches, vocab) -> dict
        self.title = title                     # (turns) -> str
        self.vocabulary = vocabulary           # (conn) -> [tag]
        self.propose_tags = propose_tags       # (tags, current) -> [tag]


class SummaryError(RuntimeError):
    pass


def _contents(conn, ids: List[int]) -> Dict[int, Dict]:
    out = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for tid, role, content in conn.execute(
                f"SELECT id, role, content FROM turns WHERE id IN ({marks})",
                chunk).fetchall():
            out[tid] = {"role": role, "content": content or ""}
    return out


def _excerpt(turn: Optional[Dict], n: int = 300) -> str:
    if not turn:
        return ""
    text = " ".join((turn.get("content") or "").split())
    return f"({turn['role']}) {text[:n]}{'…' if len(text) > n else ''}"


def _fork_note(plan: Plan, branch: Dict, contents: Dict[int, Dict],
               labels: Dict[int, str]) -> str:
    if branch["fork"] is None:
        return "This chat has one line of conversation; it has no branches."
    fork = branch["fork"]
    siblings = [labels.get(b["leaf"]) for b in plan.branches
                if b["leaf"] != branch["leaf"] and fork in b["path"]]
    note = (f"This chat has {len(plan.leaves)} branches and this is one of them. "
            f"It split off after this message: {_excerpt(contents.get(fork))}")
    named = [s for s in siblings if s]
    if named:
        note += f" Sibling branches from that point: {'; '.join(named)}."
    return note


def _chunks(turns: List[Dict], limit: int, turn_chars: int) -> List[List[Dict]]:
    out, cur, size = [], [], 0
    for t in turns:
        n = min(len(t["content"]), turn_chars) + 20
        if cur and size + n > limit:
            out.append(cur)
            cur, size = [], 0
        cur.append(t)
        size += n
    if cur:
        out.append(cur)
    return out


_locks: Dict[tuple, threading.Lock] = {}
_locks_guard = threading.Lock()


def _chat_lock(db_path: str, root_id: int) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault((db_path, root_id), threading.Lock())


def reconcile_chat(db_path: str, root_id: int, hooks: Hooks) -> Dict:
    """Bring one chat's branch summaries, overview, card and title up to date,
    regenerating only what's missing or stale. Raises SummaryError when a
    generation fails or comes back empty (what was done before it is kept
    only if the whole pass succeeds: nothing is written on failure)."""
    with _chat_lock(db_path, root_id):
        return _reconcile(db_path, root_id, hooks)


def _reconcile(db_path: str, root_id: int, hooks: Hooks) -> Dict:
    cfg = _cfg()
    conn = sqlite3.connect(db_path)
    try:
        shape = load_shape(conn, root_id)
        if shape is None:
            return {"branches": 0, "overview": False, "title": False, "card": False}
        plan = plan_chat(conn, shape)
        need = set()
        for b in plan.stale_branches:
            need.update(b["path"][b["base"]["path_turns"]:] if b["base"] else b["path"])
            if b["fork"] is not None:
                need.add(b["fork"])
        for b in plan.branches:
            if b["fork"] is not None:
                need.add(b["fork"])
        if plan.title_stale() and not shape.forked:
            need.update(plan.branches[0]["path"])
        contents = _contents(conn, sorted(need))
        vocab = hooks.vocabulary(conn)
        from db import get_chat_tags
        current_tags = get_chat_tags(conn, root_id)
    finally:
        conn.close()

    labels = {l: r.get("label") for l, r in plan.rows.items()}
    rows = {l: plan.rows[l] for l in plan.leaves if l in plan.rows}
    chunk_chars = cfg.get("chunk_chars", 8000)
    turn_chars = cfg.get("turn_chars", 1200)
    written = []
    for b in plan.stale_branches:
        previous = b["base"]["text"] if b["base"] else None
        new_ids = b["path"][b["base"]["path_turns"]:] if b["base"] else b["path"]
        note = _fork_note(plan, b, contents, labels)
        result = None
        for chunk in _chunks([contents[i] for i in new_ids if i in contents],
                             chunk_chars, turn_chars) or [[]]:
            result = hooks.branch_summary(previous, chunk, note, vocab)
            previous = (result or {}).get("summary") or ""
            if not previous:
                raise SummaryError(f"empty branch summary for leaf {b['leaf']}")
        row = {"leaf_turn_id": b["leaf"], "root_id": root_id, "fork_turn_id": b["fork"],
               "path_turns": len(b["path"]), "fork_signature": b["sig"],
               "label": result.get("label") or (b["base"] or {}).get("label"),
               "text": previous, "tags": result.get("tags") or [],
               "generated_at": _now()}
        rows[b["leaf"]] = row
        labels[b["leaf"]] = row["label"]
        written.append(row)

    overview = plan.overview
    new_overview = None
    if shape.forked:
        current = [rows[l] for l in plan.leaves]
        if overview is None or overview["source_sig"] != _sig(current):
            result = hooks.overview(
                [{"label": r["label"],
                  "split_after": _excerpt(contents.get(r["fork_turn_id"]), 200),
                  "summary": r["text"]} for r in current], vocab)
            if not (result or {}).get("summary"):
                raise SummaryError(f"empty overview for chat {root_id}")
            new_overview = {"text": result["summary"], "tags": result.get("tags") or [],
                            "source_sig": _sig(current), "generated_at": _now()}
            overview = new_overview

    if shape.forked:
        card_text, card_tags = overview["text"], overview["tags"]
    else:
        only = rows.get(plan.leaves[0]) if plan.leaves else None
        card_text = only["text"] if only else None
        card_tags = only["tags"] if only else []
    card = plan.card
    new_card = None
    if card_text and (card is None or card.get("text") != card_text
                      or card.get("turns") != shape.turns):
        new_card = {"text": card_text,
                    "proposed_tags": hooks.propose_tags(card_tags, current_tags),
                    "turns": shape.turns, "generated_at": _now()}

    new_title = None
    if plan.title_stale():
        if shape.forked:
            source = [{"role": "overview", "content": overview["text"]}]
        else:
            source = [contents[i] for i in plan.branches[0]["path"] if i in contents]
        new_title = hooks.title(source) or None

    conn = sqlite3.connect(db_path)
    try:
        for r in written:
            conn.execute(
                f"INSERT OR REPLACE INTO branch_summaries ({', '.join(_ROW_COLS)}) "
                f"VALUES ({', '.join('?' * len(_ROW_COLS))})",
                [json.dumps(r[c]) if c == "tags" else r[c] for c in _ROW_COLS])
        leaves = set(plan.leaves)
        for leaf in plan.orphans:
            if leaf not in leaves:
                conn.execute("DELETE FROM branch_summaries WHERE leaf_turn_id = ?", (leaf,))
        # Rows of this chat whose leaf left it (deleted, discarded, split off).
        for (leaf,) in conn.execute(
                "SELECT leaf_turn_id FROM branch_summaries WHERE root_id = ?",
                (root_id,)).fetchall():
            if leaf not in shape.nodes:
                conn.execute("DELETE FROM branch_summaries WHERE leaf_turn_id = ?", (leaf,))
        if new_overview:
            conn.execute(
                "INSERT OR REPLACE INTO chat_overviews "
                "(root_id, text, tags, source_sig, generated_at) VALUES (?, ?, ?, ?, ?)",
                (root_id, new_overview["text"], json.dumps(new_overview["tags"]),
                 new_overview["source_sig"], new_overview["generated_at"]))
        if not shape.forked:
            conn.execute("DELETE FROM chat_overviews WHERE root_id = ?", (root_id,))
        if new_card:
            conn.execute("UPDATE turns SET summary = ? WHERE id = ?",
                         (json.dumps(new_card), root_id))
        if new_title:
            conn.execute("UPDATE turns SET title = ?, title_turns = ? WHERE id = ?",
                         (new_title, shape.turns, root_id))
        conn.commit()
    finally:
        conn.close()
    live_updates.publish(db_path, ["chats"])   # labels, card, title changed
    return {"branches": len(written), "overview": bool(new_overview),
            "title": bool(new_title), "card": bool(new_card)}


# --- The background job -----------------------------------------------------------

def _cutoff(idle_minutes: float) -> str:
    """created_at is SQLite's datetime('now'): UTC 'YYYY-MM-DD HH:MM:SS'."""
    t = (datetime.datetime.now(datetime.timezone.utc)
         - datetime.timedelta(minutes=idle_minutes))
    return t.strftime("%Y-%m-%d %H:%M:%S")


def run_once(db_path: str, hooks: Hooks, log=print) -> Dict:
    """One pass over one conversation DB: every idle, long-enough chat with
    something missing or stale is reconciled. A failing chat is logged and
    skipped; the rest still run."""
    cfg = _cfg()
    cutoff = _cutoff(cfg.get("idle_minutes", 15))
    min_ex = cfg.get("min_exchanges", 2)
    stats = {"chats": 0, "failed": 0, "removed": 0}
    conn = sqlite3.connect(db_path)
    try:
        ensure_schema(conn)
        shapes = load_shapes(conn)
        # Rows for leaves no chat has any more (discarded, deleted).
        live = set()
        for s in shapes.values():
            live.update(s.nodes)
        dead = [r[0] for r in conn.execute(
            "SELECT leaf_turn_id FROM branch_summaries").fetchall() if r[0] not in live]
        for leaf in dead:
            conn.execute("DELETE FROM branch_summaries WHERE leaf_turn_id = ?", (leaf,))
        conn.execute(f"DELETE FROM chat_overviews WHERE root_id NOT IN "
                     f"({','.join(str(int(r)) for r in shapes) or 'NULL'})")
        conn.commit()
        stats["removed"] = len(dead)
        due = []
        for root, shape in sorted(shapes.items()):
            if shape.exchanges < min_ex or shape.last_activity > cutoff:
                continue
            if plan_chat(conn, shape).needs_work():
                due.append(root)
    finally:
        conn.close()
    for root in due:
        try:
            reconcile_chat(db_path, root, hooks)
            stats["chats"] += 1
        except Exception as e:
            stats["failed"] += 1
            log(f"Warning: summaries for chat {root} failed: {e}")
    return stats


def conversation_dbs() -> List[str]:
    """Every conversation DB the app serves (one per user under auth)."""
    cfg = get_config()
    if cfg.get("authentication", {}).get("enabled", False):
        users_dir = resolve_path(cfg.get("authentication", {}).get("users_dir")
                                 or "backend/data/users")
        if not os.path.isdir(users_dir):
            return []
        return [p for p in (os.path.join(users_dir, h, "conversations.db")
                            for h in sorted(os.listdir(users_dir)))
                if os.path.isfile(p)]
    path = os.environ.get("DB_PATH") or cfg.get("memory", {}).get("db_path")
    path = resolve_path(path or "backend/data/conversations.db")
    return [path] if os.path.isfile(path) else []


_stop = threading.Event()
_thread: Optional[threading.Thread] = None


def start(hooks: Hooks, first_delay: float = 30.0) -> bool:
    """Start the background job (once per process). False when disabled."""
    global _thread
    if not _cfg().get("enabled", True) or (_thread and _thread.is_alive()):
        return False
    _stop.clear()

    def loop():
        delay = first_delay
        while not _stop.wait(delay):
            for path in conversation_dbs():
                try:
                    stats = run_once(path, hooks)
                    if stats["chats"] or stats["failed"]:
                        print(f"Summaries: {stats['chats']} chat(s) updated, "
                              f"{stats['failed']} failed")
                except Exception as e:
                    print(f"Warning: summaries pass failed: {e}")
            delay = _cfg().get("interval_seconds", 300)

    _thread = threading.Thread(target=loop, name="summaries", daemon=True)
    _thread.start()
    return True


def stop() -> None:
    _stop.set()


# --- Reading (tree labels; search hits use these next) ----------------------------

def attach_labels(conn, roots: List[Dict]) -> None:
    """Set `label` on each tree node that starts a branch (a child of a turn
    with several children): the generated label of the line it continues on.
    Nodes whose branch hasn't been summarized yet get none."""
    rows = {r[0]: r[1] for r in conn.execute(
        "SELECT leaf_turn_id, label FROM branch_summaries WHERE label IS NOT NULL"
    ).fetchall()}
    if not rows:
        return
    stack = list(roots)
    while stack:
        node = stack.pop()
        kids = node.get("children") or []
        if len(kids) > 1:
            for k in kids:
                cur = k
                while cur.get("children"):
                    cur = cur["children"][0]
                if rows.get(cur["id"]):
                    k["label"] = rows[cur["id"]]
        stack.extend(kids)
