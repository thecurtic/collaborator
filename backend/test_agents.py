"""Tests for the agent seam (agents.py): pairing, channels and the default,
the conversation with catch-up both ways, questions and their answers,
events (status, firehose markers, merged work, previews), health, the
notification that clears, the Feed and search, staged note sends, and the
model's one explicit tool."""

import asyncio
import json
import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, agents, notifications, feed, gate_client
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient

KEY = "k" * 40


class FakeWS:
    """An endpoint's socket as the hub sees it: frames the hub sends land in
    .sent; recv() is never used (tests feed frames straight to the hub)."""
    def __init__(self):
        self.sent, self.closed = [], False

    async def send(self, text):
        self.sent.append(json.loads(text))

    async def close(self):
        self.closed = True

    def of(self, t):
        return [f for f in self.sent if f.get("type") == t]


def _fresh():
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    config.get_config._config = config.load_config()
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), path, main.agents.hub()


def run(coro):
    return asyncio.run(coro)


def _paired(c, hub, key=KEY, name="pm-box"):
    ws = FakeWS()
    ep = run(hub._hello(ws, {"type": "hello", "key": key, "name": name}))
    assert ws.of("pairing")[0]["status"] == "pending"
    pending = c.get("/api/agents/endpoints").json()["pending"]
    assert [p["fingerprint"] for p in pending] == [agents.fingerprint(key)]
    assert c.post(f"/api/agents/endpoints/{ep.id}/approve").status_code == 200
    assert ws.of("welcome")[0]["acked"] == {}
    return ws, hub.endpoints[ep.id]


def _team(hub, ep):
    run(hub._frame(ep, {"type": "discovery", "projects": [{"tag": "blockswap"}]}))
    run(hub._frame(ep, {"type": "channel", "project": "blockswap", "channel": "pm/blockswap",
                        "label": "pm-blockswap", "accepts_input": True, "firehose": False,
                        "status": "idle"}))
    run(hub._frame(ep, {"type": "channel", "project": "blockswap", "channel": "eng/blockswap",
                        "label": "frontend", "accepts_input": False, "firehose": True}))


def test_pairing_is_once_per_user_and_unpaired_frames_are_ignored():
    c, path, hub = _fresh()
    ws = FakeWS()
    ep = run(hub._hello(ws, {"type": "hello", "key": KEY, "name": "pm-box"}))
    run(hub._frame(ep, {"type": "discovery", "projects": ["x"]}))
    # handle() only routes frames once paired; _frame direct here proves the
    # store is per user: nothing is stored without one.
    assert c.get("/api/agents/projects").json()["projects"] == []
    short = FakeWS()
    assert run(hub._hello(short, {"type": "hello", "key": "short"})) is None
    assert short.of("error")
    c.post(f"/api/agents/endpoints/{ep.id}/approve")
    # A rebuilt box with a new key asks again; the old key reconnects straight in.
    ws2 = FakeWS()
    run(hub._hello(ws2, {"type": "hello", "key": KEY, "name": "pm-box"}))
    assert ws2.of("welcome") and not ws2.of("pairing")
    assert ws.closed                          # the stale socket was replaced
    print("✓ pairing: pending until approved, remembered after, short keys refused")


def test_channels_default_and_watch_only():
    c, path, hub = _fresh()
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    p = c.get("/api/agents/projects/blockswap").json()
    assert [ch["label"] for ch in p["channels"]] == ["frontend", "pm-blockswap"]
    assert p["default"] == {"endpoint_id": ep.id, "channel": "pm/blockswap"}
    # Only an input channel can be the default; a read-only one refuses input.
    r = c.put("/api/agents/projects/blockswap/default",
              json={"endpoint_id": ep.id, "channel": "eng/blockswap"})
    assert r.status_code == 409
    r = c.post("/api/agents/projects/blockswap/messages",
               json={"text": "hi", "endpoint_id": ep.id, "channel": "eng/blockswap"})
    assert r.status_code == 409
    run(hub._frame(ep, {"type": "channel", "project": "blockswap", "channel": "pm/blockswap",
                        "accepts_input": False}))
    r = c.post("/api/agents/projects/blockswap/messages", json={"text": "hi"})
    assert r.status_code == 409 and "watch-only" in r.json()["detail"]
    print("✓ default = the channel that accepts input; none = watch-only")


