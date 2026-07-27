"""Tests for recall: cosine search + tag boosts, tags endpoint, and the send-flow.

LM Studio (embeddings + synthesis) is mocked; the cosine math runs for real.
"""

import os
import json
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def test_search_ranking_and_tag_boosts():
    path = os.environ["DB_PATH"]
    conn = sqlite3.connect(path)
    a = db.create_turn(conn, None, "user", "cats are great")
    b = db.create_turn(conn, None, "assistant", "dogs are loyal")
    db.set_turn_embedding(conn, a["id"], [1.0, 0.0])
    db.set_turn_embedding(conn, b["id"], [0.0, 1.0])

    # Query aligned with 'a' -> a ranks first.
    res = db.search_similar_turns(conn, [1.0, 0.0], limit=10)
    assert res[0]["turn_id"] == a["id"]
    assert res[0]["branch_root_id"] == a["id"]   # a is its own root

    # A strong tag boost on the less-similar 'b' flips the ranking.
    db.update_turn_tags(conn, b["id"], add=["decision"])
    res2 = db.search_similar_turns(conn, [0.8, 0.2], limit=10, tag_boosts={"decision": 5.0})
    assert res2[0]["turn_id"] == b["id"]
    conn.close()
    print("✓ cosine ranking + tag boosts")


def test_tags_endpoint():
    path = os.environ["DB_PATH"]
    conn = sqlite3.connect(path)
    t = db.create_turn(conn, None, "user", "taggable")
    conn.close()
    c = TestClient(main.app)
    r = c.patch(f"/api/turns/{t['id']}/tags", json={"add_tags": ["decision", "concept"]})
    assert r.status_code == 200 and set(r.json()["tags"]) == {"decision", "concept"}
    r = c.patch(f"/api/turns/{t['id']}/tags", json={"remove_tags": ["decision"]})
    assert r.json()["tags"] == ["concept"]
    assert c.patch("/api/turns/999999/tags", json={"add_tags": ["x"]}).status_code == 404
    print("✓ tags endpoint add/remove + 404")


def test_keyword_search():
    """Lexical search ranks by term overlap and returns branch metadata."""
    main2, db2 = None, db
    conn = sqlite3.connect(os.environ["DB_PATH"])
    a = db.create_turn(conn, None, "user", "the database migration plan")
    b = db.create_turn(conn, None, "assistant", "unrelated content about weather")
    res = db.search_keyword_turns(conn, "database migration", limit=10)
    conn.close()
    assert res and res[0]["turn_id"] == a["id"]
    assert all(r["turn_id"] != b["id"] for r in res)   # no term overlap -> excluded
    assert res[0]["branch_root_id"] == a["id"]
    print("✓ keyword search ranks by term overlap")


def test_search_excludes_context_ids():
    """Both searches skip turns already in the context window (exclude_ids)."""
    conn = sqlite3.connect(os.environ["DB_PATH"])
    a = db.create_turn(conn, None, "user", "kubernetes deployment topic alpha")
    b = db.create_turn(conn, None, "assistant", "kubernetes deployment topic beta")
    db.set_turn_embedding(conn, a["id"], [0.0, 1.0])
    db.set_turn_embedding(conn, b["id"], [0.0, 1.0])

    kw = db.search_keyword_turns(conn, "kubernetes deployment", limit=10, exclude_ids=[a["id"]])
    assert all(r["turn_id"] != a["id"] for r in kw) and any(r["turn_id"] == b["id"] for r in kw)

    sem = db.search_similar_turns(conn, [0.0, 1.0], limit=10, exclude_ids=[a["id"]])
    assert all(r["turn_id"] != a["id"] for r in sem) and any(r["turn_id"] == b["id"] for r in sem)
    conn.close()
    print("✓ keyword + semantic search exclude context-window ids")


def _scripted_stream(rounds):
    """Return a fake inference._iter_stream_events driven by a list of per-round
    delta lists. Each delta is a dict yielded as (choice, delta)."""
    calls = {"i": 0}
    def fake(payload):
        idx = calls["i"]
        calls["i"] += 1
        deltas = rounds[idx] if idx < len(rounds) else []
        for d in deltas:
            yield ({}, d)
    return fake


