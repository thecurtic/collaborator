"""Tests for scratch (notes-to-self): inert capture, media store, secret guard,
agent isolation, and the one-shot hold-send action grammar."""

import io
import json
import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, scratch, inference, notes_index
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def _fresh():
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(tempfile.mkdtemp(), "vault")
    cfg["notes"]["bootstrap_user_note"] = False
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), cfg, path


def test_inert_capture_and_kinds():
    c, cfg, dbp = _fresh()
    # Capturing must invoke NO model — poison the embedder to prove it.
    main.get_embedding = lambda text: (_ for _ in ()).throw(
        AssertionError("no model may run on inert capture"))

    r = c.post("/api/scratch", json={"content": "bring ladder to Sam's"})
    assert r.status_code == 200 and r.json()["item"]["kind"] == "text"
    assert r.json()["item"]["status"] == "inert"
    assert r.json()["item"]["llm_readable"] is False

    r = c.post("/api/scratch", json={"content": "https://example.com/read"})
    assert r.json()["item"]["kind"] == "url"

    # A Bitcoin address passes through inert, untouched, listable, copyable.
    btc = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
    r = c.post("/api/scratch", json={"content": btc})
    assert r.status_code == 200 and r.json()["item"]["status"] == "inert"

    listing = c.get("/api/scratch").json()
    assert listing["count"] == 3
    assert listing["items"][0]["content"] == btc          # newest first
    # Search over content.
    hits = c.get("/api/scratch", params={"q": "ladder"}).json()["items"]
    assert len(hits) == 1 and "ladder" in hits[0]["content"]
    assert c.post("/api/scratch", json={"content": "  "}).status_code == 422
    print("✓ inert capture: kinds, search, zero model involvement")


def test_media_content_addressed_store():
    c, cfg, dbp = _fresh()
    data = b"\x89PNG\r\n\x1a\nfakepng"
    r = c.post("/api/scratch/media",
               files={"file": ("wall.png", io.BytesIO(data), "image/png")})
    assert r.status_code == 200
    item = r.json()["item"]
    assert item["kind"] == "image" and item["media_size"] == len(data)
    import hashlib
    assert item["media_hash"] == hashlib.sha256(data).hexdigest()
    assert item["media_path"].startswith(item["media_hash"])

    # Identical bytes dedupe to ONE file on disk.
    r2 = c.post("/api/scratch/media",
                files={"file": ("copy.png", io.BytesIO(data), "image/png")})
    assert r2.json()["item"]["media_path"] == item["media_path"]
    mdir = scratch.media_dir(dbp)
    assert len(os.listdir(mdir)) == 1

    # Serving requires the row; bytes round-trip.
    served = c.get(f"/api/scratch/{item['id']}/media")
    assert served.status_code == 200 and served.content == data
    assert served.headers["content-type"].startswith("image/png")

    # Deleting one row keeps the shared file; deleting the last removes it.
    assert c.delete(f"/api/scratch/{item['id']}").status_code == 200
    assert len(os.listdir(mdir)) == 1
    assert c.delete(f"/api/scratch/{r2.json()['item']['id']}").status_code == 200
    assert len(os.listdir(mdir)) == 0
    print("✓ media: content-addressed, deduped, auth-served, refcounted delete")


def test_media_size_cap():
    c, cfg, dbp = _fresh()
    cfg["scratch"]["max_media_mb"] = 1
    big = b"x" * (1024 * 1024 + 1)
    r = c.post("/api/scratch/media",
               files={"file": ("big.bin", io.BytesIO(big), "application/octet-stream")})
    assert r.status_code == 413
    print("✓ media size cap enforced (413)")


