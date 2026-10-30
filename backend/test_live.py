"""Live updates between a user's devices (live.py, GET /api/live)."""

import asyncio
import os
import tempfile


def _fresh_env():
    d = tempfile.mkdtemp()
    os.environ["AUTH_ENABLED"] = "false"
    os.environ["DB_PATH"] = os.path.join(d, "conversations.db")
    import config
    config.get_config._config = config.load_config()
    import importlib, db, main
    importlib.reload(db)
    importlib.reload(main)
    return main


def test_areas_for_paths():
    import live
    assert live.areas_for("/api/messages/12") == ["chats"]
    assert live.areas_for("/api/turns/3/name") == ["chats"]
    assert live.areas_for("/api/notes/drafts/4/approve") == ["drafts"]
    assert live.areas_for("/api/notes/Some%20note") == ["notes"]
    assert live.areas_for("/api/events") == ["notes"]
    assert live.areas_for("/api/scratch/9") == ["scratch"]
    assert live.areas_for("/api/auth/ws-ticket") == []
    assert live.areas_for("/api/tts") == []
    assert live.areas_for("/api/messagesx") == []   # prefixes match whole segments


def test_publish_reaches_only_that_users_subscribers():
    import live

    async def run():
        mine = live.subscribe("/tmp/a/conversations.db")
        other = live.subscribe("/tmp/b/conversations.db")
        # From a worker thread, as background jobs do.
        await asyncio.to_thread(live.publish, "/tmp/a/conversations.db", ["notes", "chats"], "dev1")
        msg = await asyncio.wait_for(mine.get(), 2)
        assert msg == {"areas": ["chats", "notes"], "origin": "dev1"}
        assert other.empty()
        live.unsubscribe("/tmp/a/conversations.db", mine)
        live.unsubscribe("/tmp/b/conversations.db", other)

    asyncio.run(run())


def _capture(live):
    """Record publishes instead of delivering them."""
    seen = []
    live.publish = lambda db_path, areas, origin=None: seen.append((sorted(areas), origin))
    return seen


def test_successful_writes_publish_with_the_writers_id():
    main = _fresh_env()
    import live
    from starlette.testclient import TestClient
    real = live.publish
    seen = _capture(live)
    try:
        c = TestClient(main.app)
        r = c.post("/api/scratch", json={"content": "a thought"},
                   headers={"X-Client-Id": "phone"})
        assert r.status_code < 400
        assert (["scratch"], "phone") in seen
        seen.clear()
        c.get("/api/scratch")                       # reads publish nothing
        c.delete("/api/scratch/999999")             # a failed write neither
        assert seen == []
    finally:
        live.publish = real


def test_a_saved_reply_publishes_chats():
    main = _fresh_env()
    import live
    from starlette.testclient import TestClient
    real = live.publish
    seen = _capture(live)
    main.stream_llm_tokens = lambda *a, **k: iter(["hello"])
    try:
        r = TestClient(main.app).post("/api/messages", json={"message": "hi", "tools": False},
                                      headers={"X-Client-Id": "laptop"})
        assert '"type": "done"' in r.text
        # Announced by the save (no origin: the sender reloads anyway), not by
        # the middleware when the stream's headers went out.
        assert (["chats"], None) in seen
        assert (["chats"], "laptop") not in seen
    finally:
        live.publish = real


def test_a_streaming_reply_is_mirrored_to_other_devices():
    main = _fresh_env()
    import live
    from starlette.testclient import TestClient
    real = live.publish_reply
    mirrored = []
    live.publish_reply = lambda db_path, reply, origin=None: mirrored.append((dict(reply), origin))
    main.stream_llm_tokens = lambda *a, **k: iter(["one ", "two"])
    try:
        TestClient(main.app).post("/api/messages", json={"message": "hi", "tools": False},
                                  headers={"X-Client-Id": "phone"})
        first, last = mirrored[0], mirrored[-1]
        assert first[0]["user"] == "hi" and first[0]["done"] is False
        assert first[1] == "phone"                    # the sender skips its own
        assert last[0]["done"] is True and last[0]["text"] == "one two"
        assert len({r["id"] for r, _ in mirrored}) == 1
    finally:
        live.publish_reply = real