def test_tools_flag_precedence():
    """`tools` gates the tool loop; `recall` is only a deprecated alias."""
    cfg = config.get_config()["tools"]
    orig = cfg.get("enabled", False)
    cfg["enabled"] = False
    try:
        assert main._tools_enabled(True, None) is True
        assert main._tools_enabled(False, True) is False      # tools beats recall
        assert main._tools_enabled(None, True) is True        # legacy alias honored
        assert main._tools_enabled(None, False) is False
        assert main._tools_enabled(None, None) is False       # server default (off)
        cfg["enabled"] = True
        assert main._tools_enabled(None, None) is True        # server default (on)
        assert main._tools_enabled(False, None) is False      # explicit off wins
    finally:
        cfg["enabled"] = orig
    print("✓ tools flag precedence: tools > recall (deprecated) > config default")


def test_semantic_fire_always_leaves_recall_block():
    """recall_semantic without synthesize still persists + streams a recall block."""
    import inference, json as _json
    conn = sqlite3.connect(os.environ["DB_PATH"])
    mem = db.create_turn(conn, None, "user", "the chronicle idea: track thoughts over time")
    db.set_turn_embedding(conn, mem["id"], [1.0, 0.0])
    conn.close()
    main.get_embedding = lambda text: [1.0, 0.0]

    # Round 1: semantic recall. Round 2: final answer — NO synthesize call.
    rounds = [
        [{"tool_calls": [{"index": 0, "id": "1", "type": "function",
                          "function": {"name": "recall_semantic", "arguments": ""}}]},
         {"tool_calls": [{"index": 0, "function": {"arguments": "{\"query\":\"chronicle\"}"}}]}],
        [{"content": "You wanted to track thoughts over time."}],
    ]
    orig = inference._iter_stream_events
    inference._iter_stream_events = _scripted_stream(rounds)
    try:
        c = TestClient(main.app)
        r = c.post("/api/messages", json={"message": "what was the chronicle idea?",
                                          "tools": True})   # new flag, not `recall`
        events = [_json.loads(l[6:]) for l in r.text.splitlines() if l.startswith("data: ")]
        block = next(e for e in events if e["type"] == "recall_block")
        assert "semantic similarity" in block["content"] and "chronicle" in block["content"]
        assert any(s["turn_id"] == mem["id"] for s in block["sources"])

        done = next(e for e in events if e["type"] == "done")
        found = {}
        def walk(n):
            found[n["id"]] = n
            for ch in n["children"]:
                walk(ch)
        for root in c.get("/api/tree").json()["roots"]:
            walk(root)
        assert "semantic similarity" in found[done["user_turn_id"]]["recall"]["content"]

        # GET /api/recall/current is alive again (was null since the tool-loop migration).
        current = c.get("/api/recall/current").json()["recall"]
        assert current and "semantic similarity" in current["content"]
    finally:
        inference._iter_stream_events = orig
    print("✓ semantic fire w/o synthesize: recall_block streamed, persisted, current revived")


