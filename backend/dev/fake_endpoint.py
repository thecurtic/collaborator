"""A fake agent endpoint: replays scripted sessions so the agent UI can be
built and tested without real agents (dev tooling, never deployed).

It speaks the endpoint side of the seam (API-SPEC.md, "Agent endpoints"):
hello with its own key, discovery, channels, messages with per-channel
sequence numbers (resent from where Collaborator left off), firehose lines,
events, health, questions, and history replay.

    backend/.venv/bin/python backend/dev/fake_endpoint.py ws://127.0.0.1:8765 --scenario team

Scenarios:
  team       a PM channel that accepts input, two read-only channels with
             firehoses, handoff/audit events, a preview, and a merge question
             with a proposal. It declares create_project and merge, so mark it
             as the PM in Settings → Agents to try New project, Merge and
             Withdraw: it answers each request with request_status frames
             (pass --public-key to check the signatures)
  solo       one channel that accepts input and has a firehose
  drop       team, but the connection drops every ~40 s and catches up
  silent     connects, then goes quiet and stays away (Collaborator should
             mark it unreachable)
  multi      a project with two channels that accept input
  unmatched  a project tag Collaborator has no notes for

The key lives in --key-file (default: .fake-endpoint-<scenario>.key in the
current directory) so approval sticks across runs; delete it to pair again.
"""

import argparse
import asyncio
import itertools
import json
import os
import random
import secrets
import sys
import time

from websockets.asyncio.client import connect


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Session:
    """The endpoint's own state: what it has said (so it can resend), what
    Collaborator has acked, open questions."""

    def __init__(self, scenario, project):
        self.scenario, self.project = scenario, project
        self.seq = {}            # channel -> last seq used
        self.log = {}            # channel -> [message frames]
        self.firehose = {}       # channel -> [firehose frames]
        self.acked = {}          # channel -> highest seq Collaborator stored
        self.questions = {}      # question id -> (channel, question)
        self.ws = None
        self.player = None       # the script keeps playing across reconnects
        self.ids = itertools.count(1)
        self.run = secrets.token_hex(3)   # ids stay unique across restarts
        self.extra_projects = []  # made by create_project requests
        self.statuses = {}        # request id -> latest request_status (the snapshot)
        self.public_key = None
        self.usage = {}           # channel -> latest usage frame (sent again at a welcome)

    async def send(self, frame):
        if self.ws is not None:
            try:
                await self.ws.send(json.dumps(frame))
            except Exception:
                pass

    async def say(self, channel, text, needs_reply=False, question=None):
        n = self.seq[channel] = self.seq.get(channel, 0) + 1
        frame = {"type": "message", "project": self.project, "channel": channel,
                 "id": f"{channel}-{self.run}-{n}", "seq": n, "ts": now(), "text": text}
        if needs_reply:
            frame["needs_reply"] = True
        if question:
            frame["question"] = question
            self.questions[question["id"]] = (channel, question)
        self.log.setdefault(channel, []).append(frame)
        await self.send(frame)

    async def line(self, channel, text, kind="text"):
        lst = self.firehose.setdefault(channel, [])
        frame = {"type": "firehose", "project": self.project, "channel": channel,
                 "seq": len(lst) + 1, "ts": now(), "kind": kind, "text": text}
        lst.append(frame)
        await self.send(frame)

    async def turn_done(self, channel, model="fake/model-1"):
        """A `usage` frame after a turn that called the model (PSM r11)."""
        turn = {"input": random.randint(2000, 20000), "output": random.randint(100, 2000),
                "cache_read": random.randint(0, 90000), "cache_write": 0,
                "calls": random.randint(1, 8)}
        turn["cost"] = round(turn["input"] * 1e-6 + turn["output"] * 4e-6, 6)
        prev = (self.usage.get(channel) or {}).get("total") or {k: 0 for k in turn}
        total = {k: round(prev[k] + turn[k], 6) for k in turn}
        frame = {"type": "usage", "project": self.project, "channel": channel, "ts": now(),
                 "model": model, "turn": turn, "total": total}
        self.usage[channel] = frame
        await self.send(frame)

    async def event(self, channel, event, text, **extra):
        await self.send({"type": "event", "project": self.project, "channel": channel,
                         "event": event, "text": text, "ts": now(), **extra})

    async def channel(self, channel, label, accepts_input, firehose, status="", busy=False):
        await self.send({"type": "channel", "project": self.project, "channel": channel,
                         "label": label, "accepts_input": accepts_input,
                         "firehose": firehose, "status": status, "busy": busy})


