"""Tests for signed team requests (agent_requests.py + the hub): the shared
test vector, the key pair, the PM mark, New project, merge questions with a
proposal, request_status, resend until a status, withdraw and hide, and that
no model tool can reach the signer."""

import asyncio
import inspect
import json
import os
import stat
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, agents, agent_requests, notifications
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient

KEY = "k" * 40
VECTOR = os.path.join(os.path.dirname(__file__), "..", "docs",
                      "request-signing-test-vector.json")


class FakeWS:
    def __init__(self):
        self.sent, self.closed = [], False

    async def send(self, text):
        self.sent.append(json.loads(text))

    async def close(self):
        self.closed = True

    def of(self, t):
        return [f for f in self.sent if f.get("type") == t]


def run(coro):
    return asyncio.run(coro)


def _fresh(monkeypatch=None, key=True):
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["agents"]["request_signing_key_file"] = os.path.join(tempfile.mkdtemp(), "keys", "k.key")
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    c = TestClient(main.app)
    if key:
        assert c.post("/api/agents/signing-key", json={}).status_code == 200
    return c, main.agents.hub()


def _pm(c, hub, caps=("create_project", "merge"), mark=True, key=KEY, name="pm-box"):
    ws = FakeWS()
    ep = run(hub._hello(ws, {"type": "hello", "key": key, "name": name}))
    c.post(f"/api/agents/endpoints/{ep.id}/approve")
    ep = hub.endpoints[ep.id]
    run(hub._frame(ep, {"type": "discovery", "projects": [{"tag": "tidepool"}],
                        "capabilities": list(caps)}))
    run(hub._frame(ep, {"type": "channel", "project": "tidepool", "channel": "pm",
                        "label": "pm", "accepts_input": True}))
    if mark:
        assert c.put("/api/agents/pm", json={"endpoint_id": ep.id}).status_code == 200
    return ws, ep


def _merge_question(hub, ep, qid="mq-1", mid="m-1", seq=1):
    run(hub._frame(ep, {
        "type": "message", "project": "tidepool", "channel": "pm", "id": mid, "seq": seq,
        "text": "Milestone: viewer renders the whole city",
        "question": {"id": qid, "prompt": "Merge integration into main for tidepool?",
                     "options": [{"id": "merge", "label": "Merge"},
                                 {"id": "not_now", "label": "Not now"}],
                     "proposal": {"approve_option": "merge",
                                  "body": {"v": 1, "kind": "merge", "project": "tidepool",
                                           "from": "integration", "to": "main",
                                           "from_sha": "8e41c0d" + "0" * 33,
                                           "to_sha": "2b7f9aa" + "0" * 33},
                                  "summary": "Milestone: viewer renders the whole city",
                                  "commits": 12}}}))


def _messages(c):
    return c.get("/api/agents/projects/tidepool/messages",
                 params={"endpoint_id": next(iter(main.agents.hub().endpoints)),
                         "channel": "pm"}).json()["messages"]


def test_shared_test_vector_reproduces_exactly():
    with open(VECTOR, encoding="utf-8") as f:
        vec = json.load(f)
    seed = bytes.fromhex(vec["key"]["private_seed_hex"])
    raw = bytes.fromhex(vec["key"]["public_key_raw_hex"])
    assert agent_requests.public_key_text(raw) == vec["key"]["public_key"]
    assert agent_requests.key_fingerprint(raw) == vec["key"]["fingerprint"]
    assert {c["kind"] for c in vec["cases"]} == {"create_project", "merge", "withdraw"}
    for case in vec["cases"]:
        assert agent_requests.canonical_bytes(case["body"]).decode("utf-8") == case["canonical"]
        env = agent_requests.sign_body(case["body"], seed, vec["key"]["key_id"])
        assert env == case["envelope"]
        assert agent_requests.verify_envelope(env, vec["key"]["public_key"])
        tampered = json.loads(json.dumps(env))
        tampered["body"]["v"] = 2
        assert not agent_requests.verify_envelope(tampered, vec["key"]["public_key"])
    print("✓ shared test vector: key, fingerprint, canonical bytes, signatures")


