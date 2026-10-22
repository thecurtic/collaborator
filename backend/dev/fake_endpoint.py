"""A fake agent endpoint: replays scripted sessions so the agent UI can be
built and tested without real agents (dev tooling, never deployed).

It speaks the endpoint side of the seam (API-SPEC.md, "Agent endpoints"):
hello with its own key, discovery, channels, messages with per-channel
sequence numbers (resent from where Collaborator left off), firehose lines,
events, health, questions, and history replay.

    backend/.venv/bin/python backend/dev/fake_endpoint.py ws://127.0.0.1:8765 --scenario team

Scenarios:
  team       a PM channel that accepts input, two read-only channels with
             firehoses, handoff/audit events, a merge question, a preview
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
    await s.send({"type": "discovery", "projects": [{"tag": s.project, "state": "active"}]})
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
    await s.event("frontend", "work_complete", "frontend: spec 009 done → auditor",
                  work_item="spec-009", commit="9f3c2ab")
    await s.channel("auditor", "auditor", False, True, "auditing spec 009")
    for t in ("Checking out spec-009", "Running the Playwright checks", "8/8 passed"):
        await asyncio.sleep(1.5)
        await s.line("auditor", t)
    await s.event("auditor", "audit", "auditor: Spec 009 PASS → PM", work_item="spec-009")
    await s.event("frontend", "preview", "Try the swap page",
                  url="http://<tailnet-host>:5173/")
    await asyncio.sleep(1)
    await s.say("pm", "Spec 009 passed audit. There's a preview link on the frontend channel.",
                question={"id": f"merge-{next(s.ids)}", "prompt": "Merge spec 009 to main?",
                          "options": [{"id": "merge", "label": "Merge"},
                                      {"id": "hold", "label": "Not yet",
                                       "description": "Tell me what's wrong first"}]})
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