def test_secret_guard_refuses_before_any_model():
    c, cfg, dbp = _fresh()
    # If the agent path runs at all, explode.
    orig = scratch.run_text_action
    scratch.run_text_action = lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("secret must never reach the agent"))
    try:
        for value, label in [
            ("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "bitcoin"),
            ("0x52908400098527886E0F7030069857D2E4169EE7", "ethereum"),
            ("-----BEGIN OPENSSH PRIVATE KEY-----", "ssh"),
            ("sk-abcdefghijklmnopqrstuvwxyz123456", "API"),
        ]:
            item = c.post("/api/scratch", json={"content": value}).json()["item"]
            out = c.post(f"/api/scratch/{item['id']}/act").json()["item"]
            assert out["status"] == "refused", value
            assert out["action_result"]["kind"] == "secret"
            assert value not in out["action_result"]["note"]   # never echoed
    finally:
        scratch.run_text_action = orig
    print("✓ secret guard: refuse-and-report, value never echoed, agent never runs")


def _scripted_generate(rounds):
    calls = {"i": 0}
    def fake(payload):
        deltas = rounds[calls["i"]] if calls["i"] < len(rounds) else []
        calls["i"] += 1
        for d in deltas:
            yield ({}, d)
    return fake


def test_hold_send_proposes_pending_draft_and_card_approval():
    c, cfg, dbp = _fresh()
    main.get_embedding = lambda text: None    # keyword-only dedupe path

    item = c.post("/api/scratch", json={
        "content": "dinner with Leo on Nov 23 at 7pm"}).json()["item"]

    rounds = [
        [{"tool_calls": [{"index": 0, "id": "1", "type": "function",
                          "function": {"name": "propose_note", "arguments":
                              json.dumps({"title": "Dinner with Leo",
                                          "tags": ["event"],
                                          "start": "2026-11-23T19:00",
                                          "people": ["Leo"],
                                          "body": "Dinner with [[Leo]]."})}}]}],
        [{"content": '{"action": "proposed", "note": "Extracted a dinner event."}'}],
    ]
    orig = inference._iter_stream_events
    inference._iter_stream_events = _scripted_generate(rounds)
    try:
        out = c.post(f"/api/scratch/{item['id']}/act").json()["item"]
    finally:
        inference._iter_stream_events = orig

    assert out["status"] == "pending"
    assert out["action_result"]["kind"] == "proposed"
    assert out["action_result"]["draft_title"] == "Dinner with Leo"
    assert out["llm_readable"] is True
    draft_id = out["draft_id"]

    # The draft is marked scratch-born so the inbox can hide it...
    conn = sqlite3.connect(dbp)
    run_id = conn.cursor().execute(
        "SELECT run_id FROM note_drafts WHERE id = ?", (draft_id,)).fetchone()[0]
    conn.close()
    assert run_id == f"scratch-{item['id']}"

    # ...nothing is in the vault yet...
    assert c.get("/api/notes").json()["count"] == 0

    # ...and card-approval = the NORMAL drafts endpoint; state derives live.
    assert c.post(f"/api/notes/drafts/{draft_id}/approve").status_code == 200
    refreshed = c.get("/api/scratch").json()["items"][0]
    assert refreshed["status"] == "committed"
    note = c.get("/api/notes/Dinner with Leo").json()["note"]
    assert note["fields"]["people"] == ["Leo"]
    print("✓ hold-send: pending draft on the card, approve commits, state derived")


def test_hold_send_chat_suggestion_and_flag():
    c, cfg, dbp = _fresh()
    item = c.post("/api/scratch", json={
        "content": "what are the tradeoffs of heat pumps?"}).json()["item"]
    rounds = [[{"content": '{"action": "suggest_chat", "note": "This is a research question."}'}]]
    orig = inference._iter_stream_events
    inference._iter_stream_events = _scripted_generate(rounds)
    try:
        out = c.post(f"/api/scratch/{item['id']}/act").json()["item"]
    finally:
        inference._iter_stream_events = orig
    assert out["status"] == "done"
    assert out["action_result"]["kind"] == "chat_suggestion"

    item2 = c.post("/api/scratch", json={"content": "zx91-blorp-77?"}).json()["item"]
    rounds = [[{"content": '{"action": "flag", "note": "Opaque token; left alone."}'}]]
    inference._iter_stream_events = _scripted_generate(rounds)
    try:
        out2 = c.post(f"/api/scratch/{item2['id']}/act").json()["item"]
    finally:
        inference._iter_stream_events = orig
    assert out2["status"] == "refused"
    assert out2["action_result"]["kind"] == "flagged"
    print("✓ action grammar: suggest_chat and model-judgment flag")


def test_agent_isolation_by_construction():
    """The conversation agent's retrieval surfaces cannot see scratch."""
    c, cfg, dbp = _fresh()
    c.post("/api/scratch", json={"content": "SECRETISH scratch-only phrase"})

    conn = sqlite3.connect(dbp)
    assert db.search_keyword_turns(conn, "SECRETISH") == []      # turn recall
    assert db.get_recent_turns(conn) == []                        # history
    assert notes_index.search_notes_keyword(conn, "SECRETISH") == []  # vault
    conn.close()
    _, execute, _ = main._build_tools(dbp)
    hits = json.loads(execute("recall_keyword", {"query": "SECRETISH"}))
    assert hits == []
    print("✓ isolation: separate table — agent surfaces physically can't see scratch")


def test_readable_toggle():
    c, cfg, dbp = _fresh()
    item = c.post("/api/scratch", json={"content": "plain note"}).json()["item"]
    assert item["llm_readable"] is False
    out = c.patch(f"/api/scratch/{item['id']}", json={"llm_readable": True}).json()["item"]
    assert out["llm_readable"] is True
    out = c.patch(f"/api/scratch/{item['id']}", json={"llm_readable": False}).json()["item"]
    assert out["llm_readable"] is False
    print("✓ per-item llm_readable toggle")


def test_unsupported_media_action():
    c, cfg, dbp = _fresh()
    r = c.post("/api/scratch/media",
               files={"file": ("pic.png", io.BytesIO(b"png"), "image/png")})
    out = c.post(f"/api/scratch/{r.json()['item']['id']}/act").json()["item"]
    assert out["action_result"]["kind"] == "unsupported"
    assert out["status"] == "done"
    print("✓ image hold-send: honest unsupported (vision pipeline is future work)")
