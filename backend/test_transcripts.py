"""Tests for transcript retrieval (2026-10-12): canonical video identity,
channel capture, list/read-by-id tools, and readable failure kinds."""

import json
import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, agent_tools
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient
from video_urls import canonical_video

VID = "dQw4w9WgXcQ"


def _fresh():
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    config.get_config._config = config.load_config()
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), path


def _stub(monkeypatch, transcript="hello world", duration_s=300,
          channel="Garden Answers"):
    calls = {"probe": 0, "download": 0}

    def probe(url):
        calls["probe"] += 1
        calls["probed_url"] = url
        return {"title": "Raised beds", "duration_s": duration_s,
                "channel": channel}

    def download(url):
        calls["download"] += 1
        return transcript
    monkeypatch.setattr(agent_tools, "_probe_video", probe)
    monkeypatch.setattr(agent_tools, "_download_and_transcribe", download)
    return calls


def test_canonical_video_forms():
    want = (f"youtube:{VID}", f"https://www.youtube.com/watch?v={VID}")
    for url in (f"https://youtu.be/{VID}", f"https://youtu.be/{VID}?si=abc&t=42",
                f"https://www.youtube.com/watch?v={VID}&t=1m2s&list=PL1",
                f"https://m.youtube.com/watch?feature=share&v={VID}",
                f"https://www.youtube.com/shorts/{VID}",
                f"https://youtube.com/live/{VID}?feature=shared",
                f"https://www.youtube-nocookie.com/embed/{VID}",
                f"  https://music.youtube.com/watch?v={VID}  "):
        assert canonical_video(url) == want, url
    # Not YouTube (or no valid id): host lowercased, fragment dropped.
    assert canonical_video("https://Vimeo.com/123#t=5") == (
        "https://vimeo.com/123", "https://vimeo.com/123")
    assert canonical_video("https://youtu.be/short")[0] == "https://youtu.be/short"
    assert canonical_video("notaurl") == ("notaurl", "notaurl")
    print("✓ every YouTube URL form maps to one video key")


def test_any_url_form_reads_the_stored_row(monkeypatch):
    c, dbp = _fresh()
    calls = _stub(monkeypatch)
    first = agent_tools.transcribe_video(dbp, f"https://youtu.be/{VID}?si=x")
    assert first["status"] == "done" and first["id"]
    assert calls["probed_url"] == f"https://www.youtube.com/watch?v={VID}"
    assert first["channel"] == "Garden Answers"

    again = agent_tools.transcribe_video(
        dbp, f"https://www.youtube.com/watch?v={VID}&t=90")
    assert again["id"] == first["id"] and again["transcript"] == "hello world"
    assert calls == {**calls, "probe": 1, "download": 1}     # no second download
    conn = sqlite3.connect(dbp)
    assert conn.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0] == 1
    conn.close()
    print("✓ a second URL form of the same video reads the stored row")


def test_read_transcript_paging_query_and_errors(monkeypatch):
    c, dbp = _fresh()
    cfg = config.get_config()
    monkeypatch.setitem(cfg["tools"]["transcribe_video"], "return_chars", 10)
    _stub(monkeypatch, transcript="aaaaaaaaaabbbbbbbbbbcompost here")
    out = agent_tools.transcribe_video(dbp, f"https://youtu.be/{VID}")
    tid = out["id"]
    assert out["total_chunks"] == 4 and f"read_transcript(id={tid}, chunk=2)" in out["note"]

    part = agent_tools.read_transcript(dbp, tid, chunk=2)
    assert part["transcript"] == "bbbbbbbbbb" and part["chunk"] == 2
    jump = agent_tools.read_transcript(dbp, tid, query="COMPOST")
    assert jump["chunk"] == 3 and "compost" in jump["transcript"]
    miss = agent_tools.read_transcript(dbp, tid, query="zebra")
    assert miss["chunk"] == 1 and "does not occur" in miss["note"]

    assert "no transcript with id" in agent_tools.read_transcript(dbp, 999)["error"]
    assert "numeric id" in agent_tools.read_transcript(dbp, "abc")["error"]

    conn = sqlite3.connect(dbp)
    p = db.create_transcript(conn, "https://vimeo.com/1", "Pending", 3600)
    e = db.create_transcript(conn, "https://vimeo.com/2", "Broken", 60)
    db.set_transcript_result(conn, e["id"], error="ERROR: [youtube] x: Private video. "
                                                   "Sign in if you've been granted access")
    conn.close()
    assert agent_tools.read_transcript(dbp, p["id"])["status"] == "processing"
    broken = agent_tools.read_transcript(dbp, e["id"])
    assert broken["status"] == "error" and broken["error_kind"] == "private"
    print("✓ read_transcript: paging, query jump, clean errors, status passthrough")