def test_midturn_input_defaults_to_queues_and_survives_omission():
    c, path, hub = _fresh()
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    mode = lambda: {ch["channel"]: ch["midturn_input"]
                    for ch in c.get("/api/agents/projects/blockswap").json()["channels"]}
    assert mode() == {"pm/blockswap": "queues", "eng/blockswap": "queues"}
    run(hub._frame(ep, {"type": "channel", "project": "blockswap", "channel": "pm/blockswap",
                        "midturn_input": "steers"}))
    run(hub._frame(ep, {"type": "channel", "project": "blockswap", "channel": "pm/blockswap",
                        "busy": True}))
    run(hub._frame(ep, {"type": "channel", "project": "blockswap", "channel": "eng/blockswap",
                        "midturn_input": "bogus"}))
    assert mode() == {"pm/blockswap": "steers", "eng/blockswap": "queues"}
    print("✓ midturn_input: missing = queues, omitted = unchanged, unknown = queues")


def test_conversation_catch_up_both_ways_and_dedupe():
    c, path, hub = _fresh()
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    for seq in (1, 2):
        run(hub._frame(ep, {"type": "message", "project": "blockswap",
                            "channel": "pm/blockswap", "id": f"m{seq}", "seq": seq,
                            "text": f"update {seq}"}))
    run(hub._frame(ep, {"type": "message", "project": "blockswap", "channel": "pm/blockswap",
                        "id": "m2", "seq": 2, "text": "update 2"}))       # resend: deduped
    assert [a["seq"] for a in ws.of("ack")] == [1, 2, 2]
    msgs = c.get("/api/agents/projects/blockswap/messages",
                 params={"endpoint_id": ep.id, "channel": "pm/blockswap"}).json()["messages"]
    assert [m["text"] for m in msgs] == ["update 1", "update 2"]

    # Outbound while the endpoint is gone: queued, resent on reconnect, acked once.
    hub._disconnected(ep, ws)
    out = c.post("/api/agents/projects/blockswap/messages", json={"text": "ship it"}).json()
    assert out["message"]["delivered_at"] is None
    ws2 = FakeWS()
    ep2 = run(hub._hello(ws2, {"type": "hello", "key": KEY, "name": "pm-box"}))
    assert ws2.of("welcome")[0]["acked"] == {"blockswap/pm/blockswap": 2}
    resent = ws2.of("message")
    assert [m["text"] for m in resent] == ["ship it"]
    run(hub._frame(ep2, {"type": "ack", "id": resent[0]["id"]}))
    msgs = c.get("/api/agents/projects/blockswap/messages",
                 params={"endpoint_id": ep.id, "channel": "pm/blockswap"}).json()["messages"]
    assert msgs[-1]["from"] == "you" and msgs[-1]["delivered_at"]
    ws3 = FakeWS()
    run(hub._hello(ws3, {"type": "hello", "key": KEY, "name": "pm-box"}))
    assert ws3.of("message") == []                       # acked: never resent
    print("✓ catch-up: welcome says where it left off, outbound queued until acked")


