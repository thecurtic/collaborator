"""Tests for search (step 3 of the 2026-10-27 plan): FTS5 keyword search over
notes and turns, hybrid note search, and the context hits carry
(search_context.py): whole exchanges grouped by branch, read_turn_context,
note backlinks and source chats, and the result budget."""

import json
import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
import config
import db
import notes_index
import search_context


def _db():
    path = os.path.join(tempfile.mkdtemp(), "conversations.db")
    conn = sqlite3.connect(path)
    db.ensure_conversation_schema(conn)
    return path, conn


def _write(vault, title, body, tags=(), created="2026-10-01", extra=""):
    os.makedirs(vault, exist_ok=True)
    path = os.path.join(vault, f"{title}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"---\ncreated: {created}\ntags: [{', '.join(tags)}]\n{extra}---\n\n"
                f"# {title}\n\n{body}\n")
    return path


def _vault_db(notes, embed_fn=None):
    path, conn = _db()
    vault = os.path.join(os.path.dirname(path), "notes")
    for n in notes:
        notes_index.index_note_file(conn, _write(vault, *n), embed_fn=embed_fn)
    return conn, vault


def _titles(results):
    return [n["title"] for n in results]


# --- FTS5 keyword search ------------------------------------------------------------

def test_note_keyword_matches_whole_words_only():
    conn, _ = _vault_db([("Brush lettering", "Practice art every day."),
                         ("Morning routine", "Start the day with a walk.")])
    assert _titles(notes_index.search_notes_keyword(conn, "art")) == ["Brush lettering"]
    assert _titles(notes_index.search_notes_keyword(conn, "start")) == ["Morning routine"]
    # Stemming still joins word forms.
    assert _titles(notes_index.search_notes_keyword(conn, "practicing")) == ["Brush lettering"]


def test_turn_keyword_matches_whole_words_only():
    path, conn = _db()
    db.create_turn(conn, None, "user", "Let's start the garden")
    db.create_turn(conn, None, "user", "I love folk art")
    hits = db.search_keyword_turns(conn, "art")
    assert [h["text"] for h in hits] == ["I love folk art"]
    # Discarded turns are never found.
    t = db.create_turn(conn, None, "user", "art again", committed=False)
    assert all(h["turn_id"] != t["id"] for h in db.search_keyword_turns(conn, "art"))


def test_title_and_aliases_outrank_body():
    conn, _ = _vault_db([
        ("Sam", "A friend from the co-op.", ["social-graph"], "2026-10-01",
         "aliases: [Samwise]\n"),
        ("Co-op meeting", "Samwise said the budget is tight. Samwise again."),
    ])
    assert _titles(notes_index.search_notes_keyword(conn, "samwise"))[0] == "Sam"
    assert _titles(notes_index.search_notes_keyword(conn, "co-op"))[0] == "Co-op meeting"


def test_keyword_filters_run_in_sql():
    conn, _ = _vault_db([
        ("Beds face south", "Garden sun.", ["garden"], "2026-10-01"),
        ("Garden budget", "Garden money.", ["money"], "2026-09-01"),
        ("Work garden", "Office plants.", ["user-profile"], "2026-10-02", "area: work\n"),
    ])
    assert _titles(notes_index.search_notes_keyword(conn, "garden", tag="GARDEN")) == \
        ["Beds face south"]
    assert set(_titles(notes_index.search_notes_keyword(
        conn, "garden", created_from="2026-10-01"))) == {"Beds face south", "Work garden"}
    assert _titles(notes_index.search_notes_keyword(conn, "garden", area="work")) == \
        ["Work garden"]
    # Filters alone list everything that passes, by title.
    assert _titles(notes_index.search_notes_keyword(conn, "", created_to="2026-09-30")) == \
        ["Garden budget"]
    assert notes_index.search_notes_keyword(conn, "") == []


