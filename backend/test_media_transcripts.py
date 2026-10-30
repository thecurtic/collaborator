"""Transcripts of the user's own recordings and videos (media_transcripts.py):
transcribed only when asked (a hold on send), into the transcripts table with
a source; streamed uploads; Scratch transcripts stay private unless the
capture is model-readable. Speech-to-text is stubbed; no model is called."""

import json
import os
import sqlite3
import tempfile
import time


def _fresh_env(monkeypatch, **cfg_over):
    d = tempfile.mkdtemp()
    os.environ["AUTH_ENABLED"] = "false"
    os.environ["DB_PATH"] = os.path.join(d, "conversations.db")
    import config
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(d, "vault")
    for section, values in cfg_over.items():
        cfg.setdefault(section, {}).update(values)
    config.get_config._config = cfg
    import importlib, db, main, media_transcripts
    importlib.reload(db)
    importlib.reload(main)
    heard = []

    def fake_transcribe(path, duration_s):
        heard.append(path)
        return "we talked about the garden beds and the compost"
    monkeypatch.setattr(media_transcripts, "transcribe_path", fake_transcribe)
    monkeypatch.setattr(media_transcripts, "probe_duration", lambda p: 95)
    seen = []

    def fake_stream(message, context_turns=None, mode=None, recall=None, **kw):
        seen.append(message)
        yield "ok"
    main.stream_llm_tokens = fake_stream
    from starlette.testclient import TestClient
    return main, TestClient(main.app), os.environ["DB_PATH"], heard, seen


