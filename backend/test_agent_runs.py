"""Run logs (agent_runs): usage, firehose and timeline recorded per user, and
a report that names its gaps instead of filling them."""

import gzip
import json
import os
import sqlite3

import agent_runs
import main
from test_agent_requests import FakeWS, KEY, _fresh, _pm, run


def _db():
    return main.agents.hub().db_for_user(next(iter(main.agents.hub().endpoints.values())).user_key)


def _usage(hub, ep, total, turn=None, channel="pm", model="m-1"):
    f = {"type": "usage", "project": "tidepool", "channel": channel, "ts": "2026-10-25T18:00:00Z",
         "model": model, "total": total}
    if turn:
        f["turn"] = turn
    run(hub._frame(ep, f))


def _fire(hub, ep, seq, text="line", replay=False, channel="pm"):
    f = {"type": "firehose", "project": "tidepool", "channel": channel, "text": text,
         "kind": "tool", "ts": f"2026-10-25T18:{seq % 60:02d}:00Z"}
    if seq is not None:
        f["seq"] = seq
    if replay:
        f["replay"] = True
    run(hub._frame(ep, f))


def test_usage_totals_dedupe_and_reset():
    c, hub = _fresh()
    ws, ep = _pm(c, hub)
    t1 = {"input": 100, "output": 10, "cache_read": 0, "cache_write": 0, "calls": 2, "cost": 0.01}
    _usage(hub, ep, t1, turn=t1)
    _usage(hub, ep, t1)                                  # the copy resent at a welcome
    t2 = {**t1, "input": 300, "calls": 5, "cost": 0.05}
    _usage(hub, ep, t2, turn={**t1, "input": 200})
    conn = sqlite3.connect(_db())
    assert conn.execute("SELECT COUNT(*) FROM agent_usage").fetchone()[0] == 2
    rep = c.get("/api/agents/projects/tidepool/run").json()
    role = rep["roles"][0]
    assert role["role"] == "pm" and role["usage"]["input"] == 300
    assert role["usage"]["models"] == ["m-1"] and rep["totals"]["cost"] == 0.05
    # The count going backwards (it shouldn't): each run of it adds up.
    _usage(hub, ep, {**t1, "input": 50, "cost": 0.002})
    rep = c.get("/api/agents/projects/tidepool/run").json()
    assert rep["roles"][0]["usage"]["input"] == 350
    assert "backwards" in rep["roles"][0]["usage"]["note"]
    print("✓ usage: welcome resends dropped, running totals, resets add up")


def test_firehose_stored_in_the_users_dir_with_gaps_counted():
    c, hub = _fresh()
    ws, ep = _pm(c, hub)
    for s in (1, 2, 3):
        _fire(hub, ep, s, text=f"step {s}")
    _fire(hub, ep, 2, replay=True)                       # already stored: dropped
    _fire(hub, ep, 7, text="after a hole")              # 4..6 never arrived
    db_path = _db()
    folder = agent_runs.runs_dir(db_path)
    assert folder.startswith(os.path.dirname(os.path.abspath(db_path)))
    lines = [json.loads(x) for root, _, fs in os.walk(folder) for f in fs
             for x in open(os.path.join(root, f))]
    assert [l["seq"] for l in lines] == [1, 2, 3, 7]
    rep = c.get("/api/agents/projects/tidepool/run").json()
    fh = rep["roles"][0]["firehose"]
    assert fh["lines"] == 4 and fh["missing_lines"] == 3 and fh["sequenced"]
    assert any(g["what"] == "firehose lines missing" and g["count"] == 3 for g in rep["gaps"])
    # A replay fills the hole; the count follows.
    _fire(hub, ep, 5, replay=True)
    rep = c.get("/api/agents/projects/tidepool/run").json()
    assert rep["roles"][0]["firehose"]["missing_lines"] == 2
    # The endpoint starting its count again is a new epoch, not duplicates.
    _fire(hub, ep, 1, text="fresh start")
    rep = c.get("/api/agents/projects/tidepool/run").json()
    assert rep["roles"][0]["firehose"]["lines"] == 6
    assert any(g["what"] == "firehose sequence restarted" for g in rep["gaps"])
    assert rep["roles"][0]["firehose"]["missing_lines"] == 2
    log = c.get("/api/agents/projects/tidepool/run/log", params={"query": "hole"}).json()
    assert log["agent_output"] and [l["text"] for l in log["lines"]] == ["after a hole"]
    print("✓ firehose: in the user's dir, replays dropped, holes counted, epochs")


def test_reconnect_asks_for_a_replay_and_unclean_ends_are_gaps():
    c, hub = _fresh()
    ws, ep = _pm(c, hub)
    _fire(hub, ep, 1)
    _fire(hub, ep, 2)
    # Collaborator stops without seeing a close; the endpoint comes back.
    ws2 = FakeWS()
    ep2 = run(hub._hello(ws2, {"type": "hello", "key": KEY, "name": "pm-box"}))
    run(hub._frame(ep2, {"type": "channel", "project": "tidepool", "channel": "pm",
                         "label": "pm", "firehose": True}))
    assert ws2.of("history_request") == [{"type": "history_request", "project": "tidepool",
                                          "channel": "pm", "from_seq": 3}]
    run(hub._frame(ep2, {"type": "channel", "project": "tidepool", "channel": "pm",
                         "busy": True}))
    assert len(ws2.of("history_request")) == 1           # once per connection
    rep = c.get("/api/agents/projects/tidepool/run").json()
    ended = [s["ended"] for s in rep["connections"]]
    assert ended[0].startswith("ended without a clean close") and ended[-1] == "connected now"
    # A clean close, then nothing: "not connected since".
    hub._disconnected(hub.endpoints[ep2.id], ws2)
    rep = c.get("/api/agents/projects/tidepool/run").json()
    assert rep["connections"][-1]["ended"] == "disconnected"
    assert any(g["what"] == "not connected" and g["to"] is None for g in rep["gaps"])
    print("✓ reconnect: replay asked from one past the last; unclean ends reported")