def test_ids_and_key_pair():
    rid = agent_requests.new_id()
    assert rid.startswith("r-") and len(rid) == 28
    assert not set(rid[2:]) & set("ILOU")
    c, hub = _fresh(key=False)
    assert c.get("/api/agents/signing-key").status_code == 404
    k = c.post("/api/agents/signing-key", json={}).json()
    assert k["public_key"].startswith("ed25519:") and len(k["public_key"]) == 52
    assert k["key_id"].startswith("collab-") and len(k["fingerprint"]) == 19
    mode = stat.S_IMODE(os.stat(agent_requests.key_path()).st_mode)
    assert mode == 0o600
    assert "private" not in json.dumps(c.get("/api/agents/signing-key").json())
    assert c.post("/api/agents/signing-key", json={}).status_code == 409
    k2 = c.post("/api/agents/signing-key", json={"replace": True}).json()
    assert k2["public_key"] != k["public_key"] and k2["key_id"] == k["key_id"] + "-2"
    print("✓ key pair: made once, 0600, public half only, replace = new key_id")


def test_new_project_needs_the_pm_and_the_key(monkeypatch):
    c, hub = _fresh(key=False)
    notes = []
    monkeypatch.setattr(notifications, "notify", lambda *a, **k: notes.append(a) or {"id": 1})
    ws, ep = _pm(c, hub, mark=False)
    # Declared by an endpoint that isn't marked: ignored, named once.
    assert len(notes) == 1 and "pm-box" in notes[0][2]
    run(hub._frame(ep, {"type": "discovery", "projects": ["tidepool"],
                        "capabilities": ["create_project"]}))
    assert len(notes) == 1
    form = {"kind": "create_project", "name": "reef", "description": "Coral\nsurvey",
            "intents_md": "# Reef\n\nCount the corals.", "roles": ["pm", "backend"]}
    r = c.post("/api/agents/requests", json=form)
    assert r.status_code == 409 and "PM" in r.json()["detail"]
    c.put("/api/agents/pm", json={"endpoint_id": ep.id})
    assert c.post("/api/agents/requests", json=form).status_code == 409   # no key yet
    key = c.post("/api/agents/signing-key", json={}).json()
    assert c.post("/api/agents/requests", json={**form, "name": "Bad Name"}).status_code == 422

    req = c.post("/api/agents/requests", json=form).json()["request"]
    assert req["state"] == "sending" and req["kind"] == "create_project"
    env = ws.of("request")[-1]["request"]
    assert env["key_id"] == key["key_id"]
    assert agent_requests.verify_envelope(env, key["public_key"])
    b = env["body"]
    assert b["name"] == "reef" and b["description"] == "Coral survey"
    assert b["roles"] == ["pm", "backend"] and "kickoff" not in b
    assert b["id"] == req["id"] and b["issued_at"].endswith("Z")
    assert "reef" in c.get("/api/projects/overrides").json()["pinned"]
    eps = c.get("/api/agents/endpoints").json()["paired"]
    assert eps[0]["pm"] and eps[0]["capabilities"] == ["create_project"]
    print("✓ New project: only to the marked PM, only with a key; signed, pinned")


def test_resend_until_a_status_and_notify_once(monkeypatch):
    c, hub = _fresh()
    notes = []
    monkeypatch.setattr(notifications, "notify", lambda *a, **k: notes.append(a) or {"id": 1})
    ws, ep = _pm(c, hub)
    req = c.post("/api/agents/requests", json={
        "kind": "create_project", "name": "reef", "description": "d",
        "intents_md": "i"}).json()["request"]
    ws2 = FakeWS()
    run(hub._hello(ws2, {"type": "hello", "key": KEY, "name": "pm-box"}))
    assert [f["request"]["body"]["id"] for f in ws2.of("request")] == [req["id"]]
    ep = hub.endpoints[ep.id]
    run(hub._frame(ep, {"type": "request_status", "id": req["id"], "kind": "create_project",
                        "project": "reef", "state": "accepted", "text": "queued"}))
    ws3 = FakeWS()
    run(hub._hello(ws3, {"type": "hello", "key": KEY, "name": "pm-box"}))
    assert ws3.of("request") == []
    ep = hub.endpoints[ep.id]
    for _ in range(2):      # the snapshot on every welcome repeats the latest status
        run(hub._frame(ep, {"type": "request_status", "id": req["id"], "state": "failed",
                            "step": "create", "text": "repo exists"}))
    assert sum(1 for n in notes if "failed" in n[2]) == 1
    # An id Collaborator never sent (pushed by hand) is a new row.
    run(hub._frame(ep, {"type": "request_status", "id": "r-HAND", "kind": "merge",
                        "project": "tidepool", "state": "done", "text": "merged"}))
    rows = {r["id"]: r for r in c.get("/api/agents/requests").json()["requests"]}
    assert rows[req["id"]]["state"] == "failed" and rows["r-HAND"]["state"] == "done"
    # Status from an endpoint that isn't the PM is ignored.
    ws4 = FakeWS()
    other = run(hub._hello(ws4, {"type": "hello", "key": "o" * 40, "name": "eng-box"}))
    c.post(f"/api/agents/endpoints/{other.id}/approve")
    run(hub._frame(hub.endpoints[other.id], {"type": "request_status", "id": req["id"],
                                              "state": "done"}))
    assert {r["id"]: r for r in c.get("/api/agents/requests").json()["requests"]}[
        req["id"]]["state"] == "failed"
    print("✓ resend until a status; welcome snapshots notify once; unknown ids are rows")