def test_question_answer_close_and_notification_clears(monkeypatch):
    c, path, hub = _fresh()
    cleared, notified = [], []
    real_notify = notifications.notify
    monkeypatch.setattr(notifications, "notify", lambda *a, **k: (
        notified.append(k.get("sequence_id")), real_notify(*a, **{**k, "background": False}))[1])
    monkeypatch.setattr(notifications, "clear", lambda db_path, seq: cleared.append(seq))
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    q = {"id": "q1", "prompt": "Merge spec 009?", "options": [
        {"id": "merge", "label": "Merge"}, {"id": "hold", "label": "Not yet",
                                            "description": "send it back"}]}
    run(hub._frame(ep, {"type": "message", "project": "blockswap", "channel": "pm/blockswap",
                        "id": "m1", "seq": 1, "text": "", "question": q}))
    assert len(notified) == 1
    assert c.get("/api/agents/projects").json()["projects"][0]["waiting"] == 1
    items = c.get("/api/feed").json()["items"]
    card = [i for i in items if i["type"] == "agent_question"][0]
    assert card["title"] == "Merge spec 009?"
    # Text on an options-only question is refused; a pick goes through.
    mid = card["ref"]["message_id"]
    assert c.post(f"/api/agents/questions/{mid}/answer", json={"text": "sure"}).status_code == 409
    r = c.post(f"/api/agents/questions/{mid}/answer", json={"option_ids": ["merge", "hold"]})
    assert r.status_code == 200
    sent = ws.of("message")[-1]
    assert sent["answer"] == {"question_id": "q1", "option_ids": ["merge"], "text": ""}
    assert sent["text"] == "Merge"
    assert cleared == ["agent-" + str(mid)]
    assert c.post(f"/api/agents/questions/{mid}/answer",
                  json={"option_ids": ["merge"]}).status_code == 409
    assert not [i for i in c.get("/api/feed").json()["items"] if i["type"] == "agent_question"]

    # A second question, closed by the endpoint (answered elsewhere): the
    # outcome replaces live controls and its notification clears.
    run(hub._frame(ep, {"type": "message", "project": "blockswap", "channel": "pm/blockswap",
                        "id": "m2", "seq": 2, "question": {"id": "q2", "prompt": "Name?"}}))
    run(hub._frame(ep, {"type": "question_closed", "project": "blockswap", "question_id": "q2",
                        "outcome": {"text": "Bob", "reason": "answered elsewhere"}}))
    msgs = c.get("/api/agents/projects/blockswap/messages",
                 params={"endpoint_id": ep.id, "channel": "pm/blockswap"}).json()["messages"]
    q2 = [m for m in msgs if m["question"] and m["question"]["id"] == "q2"][0]
    assert q2["question"]["freeform"] and q2["question_state"] == "closed"
    assert q2["outcome"]["text"] == "Bob"
    assert len(cleared) == 2
    print("✓ questions: notify once, answer anywhere, clear on answer or close")


def test_flagged_message_waits_until_read_and_plain_unreads_stay_quiet(monkeypatch):
    c, path, hub = _fresh()
    cleared = []
    monkeypatch.setattr(notifications, "clear", lambda db_path, seq: cleared.append(seq))
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    run(hub._frame(ep, {"type": "message", "project": "blockswap", "channel": "pm/blockswap",
                        "id": "m1", "seq": 1, "text": "just an update"}))
    run(hub._frame(ep, {"type": "message", "project": "blockswap", "channel": "pm/blockswap",
                        "id": "m2", "seq": 2, "text": "stalled on the API key",
                        "needs_reply": True}))
    log = notifications.list_notifications(sqlite3.connect(path))
    assert [n["body"] for n in log] == ["stalled on the API key"]
    types = [i["type"] for i in c.get("/api/feed").json()["items"]]
    assert types.count("agent_message") == 1
    chan = c.get("/api/agents/projects/blockswap").json()["channels"]
    pm = [ch for ch in chan if ch["channel"] == "pm/blockswap"][0]
    assert pm["unread"] == 2 and pm["waiting"] == 1
    c.post("/api/agents/projects/blockswap/read",
           json={"endpoint_id": ep.id, "channel": "pm/blockswap"})
    assert c.get("/api/agents/projects").json()["projects"][0]["waiting"] == 0
    assert "agent_message" not in [i["type"] for i in c.get("/api/feed").json()["items"]]
    assert len(cleared) == 1
    print("✓ flagged messages notify and wait until read; plain unreads never do")


def test_events_status_markers_merged_and_preview():
    c, path, hub = _fresh()
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    run(hub._frame(ep, {"type": "firehose", "project": "blockswap", "channel": "eng/blockswap",
                        "kind": "tool", "text": "npm test", "seq": 7}))
    run(hub._frame(ep, {"type": "event", "project": "blockswap", "channel": "eng/blockswap",
                        "event": "audit", "text": "auditor: Spec 009 PASS → PM",
                        "work_item": "spec-009", "commit": "abc123"}))
    run(hub._frame(ep, {"type": "event", "project": "blockswap", "channel": "eng/blockswap",
                        "event": "preview", "text": "Try the swap page",
                        "url": "http://<tailnet-host>:5173/"}))
    run(hub._frame(ep, {"type": "event", "project": "blockswap", "channel": "eng/blockswap",
                        "event": "preview", "url": "javascript:alert(1)"}))
    run(hub._frame(ep, {"type": "event", "project": "blockswap", "channel": "pm/blockswap",
                        "event": "merged", "text": "Spec 009: swap page", "commit": "abc123"}))
    fh = c.get("/api/agents/projects/blockswap/firehose",
               params={"endpoint_id": ep.id, "channel": "eng/blockswap"}).json()["items"]
    assert fh[0]["text"] == "npm test" and fh[1]["kind"] == "event"
    eng = [ch for ch in c.get("/api/agents/projects/blockswap").json()["channels"]
           if ch["channel"] == "eng/blockswap"][0]
    assert eng["preview_url"] == "http://<tailnet-host>:5173/"       # the bad URL never landed
    assert eng["status"] == "preview"
    # Events never become chat; merged work lands quietly in the Feed.
    msgs = c.get("/api/agents/projects/blockswap/messages",
                 params={"endpoint_id": ep.id, "channel": "pm/blockswap"}).json()["messages"]
    assert msgs == []
    merged = [i for i in c.get("/api/feed").json()["items"] if i["type"] == "merged"]
    assert merged[0]["title"] == "Spec 009: swap page"
    assert notifications.list_notifications(sqlite3.connect(path)) == []
    # The firehose is kept in the user's run log, never as chat.
    con = sqlite3.connect(path)
    assert con.execute("SELECT items FROM agent_firehose_files WHERE project = 'blockswap'"
                       ).fetchone() == (1,)
    print("✓ events: status line + firehose marker, merged to Feed, http(s) previews only")


