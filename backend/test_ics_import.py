"""Tests for ICS import: a calendar file becomes proposed event drafts."""

import json
import os
import sqlite3
import tempfile
import time

import pytest

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, notes_index, ics_import
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient

ICS = "\r\n".join([
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN",
    "BEGIN:VEVENT", "UID:a1", "SUMMARY:Dentist: checkup", "DTSTART:20261020T150000Z",
    "DTEND:20261020T160000Z", "LOCATION:Main St\\, Suite 4",
    "DESCRIPTION:Bring the insurance card.\\nArrive early.", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a2", "SUMMARY:Book club",
    "DTSTART;TZID=America/Chicago:20261019T190000", "DURATION:PT1H30M",
    "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6",
    "EXDATE;TZID=America/Chicago:20261026T190000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a3", "SUMMARY:Holiday", "DTSTART;VALUE=DATE:20261224",
    "DTEND;VALUE=DATE:20261227", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a4", "SUMMARY:Last Friday drinks",
    "DTSTART:20261030T220000Z", "RRULE:FREQ=MONTHLY;BYDAY=-1FR", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a2", "SUMMARY:Book club",
    "RECURRENCE-ID;TZID=America/Chicago:20261102T190000",
    "DTSTART;TZID=America/Chicago:20261102T200000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a5", "SUMMARY:No start", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a6", "SUMMARY:A very long summary that is folded acr",
    " oss two lines", "DTSTART;VALUE=DATE:20261101", "END:VEVENT",
    "END:VCALENDAR", ""])


@pytest.fixture(autouse=True)
def chicago():
    saved = os.environ.get("TZ")
    os.environ["TZ"] = "America/Chicago"
    time.tzset()
    yield
    if saved is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = saved
    time.tzset()


def _fresh():
    d = tempfile.mkdtemp()
    os.environ["DB_PATH"] = os.path.join(d, "conv.db")
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(d, "vault")
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), os.environ["DB_PATH"]


def test_parse_ics():
    events, skipped = ics_import.parse_ics(ICS)
    by = {e["title"]: e for e in events}
    assert set(by) == {"Dentist checkup", "Book club", "Holiday", "Last Friday drinks",
                       "A very long summary that is folded across two lines"}
    d = by["Dentist checkup"]                                   # ':' made title-safe
    assert d["start"] == "2026-10-20T10:00-05:00" and d["end"] == "2026-10-20T11:00-05:00"
    assert d["location"] == "Main St, Suite 4"
    assert d["description"] == "Bring the insurance card.\nArrive early."
    b = by["Book club"]
    assert b["start"] == "2026-10-19T19:00-05:00" and b["end"] == "2026-10-19T20:30-05:00"
    assert b["repeat"] == {"freq": "weekly", "by_day": ["MO"], "count": 6}
    assert b["exceptions"] == [{"date": "2026-10-26", "cancelled": True}]
    h = by["Holiday"]
    assert h["all_day"] and h["start"] == "2026-12-24" and h["end"] == "2026-12-26"
    f = by["Last Friday drinks"]
    assert f["repeat"] is None and "can't hold" in f["notes"][0]
    reasons = {s["title"]: s["reason"] for s in skipped}
    assert "changed occurrence" in reasons["Book club"]
    assert reasons["No start"] == "no start time"
    print("✓ ICS parse: escapes, folding, TZID/UTC/date, duration, RRULE, EXDATE")


def test_import_endpoint_proposes_drafts_and_dedupes():
    c, dbp = _fresh()
    r = c.post("/api/events/import", json={"ics": ICS, "filename": "work.ics"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert len(out["drafts"]) == 5 and out["run_id"].startswith("ics-")
    drafts = c.get(f"/api/notes/drafts?status=pending").json()["drafts"]
    book = next(d for d in drafts if d["title"] == "Book club")
    assert book["tags"] == ["event"] and book["fields"]["repeat"]["count"] == 6
    assert any(n["title"] == "Last Friday drinks" for n in out["notes"])

    # Approving one puts it in the calendar; re-importing skips it.
    assert c.post(f"/api/notes/drafts/{book['id']}/approve").status_code == 200
    again = c.post("/api/events/import", json={"ics": ICS}).json()
    assert "Book club" not in [d["title"] for d in again["drafts"]]
    assert any(s["reason"] == "already in your calendar" for s in again["skipped"])

    assert c.post("/api/events/import", json={"ics": "hello"}).status_code == 422
    print("✓ import proposes drafts (inbox run), approval lands, re-import dedupes")


def test_ics_sent_to_scratch_becomes_proposals():
    c, dbp = _fresh()
    r = c.post("/api/scratch/media",
               files={"file": ("cal.ics", ICS.encode(), "text/calendar")})
    assert r.status_code == 200, r.text
    item = r.json()["item"]
    assert item["kind"] == "file"
    acted = c.post(f"/api/scratch/{item['id']}/act").json()["item"]
    assert acted["status"] == "pending"
    result = acted["action_result"]
    assert result["kind"] == "proposed" and len(result["draft_ids"]) == 5
    conn = sqlite3.connect(dbp)
    runs = {r[0] for r in conn.execute("SELECT run_id FROM note_drafts").fetchall()}
    conn.close()
    assert runs == {f"scratch-{item['id']}"}                     # on the card, not the inbox
    print("✓ an .ics sent to Scratch becomes proposals on its card")
