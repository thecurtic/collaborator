"""Tests for the tool-call log: capture through the real tool loop, categories
and the risk scope, malformed calls, turn linking, backfill, list/sort/stats."""

import json
import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, inference, tool_log
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
    main.get_embedding = lambda text: None
    return TestClient(main.app), path


def _scripted(rounds):
    calls = {"i": 0}
    def fake(payload):
        deltas = rounds[calls["i"]] if calls["i"] < len(rounds) else []
        calls["i"] += 1
        for d in deltas:
            yield ({}, d)
    return fake


def _call(idx, name, args):
    return {"index": idx, "id": str(idx), "type": "function",
            "function": {"name": name, "arguments": args}}


def _chat(c, message, rounds):
    orig = inference._iter_stream_events
    inference._iter_stream_events = _scripted(rounds)
    try:
        r = c.post("/api/messages", json={"message": message, "tools": True})
    finally:
        inference._iter_stream_events = orig
    events = [json.loads(l[6:]) for l in r.text.splitlines() if l.startswith("data: ")]
    return next(e for e in events if e["type"] == "done")


def test_category_and_risk():
    assert tool_log.category("fetch_url") == "outbound"
    assert tool_log.category("propose_edit") == "writes"
    assert tool_log.category("wallet", {"action": "pay_invoice"}) == "money"
    assert tool_log.category("wallet", {}) == "reads"
    assert tool_log.category("transcribe_video", {"url": "https://x"}) == "outbound"
    assert tool_log.category("transcribe_video", {"query": "x"}) == "reads"
    assert tool_log.category("calculate") == "compute"
    assert tool_log.category("something_new") == "other"
    assert "other" in tool_log.RISK_CATEGORIES       # unknown counts as risk
    assert tool_log.classify_result('{"error": "denied"}') == ("error", "denied")
    assert tool_log.classify_result('{"results": []}')[0] == "empty"
    assert tool_log.classify_result('{"results": [1]}')[0] == "ok"
    print("✓ categories, risk scope and outcomes")


def test_chat_turn_calls_are_logged_and_linked():
    c, path = _fresh()
    rounds = [
        [{"tool_calls": [_call(0, "calculate", json.dumps({"expression": "6*7"})),
                         _call(1, "search_notes", "{not json")]}],
        [{"content": "It's 42."}],
    ]
    done = _chat(c, "what is six times seven?", rounds)

    page = c.get("/api/tool-calls").json()
    assert page["total"] == 2
    by_tool = {x["tool"]: x for x in page["calls"]}
    calc = by_tool["calculate"]
    assert calc["args"] == {"expression": "6*7"}
    assert calc["outcome"] == "ok" and calc["category"] == "compute"
    assert calc["risk"] is False and calc["duration_ms"] is not None
    assert calc["turn_id"] == done["id"] and calc["root_id"] == done["user_turn_id"]
    assert calc["trigger"] == "what is six times seven?"
    assert calc["source"] == "chat" and calc["label"].startswith("Calculating")
    # A malformed call is still logged, as an error, with what was sent.
    bad = by_tool["search_notes"]
    assert bad["outcome"] == "error" and bad["args"] == {"_unparsed": "{not json"}

    detail = c.get(f"/api/tool-calls/{calc['id']}").json()
    assert detail["turn_exists"] is True and "42" in detail["result_preview"]
    assert [s["tool"] for s in detail["siblings"]] == ["calculate", "search_notes"]
    assert c.get("/api/tool-calls/9999").status_code == 404
    print("✓ chat calls logged in full, malformed ones too, linked to the reply")


def test_preview_is_bounded():
    c, path = _fresh()
    config.get_config()["tools"]["log"]["preview_chars"] = 10
    rec = tool_log.recorder(path, "chat", "run-x")
    rec({"tool": "fetch_url", "args": {"url": "https://example.org"},
         "result": json.dumps({"text": "x" * 5000}), "round": 0, "duration_ms": 5})
    detail = c.get("/api/tool-calls").json()["calls"][0]
    full = c.get(f"/api/tool-calls/{detail['id']}").json()
    assert full["result_chars"] > 5000 and len(full["result_preview"]) == 11
    assert full["risk"] is True and full["category"] == "outbound"
    print("✓ results kept as size + bounded preview")