def test_health_badge_unreachable_and_paused_by_user(monkeypatch):
    c, path, hub = _fresh()
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    assert c.get("/api/agents/projects").json()["projects"][0]["health"]["state"] == "ok"
    run(hub._frame(ep, {"type": "health", "state": "degraded",
                        "detail": "git host unreachable, retrying every 30 s"}))
    h = c.get("/api/agents/projects").json()["projects"][0]["health"]
    assert h["state"] == "degraded" and h["endpoints"][0]["health"]["since"]
    run(hub._frame(ep, {"type": "health", "state": "ok"}))
    hub._disconnected(ep, ws)
    hub.endpoints[ep.id].disconnected_at -= 60          # silent past the grace
    h = c.get("/api/agents/projects").json()["projects"][0]["health"]
    assert h["state"] == "degraded"
    assert h["endpoints"][0]["health"]["state"] == "unreachable"
    assert notifications.list_notifications(sqlite3.connect(path)) == []   # badge only
    monkeypatch.setattr(gate_client, "paused_by_user", lambda: True)
    h = c.get("/api/agents/projects").json()["projects"][0]["health"]
    assert h["state"] == "paused" and "you" in h["detail"]
    print("✓ health: one badge, unreachable detected here, paused-by-you wins")


def _note(c, title, tags, body="Build the swap page."):
    r = c.post("/api/notes/drafts", json={"title": title, "body": body, "tags": tags})
    assert r.status_code == 200, r.text
    did = r.json()["draft"]["id"] if "draft" in r.json() else r.json()["id"]
    assert c.post(f"/api/notes/drafts/{did}/approve").status_code == 200


def test_note_send_staged_by_model_and_resend_keeps_the_id():
    c, path, hub = _fresh()
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    _note(c, "Swap page intent", ["project", "blockswap"])
    _note(c, "Loose idea", ["idea"])
    st = c.get("/api/agents/notes/Swap page intent").json()
    assert st["can_send"] and st["target"]["label"] == "pm-blockswap" and not st["staged"]
    assert not c.get("/api/agents/notes/Loose idea").json()["can_send"]

    # The model stages; nothing goes out until the user presses send.
    out = main._stage_note_send(path, "Swap page intent", "Here's the intent")
    assert out["staged"] and not ws.of("message")
    assert main._stage_note_send(path, "Loose idea", None)["error"]
    st = c.get("/api/agents/notes/Swap page intent").json()
    assert st["staged"]["comment"] == "Here's the intent"
    r = c.post("/api/agents/notes/Swap page intent/send", json={}).json()
    first = ws.of("message")[-1]
    assert first["note"]["title"] == "Swap page intent"
    assert first["text"].startswith("Here's the intent\n\n# Swap page intent")
    assert r["staged"] is None and r["last_sent"]
    # Sending again is a new message with the same note id (an update).
    c.post("/api/agents/notes/Swap page intent/send", json={"comment": ""})
    second = ws.of("message")[-1]
    assert second["id"] != first["id"] and second["note"]["id"] == first["note"]["id"]
    print("✓ notes: model stages, user sends, resend keeps the note id")


