"""Acceptance tests for the gate (Inference Gate build spec), against a fake
upstream that streams slowly. Run from this folder:

    .venv/bin/python -m pytest -q
"""

import asyncio
import json

import pytest
from aiohttp import ClientSession, ClientTimeout, web
from aiohttp.test_utils import TestServer

import gate

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def _upstream_app(seen):
    async def models(request):
        return web.json_response({"data": [{"id": "fake-model"}]})

    async def chat(request):
        body = await request.json()
        seen.append(body.get("tag"))
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await resp.prepare(request)
        for i in range(int(body.get("chunks", 3))):
            await resp.write(f"data: {json.dumps({'i': i, 'tag': body.get('tag')})}\n\n".encode())
            await asyncio.sleep(float(body.get("delay", 0.05)))
        await resp.write(b"data: [DONE]\n\n")
        await resp.write_eof()
        return resp

    app = web.Application()
    app.router.add_get("/v1/models", models)
    app.router.add_post("/v1/chat/completions", chat)
    return app


def run(coro):
    return asyncio.run(coro)


class Rig:
    """A fake upstream, the gate in front of it, and a client session."""

    def __init__(self, max_concurrent=None):
        self.seen = []
        self.max_concurrent = max_concurrent

    async def __aenter__(self):
        self.up = TestServer(_upstream_app(self.seen))
        await self.up.start_server()
        self.app = gate.build_app(str(self.up.make_url("")), TOKEN, self.max_concurrent)
        self.gw = TestServer(self.app)
        await self.gw.start_server()
        self.s = ClientSession(timeout=ClientTimeout(total=60))
        return self

    async def __aexit__(self, *exc):
        await self.s.close()
        await self.gw.close()
        await self.up.close()

    def url(self, path):
        return str(self.gw.make_url(path))

    async def status(self):
        async with self.s.get(self.url("/gate/status"), headers=AUTH) as r:
            return await r.json()

    async def ctl(self, action, headers=AUTH):
        async with self.s.post(self.url(f"/gate/{action}"), headers=headers) as r:
            return r.status, await r.json()

    async def chat(self, tag, **kw):
        async with self.s.post(self.url("/v1/chat/completions"),
                               json={"tag": tag, **kw}) as r:
            return r.status, await r.read()


async def _until(pred, timeout=5.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if await pred():
            return True
        await asyncio.sleep(0.02)
    return False


def test_unpaused_stream_matches_direct():
    async def go():
        async with Rig() as rig:
            status, via_gate = await rig.chat("a")
            async with rig.s.post(str(rig.up.make_url("/v1/chat/completions")),
                                  json={"tag": "a"}) as r:
                direct = await r.read()
            assert status == 200 and via_gate == direct and b"[DONE]" in via_gate
            assert (await rig.status())["total_forwarded"] == 1
    run(go())


def test_paused_post_is_held_and_get_passes():
    async def go():
        async with Rig() as rig:
            await rig.ctl("pause")
            task = asyncio.create_task(rig.chat("held"))
            assert await _until(lambda: _queued(rig, 1))
            assert rig.seen == []                       # nothing reached upstream
            async with rig.s.get(rig.url("/v1/models")) as r:
                assert r.status == 200 and (await r.json())["data"][0]["id"] == "fake-model"
            assert not task.done()
            await rig.ctl("resume")
            status, body = await task
            assert status == 200 and b"[DONE]" in body
    run(go())


async def _queued(rig, n):
    return (await rig.status())["queued"] == n


def test_pause_mid_stream_lets_it_finish():
    async def go():
        async with Rig() as rig:
            task = asyncio.create_task(rig.chat("long", chunks=10, delay=0.05))
            assert await _until(lambda: _in_flight(rig, 1))
            await rig.ctl("pause")
            status, body = await task
            assert status == 200 and body.count(b"data:") == 11
            assert (await rig.status())["in_flight"] == 0
    run(go())


async def _in_flight(rig, n):
    return (await rig.status())["in_flight"] == n


def test_held_requests_release_in_arrival_order():
    async def go():
        async with Rig(max_concurrent=1) as rig:
            await rig.ctl("pause")
            tasks = []
            for i, tag in enumerate(["first", "second", "third"]):
                tasks.append(asyncio.create_task(rig.chat(tag, chunks=1)))
                assert await _until(lambda: _queued(rig, i + 1))
            await rig.ctl("resume")
            await asyncio.gather(*tasks)
            assert rig.seen == ["first", "second", "third"]
    run(go())


def test_held_client_that_disconnects_is_never_forwarded():
    async def go():
        async with Rig() as rig:
            await rig.ctl("pause")
            task = asyncio.create_task(rig.chat("gone"))
            assert await _until(lambda: _queued(rig, 1))
            task.cancel()                               # the client hangs up
            with pytest.raises(asyncio.CancelledError):
                await task
            assert await _until(lambda: _queued(rig, 0), timeout=5)
            await rig.ctl("resume")
            await asyncio.sleep(0.3)
            assert rig.seen == [] and (await rig.status())["total_forwarded"] == 0
    run(go())


def test_long_hold_still_completes():
    # The spec's 30-minute case, compressed: nothing in the gate times out a
    # held request (the hold loop only polls for a disconnect).
    async def go():
        async with Rig() as rig:
            await rig.ctl("pause")
            task = asyncio.create_task(rig.chat("patient"))
            await asyncio.sleep(2.5)
            assert not task.done()
            await rig.ctl("resume")
            assert (await task)[0] == 200
    run(go())


def test_control_needs_the_token_and_is_idempotent():
    async def go():
        async with Rig() as rig:
            assert (await rig.ctl("pause", headers={}))[0] == 401
            assert (await rig.ctl("pause", headers={"Authorization": "Bearer nope"}))[0] == 401
            async with rig.s.get(rig.url("/gate/status")) as r:
                assert r.status == 401
            assert (await rig.status())["paused"] is False
            _, first = await rig.ctl("pause")
            await asyncio.sleep(1.1)
            _, second = await rig.ctl("pause")
            assert second["paused"] and second["paused_since"] == first["paused_since"]
            _, r1 = await rig.ctl("resume")
            _, r2 = await rig.ctl("resume")
            assert r1 == r2 and r2["paused"] is False and r2["paused_since"] is None
            assert r2["api_version"] == 1
    run(go())


def test_upstream_down_is_a_502_not_a_hang():
    async def go():
        async with Rig() as rig:
            await rig.up.close()
            status, body = await rig.chat("x")
            assert status == 502 and b"upstream unavailable" in body
            assert (await rig.status())["in_flight"] == 0
    run(go())