def test_merge_question_signs_exactly_the_proposal():
    c, hub = _fresh()
    ws, ep = _pm(c, hub)
    key = c.get("/api/agents/signing-key").json()
    _merge_question(hub, ep)
    q = _messages(c)[0]
    assert q["question"]["proposal"]["commits"] == 12
    r = c.post(f"/api/agents/questions/{q['id']}/answer", json={"option_ids": ["merge"]})
    assert r.status_code == 200
    env = ws.of("request")[-1]["request"]
    proposed = {"v": 1, "kind": "merge", "project": "tidepool", "from": "integration",
                "to": "main", "from_sha": "8e41c0d" + "0" * 33, "to_sha": "2b7f9aa" + "0" * 33}
    assert set(env["body"]) == set(proposed) | {"id", "issued_at"}
    assert {k: env["body"][k] for k in proposed} == proposed
    assert agent_requests.verify_envelope(env, key["public_key"])
    # The request goes before the ordinary answer.
    kinds = [f["type"] for f in ws.sent if f["type"] in ("request", "message")]
    assert kinds[-2:] == ["request", "message"]
    card = _messages(c)[0]
    assert card["request"]["id"] == env["body"]["id"] and card["request"]["state"] == "sending"

    # Not now signs nothing.
    _merge_question(hub, ep, qid="mq-2", mid="m-2", seq=2)
    q2 = _messages(c)[1]
    before = len(ws.of("request"))
    c.post(f"/api/agents/questions/{q2['id']}/answer", json={"option_ids": ["not_now"]})
    assert len(ws.of("request")) == before
    print("✓ Merge signs exactly the proposal + id + issued_at; Not now signs nothing")


def test_test_build_round_trip_signs_nothing_and_carries_the_link():
    # PSM r10: Test is an ordinary answer; the manager closes the card and
    # sends a new question for the same proposal with the link in its text.
    c, hub = _fresh()
    ws, ep = _pm(c, hub)
    proposal = {"approve_option": "merge", "summary": "Milestone: viewer",
                "body": {"v": 1, "kind": "merge", "project": "tidepool",
                         "from_sha": "a" * 40, "to_sha": "b" * 40}}
    opts = [{"id": "merge", "label": "Merge"}, {"id": "test", "label": "Test"},
            {"id": "not_now", "label": "Not now"}]
    run(hub._frame(ep, {"type": "message", "project": "tidepool", "channel": "pm",
                        "id": "m-1", "seq": 1, "text": "Milestone: viewer",
                        "question": {"id": "mq-1", "prompt": "Merge?", "options": opts,
                                     "proposal": proposal}}))
    q = _messages(c)[0]
    assert [o["id"] for o in q["question"]["options"]] == ["merge", "test", "not_now"]
    c.post(f"/api/agents/questions/{q['id']}/answer", json={"option_ids": ["test"]})
    assert ws.of("request") == []
    run(hub._frame(ep, {"type": "question_closed", "project": "tidepool", "question_id": "mq-1",
                        "outcome": {"text": "building it now"}}))
    link = "http://<tailnet-address>:8123/"
    run(hub._frame(ep, {"type": "message", "project": "tidepool", "channel": "pm",
                        "id": "m-2", "seq": 2, "text": f"Test build ready: {link}",
                        "question": {"id": "mq-1-r1", "prompt": "Merge?",
                                     "options": [opts[0], {"id": "rebuild", "label": "Rebuild"},
                                                 opts[2]], "proposal": proposal}}))
    feed = [i for i in c.get("/api/feed").json()["items"] if i["type"] == "agent_question"]
    assert len(feed) == 1 and link in feed[0]["ref"]["text"]
    assert feed[0]["ref"]["question"]["proposal"]["approve_option"] == "merge"
    q2 = next(m for m in _messages(c) if (m["question"] or {}).get("id") == "mq-1-r1")
    c.post(f"/api/agents/questions/{q2['id']}/answer", json={"option_ids": ["merge"]})
    assert len(ws.of("request")) == 1
    print("✓ Test/Rebuild sign nothing; the rebuilt card carries the link to the Feed")


