"""Tests for recurring events (NOTES-FORMAT.md, Recurrence): the rule and
exceptions, derived occurrences in list_events, "this one or all of them"
through the model's tools, and RRULE/EXDATE in the ICS export."""

import datetime as dt
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
import importlib, db, main, notes_index, recurrence
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


@pytest.fixture
def chicago():
    """Occurrences take their own date's offset: test across a DST change."""
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


def _approve(c, execute, args):
    out = json.loads(execute("propose_note", args))
    assert "error" not in out, out
    r = c.post(f"/api/notes/drafts/{out['draft_id']}/approve")
    assert r.status_code == 200, r.text
    return r.json()["path"]


def _dates(occs):
    return [o["date"] for o in occs]


# --- The arithmetic --------------------------------------------------------------

def test_rule_validation():
    ok, err = recurrence.validate_repeat({"freq": "Weekly", "by_day": ["th", "MO"],
                                          "interval": 2, "until": "2026-12-31"})
    assert err is None and ok == {"freq": "weekly", "interval": 2,
                                  "by_day": ["MO", "TH"], "until": "2026-12-31"}
    for bad in ({"freq": "hourly"}, {"freq": "daily", "by_day": ["MO"]},
                {"freq": "weekly", "by_day": ["XX"]}, {"freq": "monthly", "by_month_day": 40},
                {"freq": "daily", "until": "2026-12-01", "count": 3},
                {"freq": "daily", "interval": 0}, "weekly"):
        assert recurrence.validate_repeat(bad)[1], bad
    assert recurrence.validate_repeat({}) == (None, None)
    print("✓ repeat rules validate and normalize")


def test_expansion_shapes():
    occ = recurrence.occurrence_dates
    d = dt.date
    assert [x.isoformat() for x in occ(d(2026, 10, 19), {"freq": "weekly",
            "by_day": ["MO", "TH"], "count": 4})] == [
        "2026-10-19", "2026-10-22", "2026-10-26", "2026-10-29"]
    assert [x.isoformat() for x in occ(d(2026, 1, 31), {"freq": "monthly", "count": 3})] == [
        "2026-01-31", "2026-03-31", "2026-05-31"]               # short months skipped
    assert [x.isoformat() for x in occ(d(2028, 2, 29), {"freq": "yearly", "count": 2})] == [
        "2028-02-29", "2032-02-29"]
    assert [x.isoformat() for x in occ(d(2026, 10, 1), {"freq": "daily", "interval": 3,
            "until": "2026-10-10"})] == ["2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10"]
    # Weekly with by_day earlier in the week than the first date: starts next week.
    assert occ(d(2026, 10, 21), {"freq": "weekly", "by_day": ["MO"]}).__next__() == d(2026, 10, 26)
    print("✓ daily/weekly/monthly/yearly arithmetic incl. short months and leap days")


def test_exceptions_and_window(chicago):
    rule = {"freq": "weekly", "by_day": ["MO"]}
    exc = [{"date": "2026-10-26", "cancelled": True},
           {"date": "2026-11-02", "start": "2026-11-02T20:00", "end": "2026-11-02T21:00"},
           {"date": "2026-11-09", "note": "Book club: the finale"}]
    occs = recurrence.expand("2026-10-19T19:00-05:00", "2026-10-19T20:30-05:00",
                             rule, exc, "2026-10-19", "2026-11-16")
    assert _dates(occs) == ["2026-10-19", "2026-11-02", "2026-11-16"]
    first, moved, after_dst = occs
    assert first["start"] == "2026-10-19T19:00-05:00" and not first["moved"]
    assert moved["start"].startswith("2026-11-02T20:00") and moved["moved"]
    # DST ended Nov 1: same wall-clock time, the date's own offset.
    assert after_dst["start"] == "2026-11-16T19:00-06:00"
    assert after_dst["end"] == "2026-11-16T20:30-06:00"
    # No window, nothing expanded (infinite series).
    assert recurrence.expand("2026-10-19T19:00", None, rule, None, None, None) == []
    ok, err = recurrence.validate_exceptions(
        [{"date": "2026-10-26", "cancelled": True, "note": "x"}], main._when_error)
    assert "exactly one" in err
    print("✓ exceptions: cancelled, moved, replaced; DST-correct offsets")


def test_rrule_round_trip():
    rule = {"freq": "weekly", "interval": 2, "by_day": ["MO", "WE"], "until": "2026-12-31"}
    rr = recurrence.to_rrule(rule)
    assert rr == "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T235959Z"
    assert recurrence.from_rrule(rr) == (rule, None)
    assert recurrence.from_rrule("FREQ=MONTHLY;BYDAY=-1FR")[0] is None
    assert recurrence.from_rrule("FREQ=DAILY;BYHOUR=9")[1] == "BYHOUR"
    print("✓ RRULE maps both ways; unsupported parts are named")