def test_timeline_keeps_changes_only():
    c, hub = _fresh()
    ws, ep = _pm(c, hub)
    for busy in (True, True, False):
        run(hub._frame(ep, {"type": "channel", "project": "tidepool", "channel": "pm",
                            "busy": busy, "status": "writing tests"}))
    run(hub._frame(ep, {"type": "event", "project": "tidepool", "channel": "pm",
                        "event": "milestone", "text": "Milestone: board renders"}))
    for _ in range(2):                                    # resent at every welcome
        run(hub._frame(ep, {"type": "request_status", "id": "r-1", "kind": "merge",
                            "project": "tidepool", "state": "done", "text": "merged"}))
    conn = sqlite3.connect(_db())
    kinds = [k for (k,) in conn.execute("SELECT kind FROM agent_run_events "
                                        "WHERE project = 'tidepool' ORDER BY id")]
    assert kinds.count("busy") == 1 and kinds.count("idle") == 1
    assert kinds.count("status") == 1 and kinds.count("request") == 1
    rep = c.get("/api/agents/projects/tidepool/run").json()
    tl = [(e["kind"], e.get("state") or e.get("text")) for e in rep["timeline"]]
    assert ("event", "Milestone: board renders") in tl and ("request", "done") in tl
    assert rep["roles"][0]["usage"] is None
    assert any(g["what"] == "no usage recorded" for g in rep["gaps"])
    print("✓ timeline: busy/idle, statuses and request states recorded once each")


def test_nothing_recorded_says_so_and_old_days_are_gzipped():
    c, hub = _fresh()
    rep = c.get("/api/agents/projects/never/run").json()
    assert rep["recorded"] is False and "do not reconstruct" in rep["note"]
    ws, ep = _pm(c, hub)
    _fire(hub, ep, 1, text="today")
    db_path = _db()
    conn = sqlite3.connect(db_path)
    rel = conn.execute("SELECT dir FROM agent_firehose_files").fetchone()[0]
    folder = os.path.join(agent_runs.runs_dir(db_path), rel)
    today = os.listdir(folder)[0]
    os.rename(os.path.join(folder, today), os.path.join(folder, "2026-01-01.jsonl"))
    _fire(hub, ep, 2, text="next day")
    names = sorted(os.listdir(folder))
    assert names[0] == "2026-01-01.jsonl.gz" and names[1].endswith(".jsonl")
    with gzip.open(os.path.join(folder, names[0]), "rt") as fh:
        assert "today" in fh.read()
    log = c.get("/api/agents/projects/tidepool/run/log").json()
    assert [l["text"] for l in log["lines"]] == ["today", "next day"]
    print("✓ nothing recorded is said plainly; earlier days are gzipped and still read")


def test_tools_offered_and_categorised():
    c, hub = _fresh()
    ws, ep = _pm(c, hub)
    _usage(hub, ep, {"input": 1, "output": 1, "calls": 1, "cost": 0})
    db_path = _db()
    schemas, execute, _ = main._build_tools(db_path)
    names = {s["function"]["name"] for s in schemas}
    assert {"run_report", "read_run_log"} <= names
    out = json.loads(execute("run_report", {"project": "tidepool"}))
    assert out["agent_output"] and out["how_to_report"]
    assert main.tool_log._CATEGORY["run_report"] == "reads"
    print("✓ run_report and read_run_log are offered once a run is recorded")


def test_each_users_run_log_is_their_own():
    import tempfile
    from agents import Hub, _Endpoint
    dirs = {u: tempfile.mkdtemp() for u in ("alice", "bob")}
    hub = Hub(lambda u: os.path.join(dirs[u], "conversations.db"),
              lambda: os.path.join(tempfile.mkdtemp(), "registry.db"))
    for u in dirs:
        ep = _Endpoint(f"ep-{u}", f"{u}-box", "fp", u)
        hub.endpoints[ep.id] = ep
        run(hub._frame(ep, {"type": "firehose", "project": "tidepool", "channel": "pm",
                            "text": f"{u} only", "seq": 1}))
        run(hub._frame(ep, {"type": "usage", "project": "tidepool", "channel": "pm",
                            "total": {"input": 1, "cost": 0.5 if u == "alice" else 0.25}}))
    for u in dirs:
        db_path = os.path.join(dirs[u], "conversations.db")
        conn = sqlite3.connect(db_path)
        log = agent_runs.read_log(conn, db_path, "tidepool")
        assert [l["text"] for l in log["lines"]] == [f"{u} only"]
        rep = agent_runs.run_report(conn, db_path, "tidepool")
        assert rep["totals"]["cost"] == (0.5 if u == "alice" else 0.25)
        assert agent_runs.runs_dir(db_path).startswith(dirs[u])
    print("✓ run logs live in each user's own data dir and DB")