def test_rebuild_from_vault_gives_identical_results():
    notes = [("Beds face south", "Sun matters for [[Tomatoes]].", ["garden"]),
             ("Tomatoes", "Stake them early. Garden beds.", ["garden"]),
             ("Sam", "Friend.", ["social-graph"], "2026-10-01", "aliases: [Samwise]\n")]
    conn, vault = _vault_db(notes)
    # Edit one note in place (as Obsidian would) and re-index it incrementally.
    _write(vault, "Tomatoes", "Stake them early. Garden beds and sun.", ["garden"])
    notes_index.index_note_file(conn, os.path.join(vault, "Tomatoes.md"))
    queries = ["garden", "sun", "samwise", "stake early", "beds"]
    before = {q: [(n["title"], round(n["score"], 6))
                  for n in notes_index.search_notes_keyword(conn, q)] for q in queries}

    # A fresh DB rebuilt from the files alone.
    path2, conn2 = _db()
    notes_index.reindex_vault(conn2, vault, ensure_user=False)
    after = {q: [(n["title"], round(n["score"], 6))
                 for n in notes_index.search_notes_keyword(conn2, q)] for q in queries}
    assert before == after and all(before.values())

    # And rebuilding in place changes nothing either.
    notes_index.reindex_vault(conn, vault, ensure_user=False)
    again = {q: [(n["title"], round(n["score"], 6))
                 for n in notes_index.search_notes_keyword(conn, q)] for q in queries}
    assert again == before


# --- Hybrid -------------------------------------------------------------------------

def test_hybrid_finds_an_exact_name_semantic_misses():
    # Embeddings: the query points along x; "Quillon" (the exact name asked
    # for) points along y, so semantic ranks it last.
    vectors = {"Quillon": [0.0, 1.0], }
    def embed(texts):
        return [vectors.get(t.split("\n")[0], [1.0, 0.1]) for t in texts]
    notes = [(f"Sword note {i}", f"Blades and hilts, part {i}.") for i in range(6)]
    notes.append(("Quillon", "The crossguard piece."))
    conn, _ = _vault_db(notes, embed_fn=embed)
    q = [1.0, 0.0]
    semantic = _titles(notes_index.search_notes_semantic(conn, q, limit=3))
    assert "Quillon" not in semantic
    hybrid = _titles(notes_index.search_notes_hybrid(conn, "quillon", q, limit=3))
    assert hybrid[0] == "Quillon"
    # No vector (embedding failed): keyword alone.
    assert _titles(notes_index.search_notes_hybrid(conn, "quillon", None, limit=3)) == \
        ["Quillon"]


# --- Hits with context --------------------------------------------------------------

def _chain(conn, contents, parent=None):
    ids = []
    for i, c in enumerate(contents):
        parent = db.create_turn(conn, None, "user" if i % 2 == 0 else "assistant", c,
                                parent_turn_id=parent)["id"]
        ids.append(parent)
    return ids


def _summary(conn, leaf, root, label, text, path_turns=1):
    conn.execute("INSERT INTO branch_summaries VALUES (?, ?, NULL, ?, '[]', ?, ?, '[]', 'now')",
                 (leaf, root, path_turns, label, text))
    conn.commit()


def _forked_chat(conn):
    """root: u1 -> a1 -> (u2 -> a2 "pricing") | (s1 -> sa1 "hiring")."""
    trunk = _chain(conn, ["How do we grow the shop?", "Two options: price or people."])
    main = _chain(conn, ["Tell me about pricing", "Raise prices on the tier."], trunk[-1])
    side = _chain(conn, ["What about hiring?", "Hire a part-timer for weekends."], trunk[-1])
    _summary(conn, main[-1], trunk[0], "Pricing route", "Chose to raise prices. More after.")
    _summary(conn, side[-1], trunk[0], "Hiring route", "Weighed a part-timer. Then more.")
    conn.execute("INSERT INTO chat_overviews VALUES (?, 'Shop growth: pricing vs hiring.', "
                 "'[]', '[]', 'now')", (trunk[0],))
    conn.execute("UPDATE turns SET name = 'Shop growth' WHERE id = ?", (trunk[0],))
    conn.commit()
    return trunk, main, side