def test_proposal_from_another_endpoint_is_an_ordinary_question(monkeypatch):
    c, hub = _fresh()
    notes = []
    monkeypatch.setattr(notifications, "notify", lambda *a, **k: notes.append(a) or {"id": 1})
    ws, ep = _pm(c, hub, mark=False, caps=())
    _merge_question(hub, ep)
    q = _messages(c)[0]
    assert "proposal" not in q["question"] and any("pm-box" in n[2] for n in notes)
    c.post(f"/api/agents/questions/{q['id']}/answer", json={"option_ids": ["merge"]})
    assert ws.of("request") == []
    print("✓ a proposal from a non-PM endpoint signs nothing and is named")


def test_merge_without_a_key_leaves_the_question_open():
    c, hub = _fresh(key=False)
    ws, ep = _pm(c, hub)
    _merge_question(hub, ep)
    q = _messages(c)[0]
    r = c.post(f"/api/agents/questions/{q['id']}/answer", json={"option_ids": ["merge"]})
    assert r.status_code == 409
    assert _messages(c)[0]["question_state"] == "open" and ws.of("request") == []
    print("✓ no key: Merge refuses and the question stays open")


def test_withdraw_and_hide():
    c, hub = _fresh()
    ws, ep = _pm(c, hub)
    key = c.get("/api/agents/signing-key").json()
    req = c.post("/api/agents/requests", json={
        "kind": "create_project", "name": "reef", "description": "d",
        "intents_md": "i"}).json()["request"]
    assert c.post(f"/api/agents/requests/{req['id']}/hide").status_code == 409   # still open
    w = c.post("/api/agents/requests", json={"kind": "withdraw", "target": req["id"]})
    assert w.status_code == 200 and w.json()["request"]["kind"] == "withdraw"
    env = ws.of("request")[-1]["request"]
    assert env["body"]["target"] == req["id"] and agent_requests.verify_envelope(
        env, key["public_key"])
    assert c.post("/api/agents/requests", json={
        "kind": "withdraw", "target": w.json()["request"]["id"]}).status_code == 422
    assert c.post("/api/agents/requests", json={"kind": "withdraw",
                                                 "target": "r-NOPE"}).status_code == 404
    run(hub._frame(hub.endpoints[ep.id], {"type": "request_status", "id": req["id"],
                                           "state": "withdrawn", "text": "withdrawn"}))
    assert c.post("/api/agents/requests", json={"kind": "withdraw",
                                                 "target": req["id"]}).status_code == 422
    assert c.post(f"/api/agents/requests/{req['id']}/hide").json()["request"]["hidden"]
    rows = c.get("/api/agents/requests").json()["requests"]
    assert rows[0]["kind"] == "withdraw"          # open first
    print("✓ withdraw: signed, only open ones; hide: only finished ones")


def test_forgetting_the_pm_clears_the_mark():
    c, hub = _fresh()
    ws, ep = _pm(c, hub)
    c.delete(f"/api/agents/endpoints/{ep.id}")
    r = c.post("/api/agents/requests", json={"kind": "create_project", "name": "reef",
                                             "description": "d", "intents_md": "i"})
    assert r.status_code == 409
    print("✓ forgetting the PM endpoint clears the mark")


