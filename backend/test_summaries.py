"""Tests for branch summaries and chat overviews (summaries.py): what counts
as a branch, rolling updates, staleness, overviews for forked chats, the card,
titles, the job's gates, and labels on the tree."""

import json
import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
import config
import db
import summaries


def _db():
    path = os.path.join(tempfile.mkdtemp(), "conversations.db")
    conn = sqlite3.connect(path)
    db.ensure_conversation_schema(conn)
    conn.close()
    return path


class Fake:
    """Recording generators: every summary names the turns it saw."""

    def __init__(self):
        self.branch_calls, self.overview_calls, self.title_calls = [], [], []

    def branch(self, previous, turns, note, vocab=None):
        self.branch_calls.append({"previous": previous,
                                  "turns": [t["content"] for t in turns], "note": note})
        seen = [t["content"] for t in turns]
        text = " | ".join(([previous] if previous else []) + seen) or previous
        return {"summary": text, "label": f"L{len(self.branch_calls)}", "tags": ["Garden"]}

    def overview(self, branches, vocab=None):
        self.overview_calls.append(branches)
        return {"summary": "OVERVIEW " + " / ".join(b["label"] for b in branches),
                "tags": ["project"]}

    def title(self, turns):
        self.title_calls.append([t["content"] for t in turns])
        return "A title"

    def hooks(self):
        return summaries.Hooks(self.branch, self.overview, self.title,
                               lambda conn: [], lambda tags, current: [t.lower() for t in tags])


def _turn(path, role, content, parent=None, committed=True):
    conn = sqlite3.connect(path)
    t = db.create_turn(conn, None, role, content, parent_turn_id=parent, committed=committed)
    conn.close()
    return t["id"]


def _chain(path, contents, parent=None):
    ids = []
    for i, c in enumerate(contents):
        parent = _turn(path, "user" if i % 2 == 0 else "assistant", c, parent)
        ids.append(parent)
    return ids


def _rows(path):
    conn = sqlite3.connect(path)
    try:
        return {r[0]: (r[1], r[2]) for r in conn.execute(
            "SELECT leaf_turn_id, path_turns, text FROM branch_summaries").fetchall()}
    finally:
        conn.close()


def _card(path, root):
    conn = sqlite3.connect(path)
    try:
        return db.get_chat_summary(conn, root), db.get_turn_title_state(conn, root)
    finally:
        conn.close()


def test_single_line_chat_gets_one_summary_card_and_title():
    path, fake = _db(), Fake()
    ids = _chain(path, ["u1", "a1", "u2", "a2"])
    stats = summaries.reconcile_chat(path, ids[0], fake.hooks())
    assert stats == {"branches": 1, "overview": False, "title": True, "card": True}
    assert _rows(path) == {ids[-1]: (4, "u1 | a1 | u2 | a2")}
    assert "no branches" in fake.branch_calls[0]["note"]
    card, title = _card(path, ids[0])
    assert card["text"] == "u1 | a1 | u2 | a2" and card["turns"] == 4
    assert card["proposed_tags"] == ["garden"]
    assert title == ("A title", 4)
    assert fake.overview_calls == []

    # Fresh: nothing to do, no calls.
    summaries.reconcile_chat(path, ids[0], fake.hooks())
    assert len(fake.branch_calls) == 1 and len(fake.title_calls) == 1


def test_growth_rolls_forward_and_rekeys():
    path, fake = _db(), Fake()
    ids = _chain(path, ["u1", "a1"])
    summaries.reconcile_chat(path, ids[0], fake.hooks())
    more = _chain(path, ["u2", "a2"], parent=ids[-1])
    summaries.reconcile_chat(path, ids[0], fake.hooks())
    last = fake.branch_calls[-1]
    assert last["previous"] == "u1 | a1" and last["turns"] == ["u2", "a2"]
    # One row, now keyed by the new leaf, covering the whole path.
    assert _rows(path) == {more[-1]: (4, "u1 | a1 | u2 | a2")}


def test_long_branch_is_folded_in_chunks():
    path, fake = _db(), Fake()
    cfg = config.get_config()
    old = dict(cfg.get("summaries") or {})
    cfg.setdefault("summaries", {})["chunk_chars"] = 50
    try:
        ids = _chain(path, [f"turn {i} " + "x" * 20 for i in range(6)])
        summaries.reconcile_chat(path, ids[0], fake.hooks())
    finally:
        cfg["summaries"] = old
    assert len(fake.branch_calls) == 6
    assert fake.branch_calls[0]["previous"] is None
    assert fake.branch_calls[3]["previous"].count("turn") == 3   # chained
    assert _rows(path)[ids[-1]][1].count("turn") == 6           # nothing dropped


