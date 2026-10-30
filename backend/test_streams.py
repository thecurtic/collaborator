"""Stopping a streamed reply keeps what it said (streams.py).

A stop request ends the reply, saves the exchange so far and finishes the
stream with `done` (stopped: true); a dropped connection saves it too."""

import asyncio
import json
import os
import sqlite3
import tempfile
import threading


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


def _turns():
    conn = sqlite3.connect(os.environ["DB_PATH"])
    rows = conn.execute("SELECT role, content FROM turns ORDER BY id").fetchall()
    conn.close()
    return rows


def _events(text):
    return [json.loads(l[6:]) for l in text.splitlines() if l.startswith("data: ")]


def test_stop_saves_the_reply_so_far_and_ends_with_done():
    main = _fresh_env()
    import streams
    from starlette.testclient import TestClient

    def fake_stream(*a, **k):
        yield "first "
        yield "second "
        # The stop request lands here, mid-reply.
        streams.get("s1").stop.set()
        yield "never sent"
        yield "nor this"
    main.stream_llm_tokens = fake_stream

    r = TestClient(main.app).post("/api/messages",
                                  json={"message": "hi", "tools": False, "stream_id": "s1"})
    done = [e for e in _events(r.text) if e["type"] == "done"]
    assert done and done[0]["stopped"] is True
    assert _turns() == [("user", "hi"), ("assistant", "first second ")]
    assert streams.get("s1").saved.is_set()
    assert streams.get("s1").result["assistant_turn_id"] == done[0]["id"]


def test_stop_before_any_words_keeps_the_message():
    main = _fresh_env()
    import streams
    from starlette.testclient import TestClient

    def fake_stream(*a, **k):
        streams.get("s2").stop.set()
        yield "never sent"
    main.stream_llm_tokens = fake_stream

    TestClient(main.app).post("/api/messages",
                              json={"message": "hi", "tools": False, "stream_id": "s2"})
    assert _turns() == [("user", "hi"), ("assistant", "[Stopped before replying.]")]


def test_dropped_connection_saves_the_reply_so_far():
    main = _fresh_env()

    def fake_stream(*a, **k):
        for tok in ["one ", "two ", "three "]:
            yield tok
    main.stream_llm_tokens = fake_stream

    gen = main._stream_turn_response(
        os.environ["DB_PATH"], message="hi", context_list=[], context_turns=5,
        commit=True, user_id=None, mode=None, user_parent_id=None,
        paragraph_index=None)()
    next(gen)
    next(gen)
    gen.close()   # what streams.closing does when the client goes away
    assert _turns() == [("user", "hi"), ("assistant", "one two ")]


def test_closing_closes_the_generator_when_the_client_leaves():
    import streams
    log = []

    def gen():
        try:
            for i in range(100):
                yield str(i)
        except GeneratorExit:
            log.append("closed")
            raise

    async def run():
        agen = streams.closing(gen())
        assert await agen.__anext__() == "0"
        await agen.aclose()          # the response stops iterating
        for _ in range(50):
            if log:
                break
            await asyncio.sleep(0.02)

    asyncio.run(run())
    assert log == ["closed"]


def test_request_stop_waits_until_saved():
    import streams
    st = streams.register("s3", "/db")

    def save_later():
        st.stop.wait(5)
        st.mark_saved(user_turn_id=1, assistant_turn_id=2)
    threading.Thread(target=save_later).start()

    out = asyncio.run(streams.request_stop("s3", "/db"))
    assert out == {"saved": True, "known": True, "user_turn_id": 1, "assistant_turn_id": 2}
    # Someone else's stream, or one that's gone: nothing to stop.
    assert asyncio.run(streams.request_stop("s3", "/other", wait=0.1))["known"] is False
    assert asyncio.run(streams.request_stop("nope", "/db", wait=0.1)) == {
        "saved": True, "known": False}