THINKING = ["Reading the spec", "Looking at src/swap/Page.tsx", "Running npm test",
            "3 passed, 1 failed: quote rounding", "Fixing the rounding in quote.ts",
            "Re-running tests", "All 4 passed", "Committing on spec-009"]


async def declare(s: Session):
    """Discovery + channels for the scenario."""
    sc = s.scenario
    await discover(s)
    for p in s.extra_projects:
        await s.send({"type": "channel", "project": p, "channel": "pm", "label": f"pm-{p}",
                      "accepts_input": True, "firehose": False, "status": "idle"})
    if sc in ("team", "drop", "silent"):
        await s.channel("pm", f"pm-{s.project}", True, False, "idle")
        await s.channel("frontend", "frontend", False, True, "waiting for work")
        await s.channel("auditor", "auditor", False, True, "idle")
    elif sc == "solo":
        await s.channel("session", "session", True, True, "idle")
    elif sc == "multi":
        await s.channel("pm", f"pm-{s.project}", True, False, "idle")
        await s.channel("design", "design-lead", True, True, "idle")
    elif sc == "unmatched":
        await s.channel("pm", f"pm-{s.project}", True, False, "idle")
    await s.send({"type": "health", "state": "ok"})


async def discover(s: Session):
    frame = {"type": "discovery", "projects": [{"tag": p, "state": "active"}
                                               for p in [s.project, *s.extra_projects]]}
    if s.scenario in ("team", "drop"):
        frame["capabilities"] = ["create_project", "merge"]
    await s.send(frame)


async def status(s: Session, body, state, text, step=None):
    frame = {"type": "request_status", "id": body["id"], "kind": body["kind"],
             "project": body.get("project") or body.get("name"), "state": state,
             "text": text, "updated_at": now()}
    if step:
        frame["step"] = step
    s.statuses[body["id"]] = frame
    await s.send(frame)


async def handle_request(s: Session, envelope):
    """What the PM's manager and the keeper would do, compressed: statuses
    for each step, a new project for create_project, a merge, a withdrawal."""
    body = (envelope or {}).get("body") or {}
    if not body.get("id"):
        return
    if s.public_key:
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
        import agent_requests
        ok = agent_requests.verify_envelope(envelope, s.public_key)
        print(f"Request {body['id']} ({body['kind']}): signature {'valid' if ok else 'INVALID'}")
        if not ok:
            await status(s, body, "refused", "signature does not verify", "validate")
            return
    if body["id"] in s.statuses:
        return                      # a resend: the snapshot already covers it
    kind = body["kind"]
    await status(s, body, "accepted", "queued for the keeper")
    await asyncio.sleep(1.5)
    if kind == "withdraw":
        target = s.statuses.get(body["target"])
        if target and target["state"] in ("accepted", "waiting"):
            await status(s, {**body, "id": target["id"], "kind": target["kind"],
                             "project": target["project"]}, "withdrawn", "withdrawn by you")
            await status(s, body, "done", f"withdrew {body['target']}")
        else:
            await status(s, body, "refused", "already done or unknown", "validate")
        return
    if kind == "merge":
        await status(s, body, "progress", "merging", "merge")
        await asyncio.sleep(2)
        sha = secrets.token_hex(20)
        await status(s, body, "done", f"Merged as {sha[:7]}", "push")
        for qid, (channel, q) in list(s.questions.items()):
            if (q.get("proposal") or {}).get("body", {}).get("from_sha") == body.get("from_sha"):
                s.questions.pop(qid)
                await s.send({"type": "question_closed", "project": s.project, "question_id": qid,
                              "outcome": {"option_ids": ["merge"], "reason": f"merged as {sha[:7]}"}})
        await s.event("pm", "merged", "Spec 009: swap page", commit=sha[:7])
        await s.say("pm", f"Merged spec 009 to main as {sha[:7]}.")
        return
    await status(s, body, "progress", "creating the repo", "create")
    await asyncio.sleep(2)
    await status(s, body, "waiting", "frontend has not reported ready", "ready")
    await asyncio.sleep(20)          # long enough to try Withdraw
    if s.statuses[body["id"]]["state"] == "withdrawn":
        return
    s.extra_projects.append(body["name"])
    await discover(s)
    await s.send({"type": "channel", "project": body["name"], "channel": "pm",
                  "label": f"pm-{body['name']}", "accepts_input": True, "firehose": False,
                  "status": "idle"})
    await status(s, body, "done", "kickoff pushed", "kickoff")