def test_fork_summarizes_both_branches_and_builds_overview():
    path, fake = _db(), Fake()
    trunk = _chain(path, ["u1", "a1", "u2", "a2"])
    summaries.reconcile_chat(path, trunk[0], fake.hooks())
    # Fork from a1: a second branch.
    side = _chain(path, ["s1", "sa1"], parent=trunk[1])
    fake.branch_calls.clear()
    stats = summaries.reconcile_chat(path, trunk[0], fake.hooks())
    assert stats["branches"] == 2 and stats["overview"] is True

    by_note = {tuple(c["turns"]): c for c in fake.branch_calls}
    # The old branch is stale only because a fork appeared: rewritten from
    # its own summary with no new turns.
    old = by_note[()]
    assert old["previous"] == "u1 | a1 | u2 | a2"
    # The new branch covers the whole path from the root, nothing else.
    new = by_note[("u1", "a1", "s1", "sa1")]
    assert new["previous"] is None
    for call in (old, new):
        assert "2 branches" in call["note"] and "a1" in call["note"]

    rows = _rows(path)
    assert set(rows) == {trunk[-1], side[-1]}
    card, title = _card(path, trunk[0])
    assert card["text"].startswith("OVERVIEW") and card["proposed_tags"] == ["project"]
    assert fake.title_calls[-1] == [card["text"]]                # title from the overview
    assert title[0] == "A title"
    assert [b["split_after"].startswith("(assistant) a1") for b in fake.overview_calls[0]] == [True, True]

    # Fresh again: nothing regenerates.
    n_b, n_o = len(fake.branch_calls), len(fake.overview_calls)
    summaries.reconcile_chat(path, trunk[0], fake.hooks())
    assert (len(fake.branch_calls), len(fake.overview_calls)) == (n_b, n_o)

    # One branch grows: only it and the overview are redone.
    _chain(path, ["s2"], parent=side[-1])
    summaries.reconcile_chat(path, trunk[0], fake.hooks())
    assert len(fake.branch_calls) == n_b + 1
    assert fake.branch_calls[-1]["turns"] == ["s2"]
    assert len(fake.overview_calls) == n_o + 1


def test_discarded_turn_resummarizes_from_scratch():
    path, fake = _db(), Fake()
    ids = _chain(path, ["u1", "a1", "u2", "a2"])
    summaries.reconcile_chat(path, ids[0], fake.hooks())
    conn = sqlite3.connect(path)
    db.update_turn_committed(conn, ids[2], False)               # discard u2
    conn.close()
    summaries.reconcile_chat(path, ids[0], fake.hooks())
    last = fake.branch_calls[-1]
    assert last["previous"] is None and last["turns"] == ["u1", "a1", "a2"]
    assert _rows(path) == {ids[-1]: (3, "u1 | a1 | a2")}


def test_unforking_drops_the_overview():
    path, fake = _db(), Fake()
    trunk = _chain(path, ["u1", "a1", "u2", "a2"])
    side = _chain(path, ["s1", "sa1"], parent=trunk[1])
    summaries.reconcile_chat(path, trunk[0], fake.hooks())
    conn = sqlite3.connect(path)
    assert summaries.get_overview(conn, trunk[0]) is not None
    db.delete_turn(conn, side[0], subtree=True)
    conn.close()
    summaries.reconcile_chat(path, trunk[0], fake.hooks())
    conn = sqlite3.connect(path)
    assert summaries.get_overview(conn, trunk[0]) is None
    conn.close()
    assert set(_rows(path)) == {trunk[-1]}
    assert _card(path, trunk[0])[0]["text"].startswith("u1")


def test_failure_writes_nothing():
    path, fake = _db(), Fake()
    ids = _chain(path, ["u1", "a1"])
    hooks = fake.hooks()
    hooks.branch_summary = lambda *a: {"summary": "", "label": "", "tags": []}
    try:
        summaries.reconcile_chat(path, ids[0], hooks)
        assert False, "expected SummaryError"
    except summaries.SummaryError:
        pass
    assert _rows(path) == {} and _card(path, ids[0])[0] is None