def test_tool_loop_end_to_end():
    """Model calls recall_semantic -> synthesize -> answers; block persists per-turn."""
    import inference, json as _json
    # Seed an embedded memory to retrieve.
    conn = sqlite3.connect(os.environ["DB_PATH"])
    mem = db.create_turn(conn, None, "assistant", "we chose SQLite for local persistence")
    db.set_turn_embedding(conn, mem["id"], [1.0, 0.0])
    conn.close()

    main.get_embedding = lambda text: [1.0, 0.0]
    main.synthesize = lambda kind, items, query="": "MEMORY: chose SQLite"

    # Round 1: call recall_semantic. Round 2: call synthesize. Round 3: final answer.
    rounds = [
        [{"tool_calls": [{"index": 0, "id": "1", "type": "function",
                          "function": {"name": "recall_semantic", "arguments": ""}}]},
         {"tool_calls": [{"index": 0, "function": {"arguments": "{\"query\":\"database\"}"}}]}],
        [{"tool_calls": [{"index": 0, "id": "2", "type": "function",
                          "function": {"name": "synthesize", "arguments": ""}}]},
         {"tool_calls": [{"index": 0, "function": {"arguments": "{\"kind\":\"memory\",\"items\":[\"x\"]}"}}]}],
        [{"content": "We chose "}, {"content": "SQLite."}],
    ]
    orig = inference._iter_stream_events
    inference._iter_stream_events = _scripted_stream(rounds)
    try:
        c = TestClient(main.app)
        # Tools on via per-request flag (config default is off).
        r = c.post("/api/messages", json={"message": "what db did we pick?", "recall": True})
        text = r.text
        assert '"type": "status"' in text                       # transparency note streamed
        assert '"type": "token"' in text and "SQLite." in text   # final answer streamed
        assert '"type": "recall"' not in text                    # old event is gone

        done = [_json.loads(l[6:]) for l in text.splitlines()
                if l.startswith("data: ") and '"done"' in l][0]

        # Synthesized block persisted on the triggering user turn.
        found = {}
        def walk(n):
            found[n["id"]] = n
            for ch in n["children"]:
                walk(ch)
        for root in c.get("/api/tree").json()["roots"]:
            walk(root)
        assert found[done["user_turn_id"]]["recall"]["content"] == "MEMORY: chose SQLite"
        assert any(s["turn_id"] == mem["id"] for s in found[done["user_turn_id"]]["recall"]["sources"])

        # Tools off by default: plain streaming, no status/tool events.
        inference._iter_stream_events = _scripted_stream([[{"content": "hi there"}]])
        # (plain path uses stream_llm_tokens, which we stub to avoid network)
        main.stream_llm_tokens = lambda *a, **k: iter(["plain"])
        r2 = c.post("/api/messages", json={"message": "hello"})
        assert '"type": "status"' not in r2.text and '"type": "token"' in r2.text
    finally:
        inference._iter_stream_events = orig
    print("✓ tool loop: recall_semantic -> synthesize -> answer; block persisted; off by default")


def test_embed_texts_backend_dispatch():
    """embed_texts uses local fastembed by default, or LM Studio when configured."""
    import inference
    import numpy as np
    orig_rc = inference._recall_config
    orig_post = inference.requests.post
    orig_embedder = inference._local_embedder
    try:
        # Local backend: inject a fake in-process embedder (no fastembed needed).
        class FakeEmbedder:
            def embed(self, texts):
                return [np.asarray([float(len(t)), 1.0], dtype="float32") for t in texts]
        inference._local_embedder = FakeEmbedder()
        inference._recall_config = lambda: {"embedding_backend": "local"}
        assert inference.embed_texts(["ab", "abc"]) == [[2.0, 1.0], [3.0, 1.0]]

        # LM Studio backend: mock the HTTP call; results must come back in input order.
        inference._recall_config = lambda: {"embedding_backend": "lmstudio", "embedding_model": "m"}
        class FakeResp:
            def raise_for_status(self): pass
            def json(self):
                return {"data": [{"index": 1, "embedding": [9.0]}, {"index": 0, "embedding": [8.0]}]}
        inference.requests.post = lambda *a, **k: FakeResp()
        assert inference.embed_texts(["x", "y"]) == [[8.0], [9.0]]
    finally:
        inference._recall_config = orig_rc
        inference.requests.post = orig_post
        inference._local_embedder = orig_embedder
    print("✓ embed_texts dispatch (local default + lmstudio, ordered)")


def test_synthesis_prompt_loads_from_file():
    """Synthesis prompt comes from a markdown file (file > inline string > default)."""
    import inference
    p = os.path.join(tempfile.mkdtemp(), "rp.md")
    with open(p, "w", encoding="utf-8") as f:
        f.write("CUSTOM SYNTH PROMPT")
    assert inference._load_recall_synthesis_prompt({"synthesis_prompt_file": p}) == "CUSTOM SYNTH PROMPT"
    # missing file -> built-in default
    assert inference._load_recall_synthesis_prompt(
        {"synthesis_prompt_file": "/nope/missing.md"}) == inference.DEFAULT_RECALL_SYNTHESIS_PROMPT
    # inline string still works as a fallback
    assert inference._load_recall_synthesis_prompt({"synthesis_system": "INLINE"}) == "INLINE"
    print("✓ synthesis prompt loads from file (file > string > default)")


if __name__ == "__main__":
    test_search_ranking_and_tag_boosts()
    test_tags_endpoint()
    test_keyword_search()
    test_search_excludes_context_ids()
    test_tool_loop_end_to_end()
    test_embed_texts_backend_dispatch()
    test_synthesis_prompt_loads_from_file()
    print("\n✓ All recall tests passed!")