async def catch_up(s: Session, acked):
    """Resend every message Collaborator hasn't stored (welcome.acked), and
    keep numbering after what it has (a restarted fake starts from empty)."""
    for key, seq in acked.items():
        project, _, channel = key.partition("/")
        if project == s.project:
            s.seq[channel] = max(s.seq.get(channel, 0), seq)
    for channel, frames in s.log.items():
        last = acked.get(f"{s.project}/{channel}", 0)
        for f in frames:
            if f["seq"] > last:
                await s.send(f)


async def reply_to(s: Session, frame):
    """What the input channel does with a message from the user."""
    channel = frame["channel"]
    if frame.get("answer"):
        a = frame["answer"]
        _, q = s.questions.pop(a["question_id"], (None, None))
        await s.send({"type": "ack", "id": frame["id"]})
        if q is None:
            return
        if "merge" in a.get("option_ids", []) and q.get("proposal"):
            s.questions[a["question_id"]] = (channel, q)   # closes when the merge lands
            return
        await s.send({"type": "question_closed", "project": s.project,
                      "question_id": a["question_id"],
                      "outcome": {"option_ids": a.get("option_ids", []), "text": a.get("text", ""),
                                  "reason": "answered"}})
        if "merge" in a.get("option_ids", []):
            await s.event("pm", "merged", "Spec 009: swap page", commit=secrets.token_hex(4))
            await s.say(channel, "Merged spec 009 to main. The swap page is live on the test branch.")
        else:
            await s.say(channel, "Understood, sending it back to the team.")
        return
    await s.send({"type": "ack", "id": frame["id"]})
    note = frame.get("note")
    label = "session" if s.scenario == "solo" else channel
    await s.channel(channel, label if s.scenario == "solo" else
                    (f"pm-{s.project}" if channel == "pm" else "design-lead"),
                    True, s.scenario == "solo" or channel == "design", "thinking", busy=True)
    if s.scenario == "solo" or channel == "design":
        for t in random.sample(THINKING, 4):
            await asyncio.sleep(0.6)
            await s.line(channel, t, kind="thinking")
    else:
        await asyncio.sleep(1.5)
    if note:
        text = f"Got the note \"{note['title']}\". I'll derive a spec from it and queue it."
    else:
        text = f"On it: \"{frame.get('text', '')[:80]}\""
    await s.say(channel, text)
    await s.turn_done(channel)
    await s.channel(channel, label if s.scenario == "solo" else
                    (f"pm-{s.project}" if channel == "pm" else "design-lead"),
                    True, s.scenario == "solo" or channel == "design", "idle", busy=False)


async def script(s: Session):
    """The scripted session that plays while connected (team-shaped)."""
    sc = s.scenario
    if sc not in ("team", "drop"):
        if sc == "solo":
            await asyncio.sleep(2)
            await s.say("session", "Ready. What should I work on?")
        elif sc == "multi":
            await s.say("pm", "Two of us take input here: me and the design lead.")
        elif sc == "unmatched":
            await s.say("pm", "This project only exists on the backend so far.")
        return
    await asyncio.sleep(2)
    await s.say("pm", "Picked up spec 009 (swap page). Handing it to frontend.")
    await s.event("pm", "handoff", "PM → frontend: spec 009", work_item="spec-009")
    await s.event("frontend", "handoff", "frontend: building spec 009", work_item="spec-009")
    for t in THINKING:
        await asyncio.sleep(1.2)
        await s.line("frontend", t, kind="tool" if "Running" in t else "text")
    await s.turn_done("frontend")
    await s.event("frontend", "work_complete", "frontend: spec 009 done → auditor",
                  work_item="spec-009", commit="9f3c2ab")
    await s.channel("auditor", "auditor", False, True, "auditing spec 009")
    for t in ("Checking out spec-009", "Running the Playwright checks", "8/8 passed"):
        await asyncio.sleep(1.5)
        await s.line("auditor", t)
    await s.turn_done("auditor", model="fake/model-2")
    await s.event("auditor", "audit", "auditor: Spec 009 PASS → PM", work_item="spec-009")
    await s.event("frontend", "preview", "Try the swap page",
                  url="http://<tailnet-host>:5173/")
    await asyncio.sleep(1)
    await s.say("pm", "Milestone: spec 009, the swap page, passed audit. There's a preview "
                      "link on the frontend channel.",
                question={"id": f"merge-{s.run}-{next(s.ids)}",
                          "prompt": f"Merge integration into main for {s.project}?",
                          "options": [{"id": "merge", "label": "Merge"},
                                      {"id": "not_now", "label": "Not now"}],
                          "proposal": {
                              "approve_option": "merge",
                              "body": {"v": 1, "kind": "merge", "project": s.project,
                                       "from": "integration", "to": "main",
                                       "from_sha": secrets.token_hex(20),
                                       "to_sha": secrets.token_hex(20)},
                              "summary": "Milestone: spec 009, the swap page",
                              "commits": 7}})
    await asyncio.sleep(8)
    await s.send({"type": "health", "state": "degraded",
                  "detail": "git host unreachable, retrying every 30 s"})
    await asyncio.sleep(10)
    await s.send({"type": "health", "state": "ok"})
    await s.say("pm", "Frontend has been idle for 10 minutes with nothing queued.",
                needs_reply=True)