def test_turn_hits_are_whole_exchanges_grouped_by_branch():
    path, conn = _db()
    trunk, main, side = _forked_chat(conn)
    # Hits: the pricing reply and its question (one exchange), the hiring
    # question, and the shared opening.
    matches = [{"turn_id": main[1], "score": 3.0}, {"turn_id": main[0], "score": 2.5},
               {"turn_id": side[0], "score": 2.0}, {"turn_id": trunk[1], "score": 1.0}]
    out = search_context.turn_hits(conn, matches)
    groups = out["results"]
    assert len(groups) == 3

    pricing = groups[0]
    assert pricing["chat"] == "Shop growth" and pricing["where"] == "branch"
    assert pricing["branch_label"] == "Pricing route"
    assert pricing["branch_summary"].startswith("Chose to raise prices")
    assert "Hiring route" in pricing["sibling_branches"]
    assert len(pricing["exchanges"]) == 1                 # question + reply deduped
    ex = pricing["exchanges"][0]
    assert ex["user"] == "Tell me about pricing" and ex["assistant"] == "Raise prices on the tier."
    assert ex["date"] and "alternatives" in pricing

    hiring = groups[1]
    assert hiring["branch_label"] == "Hiring route"
    assert hiring["exchanges"][0]["assistant"] == "Hire a part-timer for weekends."

    shared = groups[2]
    assert shared["where"] == "shared_trunk"
    assert shared["chat_overview"].startswith("Shop growth")
    below = {b["label"]: b for b in shared["branches_below"]}
    assert set(below) == {"Pricing route", "Hiring route"}
    assert below["Hiring route"]["turn_id"] == side[0]
    assert below["Pricing route"]["gist"] == "Chose to raise prices."
    assert shared["exchanges"][0]["user"] == "How do we grow the shop?"


def test_single_line_chat_has_no_sibling_talk():
    path, conn = _db()
    ids = _chain(conn, ["Plan the garden", "Beds face south."])
    _summary(conn, ids[-1], ids[0], "Garden plan", "Beds face south.", 2)
    g = search_context.turn_hits(conn, [{"turn_id": ids[0], "score": 1.0}])["results"][0]
    assert g["where"] == "branch" and "sibling_branches" not in g
    assert "alternatives" not in g


def test_many_hits_from_one_long_chat_stay_under_budget():
    path, conn = _db()
    ids = _chain(conn, [("question %d " % i) + "q" * 3000 if i % 2 == 0
                        else ("answer %d " % i) + "a" * 6000 for i in range(80)])
    _summary(conn, ids[-1], ids[0], "Long one", "S" * 5000, 80)
    matches = [{"turn_id": t, "score": 100.0 - i} for i, t in enumerate(ids)]
    out = search_context.turn_hits(conn, matches)
    text = json.dumps(out)
    budget = config.get_config()["search"]["max_result_chars"]
    assert len(text) <= budget + 2000                     # exchanges capped; header slack
    assert len(out["results"]) == 1                       # one branch, summary once
    assert text.count("SSSS") and len(out["results"][0]["branch_summary"]) <= 701
    assert out["omitted_exchanges"] > 0
    ex = out["results"][0]["exchanges"][0]
    assert len(ex["user"]) + len(ex["assistant"]) <= 905   # per-hit cap


def test_read_turn_context_reads_back_and_stops_at_the_fork():
    path, conn = _db()
    trunk, main, side = _forked_chat(conn)
    out = search_context.read_turn_context(conn, trunk[0], before=3, after=6)
    assert [t["turn_id"] for t in out["turns"]] == trunk           # forward stops at fork
    assert out["turns"][0]["this_turn"] is True
    assert out["where"] == "shared_trunk"
    assert out["fork"]["after_turn_id"] == trunk[1]
    assert {b["turn_id"] for b in out["fork"]["branches"]} == {main[0], side[0]}
    assert "pick a branch" in out["fork"]["next"]

    # Into a branch: back to the root, its label and summary, end of branch.
    out = search_context.read_turn_context(conn, side[0], before=6, after=6)
    assert [t["turn_id"] for t in out["turns"]] == trunk + side
    assert out["branch_label"] == "Hiring route" and out["end_of_branch"] is True
    assert out["chat"] == "Shop growth" and out["date"]

    # A narrow window says how much is left out, and that the branch goes on.
    out = search_context.read_turn_context(conn, main[0], before=1, after=0)
    assert [t["turn_id"] for t in out["turns"]] == [trunk[1], main[0]]
    assert out["earlier_turns_not_shown"] == 1 and "more_after" in out