# --- Through the app ---------------------------------------------------------------

def test_series_lists_occurrences_and_this_one_edits():
    c, dbp = _fresh()
    _, execute, state = main._build_tools(dbp)
    out = json.loads(execute("propose_note", {
        "title": "Bad rule", "body": "x", "tags": ["event"], "start": "2026-10-19T19:00",
        "repeat": {"freq": "fortnightly"}}))
    assert "freq" in out["error"]
    _approve(c, execute, {
        "title": "Book club", "body": "Monday evenings.", "tags": ["event"],
        "start": "2026-10-19T19:00", "end": "2026-10-19T20:30",
        "repeat": {"freq": "weekly", "by_day": ["MO"]}})

    listing = json.loads(execute("list_events", {"from": "2026-10-19", "to": "2026-11-02"}))
    assert [e["occurrence"] for e in listing["events"]] == [
        "2026-10-19", "2026-10-26", "2026-11-02"]
    assert listing["events"][0]["recurring"] is True
    assert listing["events"][0]["repeat"] == {"freq": "weekly", "by_day": ["MO"]}

    # "This one": cancel the 26th through the model's typed tool.
    out = json.loads(execute("propose_edit", {
        "title": "Book club", "occurrence": "2026-10-26", "cancel_occurrence": True,
        "reason": "skipping that week"}))
    assert out["status"] == "pending", out
    assert c.post(f"/api/notes/drafts/{out['draft_id']}/approve").status_code == 200
    # ...and move the 2nd.
    out = json.loads(execute("propose_edit", {
        "title": "Book club", "occurrence": "2026-11-02",
        "start": "2026-11-02T20:00", "end": "2026-11-02T21:00"}))
    assert c.post(f"/api/notes/drafts/{out['draft_id']}/approve").status_code == 200
    listing = json.loads(execute("list_events", {"from": "2026-10-19", "to": "2026-11-02"}))
    assert [(e["occurrence"], e["moved"]) for e in listing["events"]] == [
        ("2026-10-19", False), ("2026-11-02", True)]
    assert listing["events"][1]["start"].startswith("2026-11-02T20:00")

    conn = sqlite3.connect(dbp)
    note = notes_index.get_note_by_title(conn, "Book club")
    conn.close()
    assert note["event_start"].startswith("2026-10-19T19:00")   # series untouched
    assert [e["date"] for e in note["fields"]["exceptions"]] == ["2026-10-26", "2026-11-02"]

    # "All of them": the rule itself changes.
    out = json.loads(execute("propose_edit", {
        "title": "Book club", "repeat": {"freq": "weekly", "by_day": ["TU"]}}))
    assert c.post(f"/api/notes/drafts/{out['draft_id']}/approve").status_code == 200
    # A one-off can't take an occurrence.
    _approve(c, execute, {"title": "Dentist", "body": "Checkup.", "tags": ["event"],
                          "start": "2026-10-20T09:00"})
    out = json.loads(execute("propose_edit", {"title": "Dentist",
                                              "occurrence": "2026-10-20",
                                              "cancel_occurrence": True}))
    assert "recurring" in out["error"]
    print("✓ occurrences listed; 'this one' writes exceptions; 'all' rewrites the rule")


def test_ics_exports_the_series_whole():
    c, dbp = _fresh()
    _, execute, _ = main._build_tools(dbp)
    _approve(c, execute, {
        "title": "Standup", "body": "Daily sync.", "tags": ["event"],
        "start": "2026-10-19T09:00", "end": "2026-10-19T09:15",
        "repeat": {"freq": "weekly", "by_day": ["MO", "WE"], "count": 10}})
    out = json.loads(execute("propose_edit", {"title": "Standup",
                                              "occurrence": "2026-10-21",
                                              "cancel_occurrence": True}))
    c.post(f"/api/notes/drafts/{out['draft_id']}/approve")
    out = json.loads(execute("propose_edit", {"title": "Standup",
                                              "occurrence": "2026-10-26",
                                              "start": "2026-10-26T10:00"}))
    c.post(f"/api/notes/drafts/{out['draft_id']}/approve")

    ics = c.get("/api/events.ics").text.replace("\r\n ", "")
    assert ics.count("BEGIN:VEVENT") == 2                       # series + one override
    assert "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10" in ics
    assert "EXDATE:20261021T" in ics
    assert "RECURRENCE-ID:20261026T" in ics
    # The calendar search path returns expanded occurrences.
    r = c.get("/api/notes/search?tag=event&from=2026-10-19&to=2026-10-28").json()
    assert [n.get("occurrence") for n in r["results"]] == ["2026-10-19", "2026-10-26",
                                                           "2026-10-28"]
    print("✓ ICS: one VEVENT with RRULE + EXDATE + RECURRENCE-ID override")