def _wait_status(db_path, table, row_id, col, until, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        conn = sqlite3.connect(db_path)
        try:
            val = conn.execute(f"SELECT {col} FROM {table} WHERE id = ?",
                               (row_id,)).fetchone()[0]
        finally:
            conn.close()
        if val in until:
            return val
        time.sleep(0.05)
    raise AssertionError(f"{table} #{row_id} {col} stayed {val}")


AUDIO = b"ID3" + b"\x00" * 4000      # stands in for an mp3 (STT is stubbed)


def test_old_transcripts_table_is_rebuilt_with_sources():
    d = tempfile.mkdtemp()
    path = os.path.join(d, "conversations.db")
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE transcripts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT,
            duration_s INTEGER, status TEXT NOT NULL DEFAULT 'processing',
            text TEXT, error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT);
        INSERT INTO transcripts (url, title, status, text)
            VALUES ('https://www.youtube.com/watch?v=abcdefghijk', 'Old one', 'done', 'hello');
    """)
    conn.commit()
    conn.close()
    os.environ["DB_PATH"] = path
    os.environ["AUTH_ENABLED"] = "false"
    import config
    config.get_config._config = config.load_config()
    import importlib, db
    importlib.reload(db)
    db.init_db()
    conn = sqlite3.connect(path)
    try:
        info = {r[1]: r for r in conn.execute("PRAGMA table_info(transcripts)")}
        assert info["url"][3] == 0                       # nullable now
        row = db.get_transcript(conn, 1)
        assert row["title"] == "Old one" and row["text"] == "hello"
        assert row["source"] == "link" and row["video_key"]
        db.init_db()                                     # idempotent
        assert db.get_transcript(conn, 1)["source"] == "link"
    finally:
        conn.close()


def test_a_tap_sends_a_recording_untranscribed(monkeypatch):
    main, c, dbp, heard, seen = _fresh_env(monkeypatch)
    att = c.post("/api/attachments",
                 files={"file": ("meeting.mp3", AUDIO, "audio/mpeg")}).json()["attachment"]
    assert att["kind"] == "audio" and att["text_status"] == "idle"
    r = c.post("/api/messages", json={"message": "here it is", "tools": False,
                                      "attachment_ids": [att["id"]]})
    assert '"type": "done"' in r.text
    assert heard == []
    assert "Not transcribed" in seen[-1]
    assert c.get("/api/transcripts").json()["count"] == 0


def test_a_hold_transcribes_into_transcripts_and_the_turn(monkeypatch):
    main, c, dbp, heard, seen = _fresh_env(monkeypatch)
    att = c.post("/api/attachments",
                 files={"file": ("meeting.mp3", AUDIO, "audio/mpeg")}).json()["attachment"]
    r = c.post("/api/messages", json={"message": "what did we decide?", "tools": False,
                                      "attachment_ids": [att["id"]], "transcribe": True})
    assert '"type": "done"' in r.text
    assert len(heard) == 1
    assert "garden beds" in seen[-1]                     # the model read it this turn
    got = c.get(f"/api/attachments/{att['id']}").json()["attachment"]
    assert got["text_status"] == "done" and got["transcript_id"]
    listing = c.get("/api/transcripts").json()
    assert listing["count"] == 1
    t = listing["transcripts"][0]
    assert t["source"] == "attachment" and t["url"] is None
    assert t["title"] == "meeting.mp3" and t["duration_s"] == 95
    assert listing["sources"] == [{"source": "attachment", "count": 1}]
    assert c.get("/api/transcripts?source=link").json()["count"] == 0
    full = c.get(f"/api/transcripts/{t['id']}").json()["transcript"]
    assert "compost" in full["text"]

    # The same bytes again reuse the transcript: nothing is heard twice.
    again = c.post("/api/attachments",
                   files={"file": ("copy.mp3", AUDIO, "audio/mpeg")}).json()["attachment"]
    assert again["id"] == att["id"]
    c.post(f"/api/attachments/{att['id']}/extract")
    assert len(heard) == 1
    assert c.get("/api/transcripts").json()["count"] == 1


def test_uploads_stream_and_the_cap_applies(monkeypatch):
    main, c, dbp, heard, seen = _fresh_env(
        monkeypatch, attachments={"max_mb": 0.001}, scratch={"max_media_mb": 0.001})
    r = c.post("/api/attachments", files={"file": ("big.mp3", AUDIO, "audio/mpeg")})
    assert r.status_code == 413 and "MB" in r.json()["detail"]
    r = c.post("/api/scratch/media", files={"file": ("big.mp3", AUDIO, "audio/mpeg")})
    assert r.status_code == 413
    r = c.post("/api/attachments", files={"file": ("empty.txt", b"", "text/plain")})
    assert r.status_code == 422
    # Nothing half-written is left behind.
    att_dir = os.path.join(os.path.dirname(dbp), "attachments")
    media_dir = os.path.join(os.path.dirname(dbp), "scratch-media")
    for d in (att_dir, media_dir):
        assert not [f for f in os.listdir(d) if f.startswith(".upload-")] if os.path.isdir(d) else True


def test_scratch_hold_transcribes_and_stays_private_unless_readable(monkeypatch):
    main, c, dbp, heard, seen = _fresh_env(monkeypatch)
    import agent_tools
    item = c.post("/api/scratch/media", data={"content": "Call with the plumber"},
                  files={"file": ("call.m4a", AUDIO, "audio/mp4")}).json()["item"]
    assert item["status"] == "inert" and heard == []    # a tap: just saved
    acted = c.post(f"/api/scratch/{item['id']}/act").json()["item"]
    assert acted["action_result"]["kind"] == "transcript"
    tid = acted["transcript_id"]
    assert _wait_status(dbp, "transcripts", tid, "status", ("done", "error")) == "done"
    t = c.get(f"/api/transcripts/{tid}").json()["transcript"]
    assert t["source"] == "scratch" and t["title"] == "Call with the plumber"

    # Held = model-readable, so the model finds it…
    assert agent_tools.list_transcripts(dbp)["count"] == 1
    # …until the capture is marked unread again.
    c.patch(f"/api/scratch/{item['id']}", json={"llm_readable": False})
    assert agent_tools.list_transcripts(dbp)["count"] == 0
    assert "error" in agent_tools.read_transcript(dbp, tid)
    # The user still sees it on the Transcripts page.
    assert c.get("/api/transcripts?source=scratch").json()["count"] == 1


def test_a_recorded_voice_note_still_goes_to_the_agent(monkeypatch):
    main, c, dbp, heard, seen = _fresh_env(monkeypatch)
    import scratch, voice
    monkeypatch.setattr(voice, "transcribe_batch", lambda *a, **k: "buy more seed potatoes")
    acted_on = []

    def fake_action(db_path, text, *a, **k):
        acted_on.append(text)
        return {"kind": "unsupported", "note": "ok"}
    monkeypatch.setattr(scratch, "run_text_action", fake_action)
    item = c.post("/api/scratch/media",
                  files={"file": ("voice-note.webm", AUDIO, "audio/webm")}).json()["item"]
    c.post(f"/api/scratch/{item['id']}/act")
    assert acted_on == ["buy more seed potatoes"]
    assert c.get("/api/transcripts").json()["count"] == 0
