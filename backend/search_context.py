"""What the model gets back from a search: each hit with the context around it.

A conversation hit comes back as its whole exchange (the user message and the
reply), dated, with the chat's name and the summary of the branch it sits on
(summaries.py). Hits are grouped by branch, so a long chat costs its summary
once, and hits on sibling branches stay apart, marked as alternatives. A hit
upstream of a fork sits on several branches at once: it is labeled the shared
trunk and carries the chat overview plus the branches below it.

read_turn_context reads around one turn: back toward the root, and forward
only as far as the next fork, where it lists the branches and stops. The model
continues by reading a turn in the branch it picks; nothing here follows a
branch on its own.

Note hits gain their backlinks (a count and the most recent few) and the chat
they were distilled from. Everything is capped (config `search`), per hit and
per result, so a search never floods the context.
"""

import json
from typing import Dict, List, Optional

import summaries
from config import get_config


def _cfg() -> Dict:
    return get_config().get("search", {}) or {}


def _clip(text: Optional[str], n: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[:n].rstrip() + "…"


def _gist(text: Optional[str], n: int = 160) -> str:
    """The first sentence of a summary, clipped."""
    text = " ".join((text or "").split())
    for end in (". ", "? ", "! "):
        i = text.find(end)
        if 0 < i < n:
            return text[:i + 1]
    return _clip(text, n)


class _Chats:
    """Per-call cache of what hits need from their chats."""

    def __init__(self, conn):
        self.conn = conn
        self._shapes, self._rows, self._overviews, self._names = {}, {}, {}, {}
        self._roots: Dict[int, int] = {}
        self._contents: Dict[int, Dict] = {}

    def root(self, turn_id: int) -> int:
        if turn_id not in self._roots:
            self._roots[turn_id] = summaries.root_of(self.conn, turn_id)
        return self._roots[turn_id]

    def shape(self, root: int) -> Optional[summaries.Shape]:
        if root not in self._shapes:
            self._shapes[root] = summaries.load_shape(self.conn, root)
        return self._shapes[root]

    def row(self, root: int, leaf: int) -> Dict:
        if root not in self._rows:
            shape = self.shape(root)
            self._rows[root] = summaries.branch_rows(self.conn, shape.nodes) if shape else {}
        return self._rows[root].get(leaf) or {}

    def overview(self, root: int) -> Optional[Dict]:
        if root not in self._overviews:
            self._overviews[root] = summaries.get_overview(self.conn, root)
        return self._overviews[root]

    def name(self, root: int) -> str:
        if root not in self._names:
            r = self.conn.execute("SELECT name, title, content FROM turns WHERE id = ?",
                                  (root,)).fetchone()
            name = r and ((r[0] or "").strip() or (r[1] or "").strip()
                          or _clip(r[2], 60))
            self._names[root] = name or f"Chat {root}"
        return self._names[root]

    def contents(self, ids) -> Dict[int, Dict]:
        missing = [i for i in ids if i is not None and i not in self._contents]
        for start in range(0, len(missing), 500):
            chunk = missing[start:start + 500]
            marks = ",".join("?" * len(chunk))
            for tid, role, content, created in self.conn.execute(
                    f"SELECT id, role, content, created_at FROM turns WHERE id IN ({marks})",
                    chunk).fetchall():
                self._contents[tid] = {"role": role, "content": content or "",
                                       "date": (created or "")[:10]}
        return self._contents


def _exchange(shape: summaries.Shape, turn_id: int):
    """(user turn, reply turn) of the exchange a turn belongs to."""
    parent, role, _ = shape.nodes[turn_id]
    if role == "assistant":
        user = parent if parent is not None and shape.nodes[parent][1] == "user" else None
        return user, turn_id
    replies = [c for c in shape.children[turn_id] if shape.nodes[c][1] == "assistant"]
    return turn_id, (replies[0] if replies else None)


def _branches_at(ch: _Chats, root: int, fork: int) -> List[Dict]:
    """The branches leaving a fork: where each starts, its label and gist."""
    shape = ch.shape(root)
    out = []
    for child in shape.children[fork]:
        row = ch.row(root, shape.mainline_leaf(child))
        entry = {"turn_id": child, "label": row.get("label"),
                 "gist": _gist(row.get("text")) or None}
        below = len(shape.leaves_below(child))
        if below > 1:
            entry["forks_again"] = below
        out.append(entry)
    return out


def _first_fork_below(shape: summaries.Shape, turn_id: int) -> Optional[int]:
    cur = turn_id
    while len(shape.children[cur]) == 1:
        cur = shape.children[cur][0]
    return cur if len(shape.children[cur]) > 1 else None


def branch_context(ch: _Chats, root: int, turn_id: int) -> Dict:
    """Where a turn sits: its branch (label + summary, and the sibling
    branches as alternatives), or the shared trunk above a fork (overview +
    the branches below)."""
    cap = _cfg().get("summary_chars", 700)
    shape = ch.shape(root)
    leaves = shape.leaves_below(turn_id)
    if len(leaves) == 1:
        row = ch.row(root, leaves[0])
        out = {"where": "branch", "branch_label": row.get("label"),
               "branch_summary": _clip(row.get("text"), cap) or None}
        if shape.forked:
            others = [ch.row(root, l).get("label") or f"branch ending at turn {l}"
                      for l in shape.leaves() if l != leaves[0]]
            out["sibling_branches"] = (
                f"This chat has {len(others) + 1} branches. The others went their own "
                f"way and are alternatives to this one, not part of it: "
                f"{'; '.join(others)}.")
        return out
    overview = ch.overview(root)
    fork = _first_fork_below(shape, turn_id)
    return {"where": "shared_trunk",
            "note": "This turn comes before a fork, so it belongs to every branch "
                    "below it. Pick a branch and read on with read_turn_context.",
            "chat_overview": _clip(overview["text"], cap) if overview else None,
            "branches_below": _branches_at(ch, root, fork) if fork is not None else []}


def turn_hits(conn, matches: List[Dict]) -> Dict:
    """The recall tools' payload: hits as whole exchanges, grouped by branch
    (best group first), each group with its chat and branch context. Capped
    per exchange and in total; what doesn't fit is counted, not sent."""
    cfg = _cfg()
    hit_chars = cfg.get("hit_chars", 900)
    budget = cfg.get("max_result_chars", 12000)
    ch = _Chats(conn)
    groups: Dict[tuple, Dict] = {}
    seen = set()
    placed = []
    for m in matches:
        tid = m["turn_id"]
        root = ch.root(tid)
        shape = ch.shape(root)
        if shape is None or tid not in shape.nodes:
            continue
        user, reply = _exchange(shape, tid)
        key = user or tid
        if key in seen:
            continue
        seen.add(key)
        gkey = (root, tuple(shape.leaves_below(tid)))
        if gkey not in groups:
            groups[gkey] = {"chat": ch.name(root), "chat_id": root,
                            **branch_context(ch, root, tid), "exchanges": []}
        placed.append((gkey, tid, user, reply, m.get("score")))
    contents = ch.contents([i for _, _, u, r, _ in placed for i in (u, r)])
    user_cap = hit_chars // 3
    for gkey, tid, user, reply, score in placed:
        ex = {"turn_id": tid,
              "date": (contents.get(user) or contents.get(reply) or {}).get("date")}
        if user is not None:
            ex["user"] = _clip(contents[user]["content"], user_cap)
        if reply is not None:
            ex["assistant"] = _clip(contents[reply]["content"], hit_chars - user_cap)
        if score is not None:
            ex["score"] = round(score, 4)
        groups[gkey]["exchanges"].append(ex)

    per_chat: Dict[int, int] = {}
    for root, _ in groups:
        per_chat[root] = per_chat.get(root, 0) + 1
    out, size, omitted = [], 0, 0
    for (root, _), g in groups.items():
        if per_chat[root] > 1:
            g["alternatives"] = ("Other groups in these results are other branches of "
                                 "this same chat: alternatives, not one conversation.")
        kept = []
        for ex in g["exchanges"]:
            n = len(json.dumps(ex))
            if size + n > budget and (out or kept):
                omitted += 1
                continue
            kept.append(ex)
            size += n
        if not kept:
            continue
        g["exchanges"] = kept
        size += len(json.dumps({k: v for k, v in g.items() if k != "exchanges"}))
        out.append(g)
    result = {"results": out,
              "how_to_read": "Each group is one branch of one chat (or the shared trunk "
                             "above a fork). Call read_turn_context with a turn_id to read "
                             "the turns around it."}
    if omitted:
        result["omitted_exchanges"] = omitted
    return result


def read_turn_context(conn, turn_id: int, before: Optional[int] = None,
                      after: Optional[int] = None) -> Dict:
    """The turns around one turn: `before` back toward the root, `after`
    forward up to the next fork (never past it). Committed turns only."""
    cfg = _cfg()
    before = max(0, min(int(before if before is not None else cfg.get("context_before", 6)), 30))
    after = max(0, min(int(after if after is not None else cfg.get("context_after", 6)), 30))
    ch = _Chats(conn)
    root = ch.root(turn_id)
    shape = ch.shape(root)
    if shape is None or turn_id not in shape.nodes:
        return {"error": f"turn {turn_id} is not a turn in any chat (unknown or discarded)"}
    path = shape.path(turn_id)
    back = path[max(0, len(path) - 1 - before):-1]
    forward, cur = [], turn_id
    while len(forward) < after and len(shape.children[cur]) == 1:
        cur = shape.children[cur][0]
        forward.append(cur)
    contents = ch.contents(back + [turn_id] + forward)
    cap = cfg.get("context_turn_chars", 1500)

    def turn(i):
        c = contents[i]
        t = {"turn_id": i, "role": c["role"], "date": c["date"],
             "text": _clip(c["content"], cap)}
        if i == turn_id:
            t["this_turn"] = True
        return t

    out = {"chat": ch.name(root), "chat_id": root,
           "date": contents[turn_id]["date"],
           **branch_context(ch, root, turn_id),
           "earlier_turns_not_shown": len(path) - 1 - len(back),
           "turns": [turn(i) for i in back + [turn_id] + forward]}
    kids = shape.children[cur]
    if len(kids) > 1:
        out["fork"] = {
            "after_turn_id": cur,
            "branches": _branches_at(ch, root, cur),
            "next": "The conversation forks here. Nothing past the fork is shown: "
                    "pick a branch and call read_turn_context with its turn_id."}
    elif kids:
        out["more_after"] = ("The branch continues; call read_turn_context with the "
                             "last turn_id shown to read further.")
    else:
        out["end_of_branch"] = True
    return out


def note_extras(conn, notes: List[Dict]) -> None:
    """Add to each note hit its backlinks (count + the most recent few) and
    the chat it was distilled from (via source_turns), in place."""
    import notes_index
    shown = _cfg().get("backlinks_shown", 3)
    incoming: Dict[str, List[tuple]] = {}
    for n in notes_index.list_notes(conn):
        for target in n.get("links") or []:
            incoming.setdefault(target.lower(), []).append(
                (n.get("created") or "", n["title"]))
    ch = _Chats(conn)
    for note in notes:
        links = sorted(incoming.get(note["title"].lower(), []), reverse=True)
        note["backlinks"] = {"count": len(links), "recent": [t for _, t in links[:shown]]}
        note["from_chat"] = None
        for tid in note.get("source_turns") or []:
            try:
                tid = int(tid)
            except (TypeError, ValueError):
                continue
            if conn.execute("SELECT 1 FROM turns WHERE id = ?", (tid,)).fetchone():
                root = ch.root(tid)
                note["from_chat"] = {"chat_id": root, "chat": ch.name(root),
                                     "turn_id": tid}
                break