def _age(path, minutes):
    conn = sqlite3.connect(path)
    conn.execute(f"UPDATE turns SET created_at = datetime('now', '-{minutes} minutes')")
    conn.commit()
    conn.close()


def test_job_gates_on_idle_and_exchanges_and_cleans_up():
    path, fake = _db(), Fake()
    short = _chain(path, ["only", "one"])                        # 1 exchange
    seed = _chain(path, ["u1", "a1", "u2", "a2"])                # a seed, 2 exchanges
    _age(path, 30)
    busy = _chain(path, ["b1", "ba1", "b2", "ba2"])              # just now
    conn = sqlite3.connect(path)
    conn.execute("INSERT INTO branch_summaries VALUES (99999, 1, NULL, 1, '[]', 'x', "
                 "'gone', NULL, 'now')")
    conn.commit()
    conn.close()

    stats = summaries.run_once(path, fake.hooks(), log=lambda *_: None)
    assert stats == {"chats": 1, "failed": 0, "removed": 1}
    assert set(_rows(path)) == {seed[-1]}
    assert _card(path, short[0])[0] is None and _card(path, busy[0])[0] is None

    # Nothing stale: the next pass does nothing.
    assert summaries.run_once(path, fake.hooks(), log=lambda *_: None)["chats"] == 0


def test_job_keeps_going_past_a_failing_chat():
    path, fake = _db(), Fake()
    a = _chain(path, ["u1", "a1", "u2", "a2"])
    b = _chain(path, ["v1", "b1", "v2", "b2"])
    _age(path, 30)
    hooks = fake.hooks()
    real = hooks.branch_summary
    def flaky(previous, turns, note, vocab=None):
        if turns and turns[0]["content"] == "u1":
            raise RuntimeError("model down")
        return real(previous, turns, note, vocab)
    hooks.branch_summary = flaky
    logs = []
    stats = summaries.run_once(path, hooks, log=logs.append)
    assert stats["chats"] == 1 and stats["failed"] == 1 and "model down" in logs[0]
    assert set(_rows(path)) == {b[-1]}


def test_tree_labels_mark_where_branches_start():
    path, fake = _db(), Fake()
    trunk = _chain(path, ["u1", "a1", "u2", "a2"])
    side = _chain(path, ["s1", "sa1"], parent=trunk[1])
    summaries.reconcile_chat(path, trunk[0], fake.hooks())
    conn = sqlite3.connect(path)
    roots = db.get_turn_tree(conn)
    summaries.attach_labels(conn, roots)
    labels = {r[0]: r[1] for r in conn.execute(
        "SELECT leaf_turn_id, label FROM branch_summaries").fetchall()}
    conn.close()
    a1 = roots[0]["children"][0]
    by_id = {k["id"]: k for k in a1["children"]}
    assert by_id[trunk[2]]["label"] == labels[trunk[-1]]
    assert by_id[side[0]]["label"] == labels[side[-1]]
    assert "label" not in roots[0] and "label" not in a1


def test_per_reply_title_leaves_forked_chats_to_the_job(monkeypatch):
    d = tempfile.mkdtemp()
    os.environ["DB_PATH"] = os.path.join(d, "conversations.db")
    config.get_config._config = config.load_config()
    import importlib, main
    importlib.reload(db)
    importlib.reload(main)
    path = os.environ["DB_PATH"]
    conn = sqlite3.connect(path)
    db.ensure_conversation_schema(conn)
    conn.close()
    trunk = _chain(path, ["u1", "a1", "u2", "a2"])
    side = _chain(path, ["s1", "sa1"], parent=trunk[1])
    calls = []
    monkeypatch.setattr(main, "generate_title", lambda turns: calls.append(turns) or "T")
    assert main._maybe_update_title(path, side[-1]) == (trunk[0], None)
    assert calls == []
    # Forced (the regenerate button) on a forked chat with an overview: the overview.
    conn = sqlite3.connect(path)
    conn.execute("INSERT INTO chat_overviews VALUES (?, 'OV', NULL, '[]', 'now')", (trunk[0],))
    conn.commit()
    conn.close()
    assert main._maybe_update_title(path, side[-1], force=True) == (trunk[0], "T")
    assert calls[-1] == [{"role": "overview", "content": "OV"}]
