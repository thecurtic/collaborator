"""Tests for the warm feed (UX doc, Feed): warmth = later of touched and
changed, shape weight breaks ties, pins on top, and each item type's idea of
"changed"."""

import datetime as dt
import json
import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, feed, notes_index
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def _fresh():
    d = tempfile.mkdtemp()
    path = os.path.join(d, "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(d, "vault")
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()

    def fake_stream(message, context_turns=None, mode=None, recall=None, **kw):
        yield "ok"
    main.stream_llm_tokens = fake_stream
    return TestClient(main.app), path, cfg["notes"]["vault_dir"]


def _done(resp):
    return [json.loads(l[6:]) for l in resp.text.splitlines()
            if l.startswith("data: ") and '"done"' in l][0]


def _set(dbp, sql, *params):
    conn = sqlite3.connect(dbp)
    conn.execute(sql, params)
    conn.commit()
    conn.close()


def _ago(**kw):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(**kw)).strftime(
        "%Y-%m-%d %H:%M:%S")


def _keys(resp):
    return [i["key"] for i in resp["items"]]


def test_chats_order_by_their_newest_turn_and_touch_warms():
    c, dbp, _ = _fresh()
    a = _done(c.post("/api/messages", json={"message": "first chat"}))
    b = _done(c.post("/api/messages", json={"message": "second chat"}))
    # a older, b newer
    _set(dbp, "UPDATE turns SET created_at = ? WHERE id IN (?, ?)", _ago(hours=5),
         a["user_turn_id"], a["id"])
    _set(dbp, "UPDATE turns SET created_at = ? WHERE id IN (?, ?)", _ago(hours=1),
         b["user_turn_id"], b["id"])
    f = c.get("/api/feed").json()
    assert _keys(f)[:2] == [f"chat:{b['user_turn_id']}", f"chat:{a['user_turn_id']}"]
    item = f["items"][0]
    assert item["type"] == "chat" and item["subtitle"] == "ok"   # last line
    assert item["ref"]["leaf_id"] == b["id"]

    # Opening the older chat warms it past the newer one.
    assert c.post("/api/feed/touch", json={"key": f"chat:{a['user_turn_id']}"}).status_code == 200
    assert _keys(c.get("/api/feed").json())[0] == f"chat:{a['user_turn_id']}"
    assert c.post("/api/feed/touch", json={"key": "bogus"}).status_code == 422
    print("✓ chats warm by their newest turn; opening one touches it")


def test_notes_warm_by_app_activity_never_mtime():
    c, dbp, vault = _fresh()
    os.makedirs(vault, exist_ok=True)
    for title in ("Old idea", "Edited elsewhere"):
        with open(os.path.join(vault, f"{title}.md"), "w") as f:
            f.write(f"---\ncreated: 2026-01-01\ntags: [garden]\n---\n\n# {title}\n\nBody.\n")
    c.post("/api/notes/reindex")
    # Fresh files (recent mtimes) but no in-app activity: not in the feed.
    assert not [k for k in _keys(c.get("/api/feed").json()) if k.startswith("note:")]

    c.get("/api/notes/Old idea")                               # opened = touched
    assert "note:old idea" in _keys(c.get("/api/feed").json())

    with open(os.path.join(vault, "Edited elsewhere.md"), "a") as f:
        f.write("More.\n")                                     # an Obsidian edit
    stats = c.post("/api/notes/reindex").json()
    assert stats["updated_titles"] == ["Edited elsewhere"]
    assert _keys(c.get("/api/feed").json())[0] == "note:edited elsewhere"

    c.patch("/api/notes/Old idea", json={"title": "Renamed idea"})
    keys = _keys(c.get("/api/feed").json())
    assert keys[0] == "note:renamed idea" and "note:old idea" not in keys
    c.delete("/api/notes/Renamed idea")
    assert "note:renamed idea" not in _keys(c.get("/api/feed").json())
    print("✓ notes: touched on open, changed by edits/reindex, never by mtime")