def test_sorting_filters_and_stats():
    c, path = _fresh()
    rec = tool_log.recorder(path, "chat", "run-a", trigger="look things up")
    for name, args, ms in [("fetch_url", {"url": "https://a.example"}, 300),
                           ("fetch_url", {"url": "https://b.example"}, 100),
                           ("calculate", {"expression": "1+1"}, 1),
                           ("wallet", {"action": "pay_invoice"}, 50)]:
        rec({"tool": name, "args": args, "result": '{"ok": true}',
             "round": 0, "duration_ms": ms})
    tool_log.recorder(path, "scratch", "run-b")(
        {"tool": "propose_note", "args": {"title": "T"},
         "result": '{"error": "duplicate"}', "round": 0, "duration_ms": 2})

    def tools(**params):
        return [x["tool"] for x in c.get("/api/tool-calls", params=params).json()["calls"]]

    assert tools(sort="uses")[:2] == ["fetch_url", "fetch_url"]
    assert tools(sort="duration")[0] == "fetch_url"
    assert tools(sort="duration", order="asc")[0] == "calculate"
    assert tools(sort="tool", order="asc")[0] == "calculate"
    assert set(tools(risk="true")) == {"fetch_url", "wallet", "propose_note"}
    assert tools(category="money") == ["wallet"]
    assert tools(outcome="error") == ["propose_note"]
    assert tools(source="scratch") == ["propose_note"]
    assert tools(q="b.example") == ["fetch_url"]
    assert c.get("/api/tool-calls", params={"sort": "nope"}).status_code == 422
    assert c.get("/api/tool-calls", params={"category": "nope"}).status_code == 422
    assert tools(since="2000-01-01T00:00:00Z") and not tools(until="2000-01-01")

    s = c.get("/api/tool-calls/stats").json()
    fetch = next(t for t in s["tools"] if t["tool"] == "fetch_url")
    assert s["tools"][0]["tool"] == "fetch_url" and fetch["count"] == 2
    assert fetch["avg_ms"] == 200 and fetch["p95_ms"] == 300
    assert s["totals"]["calls"] == 5 and s["totals"]["errors"] == 1
    assert s["totals"]["risk"] == 4 and s["totals"]["by_source"] == {"chat": 4, "scratch": 1}
    assert sum(d["count"] for d in s["daily"]) == 5
    assert c.get("/api/tool-calls/stats", params={"risk": "true"}).json()["totals"]["calls"] == 4
    print("✓ sorting, filters, risk scope, usage stats")


def test_backfill_from_sources_once():
    path = os.path.join(tempfile.mkdtemp(), "old.db")
    conn = sqlite3.connect(path)
    db.ensure_conversation_schema(conn)
    conn.execute("DELETE FROM tool_log_meta")        # as if it predates the log
    u = db.create_turn(conn, None, "user", "find the garden note")
    a = db.create_turn(conn, None, "assistant", "here", parent_turn_id=u["id"])
    db.set_turn_tool_activity(conn, a["id"], [
        {"tool": "search_notes", "query": "garden", "outcome": "ok", "count": 2},
        {"tool": "fetch_url", "url": "https://x.example"}])
    db.ensure_conversation_schema(conn)
    db.ensure_conversation_schema(conn)              # second run is a no-op
    page = tool_log.list_calls(conn, sort="time", order="asc")
    conn.close()
    assert page["total"] == 2
    first = page["calls"][0]
    assert first["backfilled"] and first["args"] == {"query": "garden"}
    assert first["turn_id"] == a["id"] and first["root_id"] == u["id"]
    assert first["trigger"] == "find the garden note"
    assert page["calls"][1]["category"] == "outbound"
    print("✓ backfill from Sources, exactly once")


def test_disabled_logs_nothing():
    c, path = _fresh()
    config.get_config()["tools"]["log"]["enabled"] = False
    _chat(c, "6*7?", [
        [{"tool_calls": [_call(0, "calculate", json.dumps({"expression": "6*7"}))]}],
        [{"content": "42"}]])
    assert c.get("/api/tool-calls").json()["total"] == 0
    print("✓ tools.log.enabled: false logs nothing")