def test_no_model_tool_can_reach_the_signer():
    import agent_tools, scratch, inference, tool_log
    for mod in (agent_tools, scratch, inference, tool_log):
        assert "agent_requests" not in inspect.getsource(mod), mod.__name__
    src = inspect.getsource(main._build_tools)
    assert "agent_requests" not in src and "sign" not in src.replace("design", "")
    schemas, _, _ = main._build_tools(os.environ["DB_PATH"])
    names = {s["function"]["name"] for s in schemas}
    assert not {n for n in names if "sign" in n or "request" in n or "merge" in n}
    # The default key file is not under the vault or the users' data
    # (attachments, Scratch media), the stores the model reads from.
    defaults = config.load_config()
    path = os.path.realpath(config.resolve_path(defaults["agents"]["request_signing_key_file"]))
    vault = config.vault_dir_for(config.resolve_path("backend/data/conversations.db"),
                                 defaults["notes"]["vault_dir"], False)
    for store in (vault, config.resolve_path("backend/data/users")):
        assert not path.startswith(os.path.realpath(store) + os.sep)
    print("✓ the signer is out of the model's reach")


def test_project_team_summary():
    c, hub = _fresh(key=False)
    assert c.get("/api/agents/projects/tidepool/team").json()["start"] == "no_endpoints"
    ws, ep = _pm(c, hub, mark=False)
    assert c.get("/api/agents/projects/tidepool/team").json()["start"] == "no_pm"
    c.put("/api/agents/pm", json={"endpoint_id": ep.id})
    assert c.get("/api/agents/projects/tidepool/team").json()["start"] == "no_key"
    c.post("/api/agents/signing-key", json={})
    t = c.get("/api/agents/projects/reef/team").json()
    assert t["start"] == "ok" and not t["served"] and t["start_request"] is None
    req = c.post("/api/agents/requests", json={
        "kind": "create_project", "name": "reef", "description": "d", "intents_md": "i",
        "note_title": "Reef survey"}).json()["request"]
    assert req["note_title"] == "Reef survey"
    env = ws.of("request")[-1]["request"]
    assert "note_title" not in env["body"]                 # never signed
    t = c.get("/api/agents/projects/reef/team").json()
    assert t["start_request"]["id"] == req["id"] and t["start_request"]["state"] == "sending"

    run(hub._frame(ep, {"type": "message", "project": "tidepool", "channel": "pm", "id": "m-0",
                        "seq": 9, "text": "Which colour?",
                        "question": {"id": "q-plain", "prompt": "Blue or green?",
                                     "options": [{"id": "b", "label": "Blue"}]}}))
    _merge_question(hub, ep)
    run(hub._frame(ep, {"type": "event", "project": "tidepool", "channel": "pm",
                        "event": "merged", "text": "Spec 3: the board"}))
    run(hub._frame(ep, {"type": "usage", "project": "tidepool", "channel": "pm",
                        "total": {"input": 10, "output": 2, "calls": 1, "cost": 0.25}}))
    t = c.get("/api/agents/projects/tidepool/team").json()
    assert t["served"]
    assert [q["question"]["id"] for q in t["questions"]] == ["mq-1", "q-plain"]
    assert t["questions"][0]["label"] == "pm"
    assert t["last_merge"]["text"] == "Spec 3: the board"
    assert t["usage"]["cost"] == 0.25 and t["usage"]["roles"] == 1
    # Merge pressed: the card stays, with its request, until the request finishes.
    mid = t["questions"][0]["id"]
    c.post(f"/api/agents/questions/{mid}/answer", json={"option_ids": ["merge"]})
    q = c.get("/api/agents/projects/tidepool/team").json()["questions"]
    assert q[0]["id"] == mid and q[0]["question_state"] != "open"
    assert q[0]["request"]["state"] == "sending"
    rid = q[0]["request"]["id"]
    run(hub._frame(ep, {"type": "request_status", "id": rid, "state": "done", "text": "merged"}))
    q = c.get("/api/agents/projects/tidepool/team").json()["questions"]
    assert [x["question"]["id"] for x in q] == ["q-plain"]
    print("✓ team summary: start state, start request + its note, open questions, merge, cost")