def test_read_turn_context_skips_discarded_turns():
    path, conn = _db()
    ids = _chain(conn, ["u1", "a1", "u2", "a2"])
    db.update_turn_committed(conn, ids[1], False)
    out = search_context.read_turn_context(conn, ids[3])
    assert [t["turn_id"] for t in out["turns"]] == [ids[0], ids[2], ids[3]]
    assert "error" in search_context.read_turn_context(conn, ids[1])
    assert "error" in search_context.read_turn_context(conn, 99999)


def test_note_hits_gain_backlinks_and_source_chat():
    conn, vault = _vault_db([("Tomatoes", "Stake early."),
                             ("Beds", "See [[Tomatoes]].", (), "2026-10-02"),
                             ("Soil", "Feeds [[tomatoes]].", (), "2026-10-05"),
                             ("Sun", "Helps [[Tomatoes]].", (), "2026-09-01")])
    root = db.create_turn(conn, None, "user", "Talk about tomatoes")["id"]
    conn.execute("UPDATE notes_index SET source_turns = ? WHERE title = 'Tomatoes'",
                 (json.dumps([root]),))
    conn.commit()
    hits = notes_index.search_notes_keyword(conn, "tomatoes stake")
    search_context.note_extras(conn, hits)
    tom = next(n for n in hits if n["title"] == "Tomatoes")
    assert tom["backlinks"] == {"count": 3, "recent": ["Soil", "Beds", "Sun"]}
    assert tom["from_chat"]["chat_id"] == root
    assert tom["from_chat"]["chat"] == "Talk about tomatoes"


# --- The tools ----------------------------------------------------------------------

def _main(monkeypatch):
    d = tempfile.mkdtemp()
    os.environ["DB_PATH"] = os.path.join(d, "conversations.db")
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(d, "vault")
    config.get_config._config = cfg
    import importlib, main
    importlib.reload(db)
    importlib.reload(main)
    conn = sqlite3.connect(os.environ["DB_PATH"])
    db.ensure_conversation_schema(conn)
    return main, conn


def test_tools_return_context(monkeypatch):
    main, conn = _main(monkeypatch)
    trunk, main_ids, side = _forked_chat(conn)
    schemas, execute, state = main._build_tools(os.environ["DB_PATH"])
    names = {s["function"]["name"] for s in schemas}
    assert "read_turn_context" in names

    out = json.loads(execute("recall_keyword", {"query": "hiring"}))
    assert out["results"][0]["branch_label"] == "Hiring route"
    assert state["last_matches"]                          # synthesis still sees raw hits

    out = json.loads(execute("read_turn_context", {"turn_id": trunk[0]}))
    assert out["fork"]["branches"]
    assert "error" in json.loads(execute("read_turn_context", {"turn_id": "x"}))

    # search_notes defaults to hybrid; a failed embedding falls back to keyword.
    vault = config.get_config()["notes"]["vault_dir"]
    notes_index.index_note_file(conn, _write(vault, "Quillon", "Crossguard."))
    def boom(text):
        raise RuntimeError("embedder down")
    monkeypatch.setattr(main, "get_embedding", boom)
    out = json.loads(execute("search_notes", {"query": "quillon"}))
    assert out[0]["title"] == "Quillon"
    assert out[0]["backlinks"] == {"count": 0, "recent": []} and out[0]["from_chat"] is None