async def run_once(url, s: Session, key, name):
    async with connect(url) as ws:
        s.ws = ws
        await ws.send(json.dumps({"type": "hello", "key": key, "name": name, "protocol": 1}))
        while True:
            first = json.loads(await ws.recv())
            if first.get("type") == "pairing":
                print(f"Waiting for approval in Collaborator (Settings → Agents). "
                      f"Fingerprint: {first['fingerprint']}")
                continue
            if first.get("type") == "welcome":
                print(f"Paired as {first['endpoint_id']}.")
                break
            print(f"Refused: {first}")
            return False
        await declare(s)
        await catch_up(s, first.get("acked") or {})
        for f in s.statuses.values():       # the snapshot on every welcome
            await s.send(f)
        for f in s.usage.values():          # latest usage again, without its turn
            await s.send({k: v for k, v in f.items() if k != "turn"})
        if s.player is None:
            s.player = asyncio.ensure_future(script(s))
        drop_at = time.time() + 40 if s.scenario == "drop" else None
        try:
            while True:
                timeout = None if drop_at is None else max(0.1, drop_at - time.time())
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
                except asyncio.TimeoutError:
                    print("Dropping the connection (drop scenario)…")
                    return True
                frame = json.loads(raw)
                t = frame.get("type")
                if t == "message":
                    asyncio.ensure_future(reply_to(s, frame))
                elif t == "request":
                    asyncio.ensure_future(handle_request(s, frame.get("request")))
                elif t == "ack":
                    s.acked[frame["channel"]] = frame["seq"]
                elif t == "history_request":
                    lst = s.firehose.get(frame["channel"], [])
                    for f in lst:
                        if f["seq"] >= frame.get("from_seq", 0):
                            await s.send({**f, "replay": True})
                if s.scenario == "silent" and s.log:
                    print("Going silent (silent scenario): closing and staying away.")
                    return False
        finally:
            s.ws = None


async def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("url", help="Collaborator's agents.listen address, ws://host:port")
    ap.add_argument("--scenario", default="team",
                    choices=["team", "solo", "drop", "silent", "multi", "unmatched"])
    ap.add_argument("--project", help="project tag (default per scenario)")
    ap.add_argument("--name", help="endpoint name shown in Collaborator")
    ap.add_argument("--key-file")
    ap.add_argument("--public-key", help="Collaborator's request signing key "
                    "(ed25519:…, from Settings → Agents) to verify requests with")
    a = ap.parse_args()
    project = a.project or {"unmatched": "orphan-project", "solo": "scratchpad-agent"}.get(
        a.scenario, "blockswap")
    key_file = a.key_file or f".fake-endpoint-{a.scenario}.key"
    if os.path.exists(key_file):
        key = open(key_file).read().strip()
    else:
        key = secrets.token_urlsafe(32)
        with open(key_file, "w") as f:
            f.write(key)
        os.chmod(key_file, 0o600)
    s = Session(a.scenario, project)
    s.public_key = a.public_key
    name = a.name or f"fake-{a.scenario}"
    while True:
        try:
            again = await run_once(a.url, s, key, name)
        except (OSError, Exception) as e:
            if e.__class__.__name__.startswith("ConnectionClosed") or isinstance(e, OSError):
                print(f"Connection lost ({e.__class__.__name__}); retrying in 3 s")
                again = True
            else:
                raise
        if not again:
            if a.scenario == "silent":
                await asyncio.sleep(3600)
            return
        await asyncio.sleep(3)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