def test_list_transcripts_catalogue_and_channel(monkeypatch):
    c, dbp = _fresh()
    conn = sqlite3.connect(dbp)
    a = db.create_transcript(conn, "https://vimeo.com/a", "Heat pumps", 900,
                             channel="Technology Connections")
    db.set_transcript_result(conn, a["id"], text="compare heat pumps and furnaces")
    b = db.create_transcript(conn, "https://vimeo.com/b", "Sourdough", 600,
                             channel="Bread Lab")
    db.set_transcript_result(conn, b["id"], text="flour water salt")
    bad = db.create_transcript(conn, "https://vimeo.com/c", "Gone", 60)
    db.set_transcript_result(conn, bad["id"],
                             error="ERROR: Sign in to confirm you're not a bot")
    conn.close()

    _, execute, _ = main._build_tools(dbp)
    names = [s["function"]["name"] for s in main._build_tools(dbp)[0]]
    assert {"transcribe_video", "list_transcripts", "read_transcript"} <= set(names)

    full = json.loads(execute("list_transcripts", {}))
    assert [t["title"] for t in full["transcripts"]] == ["Gone", "Sourdough", "Heat pumps"]
    gone = full["transcripts"][0]
    assert gone["status"] == "error" and gone["error_kind"] == "bot_check"
    assert all("text" not in t and "video_key" not in t for t in full["transcripts"])
    assert full["transcripts"][2]["channel"] == "Technology Connections"

    by_channel = json.loads(execute("list_transcripts", {"channel": "technology"}))
    assert [t["id"] for t in by_channel["transcripts"]] == [a["id"]]
    by_word = json.loads(execute("list_transcripts", {"query": "bread"}))
    assert [t["id"] for t in by_word["transcripts"]] == [b["id"]]   # channel matches

    api = c.get("/api/transcripts?channel=bread").json()
    assert [t["id"] for t in api["transcripts"]] == [b["id"]]
    assert "video_key" not in c.get(f"/api/transcripts/{a['id']}").json()["transcript"]
    print("✓ list_transcripts: full catalogue, errors flagged, channel + query filters")


def test_failures_carry_a_kind(monkeypatch):
    c, dbp = _fresh()
    import yt_dlp

    class _Boom:
        def __init__(self, opts): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def extract_info(self, url, download=False):
            raise RuntimeError("\x1b[0;31mERROR:\x1b[0m [youtube] " + VID +
                               ": Video unavailable. This video has been removed "
                               "by the uploader " + "x" * 400)
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _Boom)
    out = agent_tools.transcribe_video(dbp, f"https://youtu.be/{VID}")
    assert out["error_kind"] == "unavailable"
    assert "\x1b" not in out["error"] and len(out["error"]) > 200

    for msg, kind in [("Sign in to confirm you’re not a bot", "bot_check"),
                      ("Join this channel to get access to members-only content",
                       "members_only"),
                      ("Unsupported URL: https://x", "unsupported_url"),
                      ("Read timed out", "network"), ("weird", "other")]:
        assert agent_tools.classify_video_error(msg) == kind, msg
    print("✓ yt-dlp failures come back with a kind and the real message")


def test_old_rows_get_keys_on_migration():
    path = os.path.join(tempfile.mkdtemp(), "old.db")
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT,
        duration_s INTEGER, status TEXT NOT NULL DEFAULT 'processing', text TEXT,
        error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT)""")
    conn.execute("INSERT INTO transcripts (url, title, status, text) VALUES (?, ?, 'done', 'hi')",
                 (f"https://youtu.be/{VID}?t=3", "Old"))
    conn.commit()
    db.ensure_conversation_schema(conn)
    row = db.get_transcript_by_url(conn, f"https://www.youtube.com/watch?v={VID}")
    assert row is not None and row["title"] == "Old" and row["channel"] is None
    db.ensure_conversation_schema(conn)                       # idempotent
    conn.close()
    print("✓ existing rows are keyed on migration, so old URLs still hit")
