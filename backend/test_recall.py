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


def test_recall_flow_emits_event_and_feeds_context():
    path = os.environ["DB_PATH"]
    # Seed an embedded memory.
    conn = sqlite3.connect(path)
    mem = db.create_turn(conn, None, "assistant", "we chose SQLite for persistence")
    db.set_turn_embedding(conn, mem["id"], [1.0, 0.0])
    conn.close()

    # Mock LM Studio: embeddings, synthesis, and token stream.
    main.get_embedding = lambda text: [1.0, 0.0]
    main.synthesize_recall = lambda query, matches: "MEMORY: " + matches[0]["text"]
    captured = {}
    def fake_stream(message, context_turns=None, mode=None, recall=None):
        captured["recall"] = recall
        yield "ok"
    main.stream_llm_tokens = fake_stream

    c = TestClient(main.app)
    r = c.post("/api/messages", json={"message": "what db did we pick?", "recall": True})
    assert '"type": "recall"' in r.text                       # recall streamed to UI
    assert captured["recall"].startswith("MEMORY:")           # recall fed into context

    cur = c.get("/api/recall/current").json()["recall"]
    assert cur and cur["content"].startswith("MEMORY:")       # stored as current block
    assert any(s["turn_id"] == mem["id"] for s in cur["sources"])  # found our memory

    # Disabled by default (no recall flag, config off) -> no recall event.
    captured.clear()
    r2 = c.post("/api/messages", json={"message": "hi"})
    assert '"type": "recall"' not in r2.text
    print("✓ recall flow: event + context + current block; off by default")


if __name__ == "__main__":
    test_search_ranking_and_tag_boosts()
    test_tags_endpoint()
    test_recall_flow_emits_event_and_feeds_context()
    print("\n✓ All recall tests passed!")