def test_model_tool_reads_messages_only_marked_as_agent_output():
    c, path, hub = _fresh()
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    run(hub._frame(ep, {"type": "message", "project": "blockswap", "channel": "pm/blockswap",
                        "id": "m1", "seq": 1, "text": "The login bug is a CORS issue."}))
    run(hub._frame(ep, {"type": "firehose", "project": "blockswap", "channel": "eng/blockswap",
                        "text": "secret firehose line about login"}))
    schemas, execute, _ = main._build_tools(path)
    names = [s["function"]["name"] for s in schemas]
    assert "read_agent_messages" in names and "stage_note_send" in names
    out = json.loads(execute("read_agent_messages", {"query": "login"}))
    assert out["agent_output"] is True and "Untrusted" in out["warning"]
    assert [m["text"] for m in out["messages"]] == ["The login bug is a CORS issue."]
    assert out["messages"][0]["channel"] == "pm-blockswap"
    # Recall never reaches it: a fresh user with no agents gets neither tool.
    c2, path2, _ = _fresh()
    names2 = [s["function"]["name"] for s in main._build_tools(path2)[0]]
    assert "read_agent_messages" not in names2 and "stage_note_send" not in names2
    print("✓ model tool: stored messages only, marked untrusted, absent without agents")


def test_unified_search_finds_agent_messages_for_the_user():
    c, path, hub = _fresh()
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    run(hub._frame(ep, {"type": "message", "project": "blockswap", "channel": "pm/blockswap",
                        "id": "m1", "seq": 1, "text": "Deploy blocked on the cert renewal"}))
    groups = c.get("/api/find", params={"q": "cert renewal"}).json()["groups"]
    g = [x for x in groups if x["scope"] == "agents"][0]
    assert g["items"][0]["title"] == "pm-blockswap" and g["items"][0]["project"] == "blockswap"
    print("✓ unified search: agent conversations are one of the piles")


def test_question_shape_fallback_and_normalising():
    assert agents.normalize_question({"id": "q", "prompt": "ok?", "options": ["Allow", "Block"]})[
        "options"] == [{"id": "Allow", "label": "Allow"}, {"id": "Block", "label": "Block"}]
    q = agents.normalize_question({"id": "q", "prompt": "Pick", "multiple": True,
                                   "options": [{"id": "a", "label": "A"}]})
    assert q["multiple"] is False and q["freeform"] is False
    assert agents.normalize_question({"prompt": "no id"}) is None
    c, path, hub = _fresh()
    ws, ep = _paired(c, hub)
    _team(hub, ep)
    run(hub._frame(ep, {"type": "message", "project": "blockswap", "channel": "pm/blockswap",
                        "id": "m1", "seq": 1, "text": "", "question": {"prompt": "Proceed?"}}))
    msgs = c.get("/api/agents/projects/blockswap/messages",
                 params={"endpoint_id": ep.id, "channel": "pm/blockswap"}).json()["messages"]
    assert msgs[0]["question"] is None and msgs[0]["text"] == "Proceed?"
    print("✓ unrecognised question shapes fall back to plain text")


def test_real_socket_pairing_and_catch_up():
    """End to end over a real WebSocket on its own listener."""
    from websockets.asyncio.client import connect
    c, path, hub = _fresh()

    async def scenario():
        server = await hub.start("127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await ws.send(json.dumps({"type": "hello", "key": KEY, "name": "solo"}))
                pairing = json.loads(await ws.recv())
                assert pairing["status"] == "pending"
                await hub.approve(pairing["endpoint_id"], "default")
                assert json.loads(await ws.recv())["type"] == "welcome"
                await ws.send(json.dumps({"type": "channel", "project": "solo",
                                          "channel": "main", "label": "session",
                                          "accepts_input": True, "firehose": True}))
                await ws.send(json.dumps({"type": "message", "project": "solo",
                                          "channel": "main", "id": "a", "seq": 1,
                                          "text": "hello"}))
                ack = json.loads(await ws.recv())
                assert ack == {"type": "ack", "project": "solo", "channel": "main",
                               "seq": 1, "id": "a"}
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await ws.send(json.dumps({"type": "hello", "key": KEY, "name": "solo"}))
                welcome = json.loads(await ws.recv())
                assert welcome["acked"] == {"solo/main": 1}
        finally:
            await hub.stop()

    run(scenario())
    print("✓ real socket: pair, declare, message, ack, reconnect where it left off")