def test_approvals_events_transcripts_and_merged():
    c, dbp, vault = _fresh()
    conn = sqlite3.connect(dbp)
    d = db.create_note_draft(conn, "Beds face south", "Sun.", tags=["garden"])
    t = db.create_transcript(conn, "https://vimeo.com/1", "Raised beds", 900,
                             channel="Garden Answers")
    db.set_transcript_result(conn, t["id"], text="cedar")
    p = db.create_transcript(conn, "https://vimeo.com/2", "Still going", 3600)
    feed.record_merged(conn, "Fix the login lockout", project="collaborator")
    conn.close()

    # An event tomorrow (within a day: it has "moved"), one in 10 days, one past.
    os.makedirs(vault, exist_ok=True)
    now = dt.datetime.now()
    for title, when in (("Seed swap", now + dt.timedelta(hours=20)),
                        ("Later fair", now + dt.timedelta(days=10)),
                        ("Last week", now - dt.timedelta(days=7))):
        with open(os.path.join(vault, f"{title}.md"), "w") as f:
            f.write(f"---\ncreated: 2026-01-01\ntags: [event]\nstart: "
                    f"{when.strftime('%Y-%m-%dT%H:%M')}\n---\n\n# {title}\n\nx\n")
    c.post("/api/notes/reindex")

    f = c.get("/api/feed").json()
    by_key = {i["key"]: i for i in f["items"]}
    assert by_key[f"approval:{d['id']}"]["type"] == "approval"
    assert by_key[f"transcript:{t['id']}"]["subtitle"] == "Garden Answers"
    assert f"transcript:{p['id']}" not in by_key                 # still processing
    merged = [i for i in f["items"] if i["type"] == "merged"]
    assert merged and merged[0]["subtitle"] == "collaborator"
    events = {i["title"]: i for i in f["items"] if i["type"] == "event"}
    assert set(events) == {"Seed swap", "Later fair"}            # past one excluded
    assert events["Seed swap"]["warmth"] is not None              # within a day: warm
    assert f["items"][0]["title"] == "Seed swap"                  # ...and on top
    assert events["Later fair"]["warmth"] is None                 # not yet
    assert "note:last week" not in by_key                         # untouched past event
    print("✓ approvals, upcoming events, finished transcripts and merged work")


def test_pins_sit_on_top_and_ties_break_by_shape():
    c, dbp, _ = _fresh()
    a = _done(c.post("/api/messages", json={"message": "old chat"}))
    _set(dbp, "UPDATE turns SET created_at = ? WHERE id IN (?, ?)", _ago(days=30),
         a["user_turn_id"], a["id"])
    _done(c.post("/api/messages", json={"message": "new chat"}))
    key = f"chat:{a['user_turn_id']}"
    assert c.post("/api/feed/pin", json={"key": key}).json()["pinned"] is True
    f = c.get("/api/feed?limit=1").json()
    assert [i["key"] for i in f["pinned"]] == [key] and f["pinned"][0]["pinned"]
    assert len(f["items"]) == 1 and key not in _keys(f)          # pins don't count
    c.post("/api/feed/pin", json={"key": key, "pinned": False})
    assert c.get("/api/feed").json()["pinned"] == []

    # Equal warmth: the approval outranks the chat.
    conn = sqlite3.connect(dbp)
    d = db.create_note_draft(conn, "Tie", "x")
    conn.close()
    stamp = _ago(minutes=1)
    _set(dbp, "UPDATE note_drafts SET created_at = ? WHERE id = ?", stamp, d["id"])
    _set(dbp, "UPDATE turns SET created_at = ?", stamp)
    _set(dbp, "DELETE FROM feed_activity")
    keys = _keys(c.get("/api/feed").json())
    assert keys[0] == f"approval:{d['id']}"
    print("✓ pins on top outside the limit; shape weight breaks warmth ties")
