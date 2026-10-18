"""inference-gate: lets background agents share LM Studio, but holds their
requests while Collaborator is in use.

Self-contained on purpose: this folder runs on the inference Mac on its own,
imports nothing from the rest of the repository, and can be copied out of it.
See README.md (install, config, logs) and docs/CONTROL_API.md (the contract
Collaborator's switch uses).

The gate holds one boolean, `paused`, and forwards everything else untouched:
- every path under /v1/* goes to UPSTREAM_URL, method/headers/query/body
  unchanged minus hop-by-hop headers, and the response streams back as it
  arrives (SSE included), with no upstream read timeout;
- only POST is gated: while paused, a new POST is held open (nothing is sent
  to the client) until resume, then released in arrival order; GET (e.g.
  /v1/models) always passes;
- requests already forwarded finish normally; nothing is cancelled;
- a held client that disconnects is dropped and never forwarded;
- /gate/status, /gate/pause, /gate/resume (bearer token) are the control API.

`paused` is in memory only and starts false: a restart resumes the agents.
"""

import asyncio
import collections
import hmac
import itertools
import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Deque, Optional

from aiohttp import ClientSession, ClientTimeout, web

API_VERSION = 1

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}

log = logging.getLogger("inference-gate")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Gate:
    """The state: one boolean plus counters, and the FIFO of held requests."""

    def __init__(self, max_concurrent: Optional[int] = None):
        self.paused = False
        self.paused_since: Optional[str] = None
        self.in_flight = 0
        self.total_forwarded = 0
        self.held: Deque[asyncio.Future] = collections.deque()
        self.slots = asyncio.Semaphore(max_concurrent) if max_concurrent else None

    def status(self) -> dict:
        return {
            "api_version": API_VERSION,
            "paused": self.paused,
            "paused_since": self.paused_since,
            "queued": len(self.held),
            "in_flight": self.in_flight,
            "total_forwarded": self.total_forwarded,
        }

    def pause(self) -> bool:
        """Idempotent; paused_since keeps the first timestamp. True if it changed."""
        if self.paused:
            return False
        self.paused = True
        self.paused_since = _now_iso()
        return True

    def resume(self) -> bool:
        """Idempotent; releases every held request in arrival order."""
        changed = self.paused
        self.paused = False
        self.paused_since = None
        while self.held:
            fut = self.held.popleft()
            if not fut.done():
                fut.set_result(None)
        return changed


GATE = web.AppKey("gate", Gate)
UPSTREAM = web.AppKey("upstream", str)
TOKEN = web.AppKey("token", str)
SESSION = web.AppKey("session", ClientSession)


def _client_gone(request: web.Request) -> bool:
    transport = request.transport
    return transport is None or transport.is_closing()


async def _wait_until_released(gate: Gate, request: web.Request, rid: str) -> bool:
    """Hold while paused. False when the client disconnected meanwhile."""
    if not gate.paused:
        return True
    fut = asyncio.get_running_loop().create_future()
    gate.held.append(fut)
    log.info("[%s] held (queued=%d)", rid, len(gate.held))
    if len(gate.held) > 8:
        log.warning("%d requests held — more than expected", len(gate.held))
    try:
        while True:
            try:
                await asyncio.wait_for(asyncio.shield(fut), timeout=1.0)
                log.info("[%s] released", rid)
                return True
            except asyncio.TimeoutError:
                if _client_gone(request):
                    log.info("[%s] client disconnected while held; dropped", rid)
                    return False
    finally:
        if not fut.done():
            fut.cancel()
        try:
            gate.held.remove(fut)
        except ValueError:
            pass


def _authorized(request: web.Request) -> bool:
    token = request.app[TOKEN]
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[7:].encode(), token.encode())


async def control(request: web.Request) -> web.Response:
    gate: Gate = request.app[GATE]
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    action = request.match_info["action"]
    if action == "status":
        if request.method != "GET":
            return web.json_response({"error": "use GET"}, status=405)
    elif action in ("pause", "resume"):
        if request.method != "POST":
            return web.json_response({"error": "use POST"}, status=405)
        changed = gate.pause() if action == "pause" else gate.resume()
        if changed:
            log.info("state change: %s by %s at %s", "paused" if action == "pause"
                     else "resumed", request.remote, _now_iso())
    else:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(gate.status())


_ids = itertools.count(1)


async def proxy(request: web.Request) -> web.StreamResponse:
    gate: Gate = request.app[GATE]
    rid = f"{next(_ids):05d}"
    log.info("[%s] arrival %s %s", rid, request.method, request.path_qs)
    body = await request.read()

    if request.method == "POST":
        if not await _wait_until_released(gate, request, rid):
            return web.Response(status=499)

    if gate.slots:
        await gate.slots.acquire()
    gate.in_flight += 1
    gate.total_forwarded += 1
    started = time.monotonic()
    try:
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
        upstream = request.app[UPSTREAM] + request.path_qs
        session: ClientSession = request.app[SESSION]
        async with session.request(request.method, upstream, headers=headers,
                                   data=body if body else None,
                                   allow_redirects=False) as up:
            out = web.StreamResponse(status=up.status, reason=up.reason)
            for k, v in up.headers.items():
                if k.lower() not in HOP_BY_HOP and k.lower() != "content-encoding":
                    out.headers[k] = v
            await out.prepare(request)
            async for piece in up.content.iter_any():
                await out.write(piece)
            await out.write_eof()
            log.info("[%s] finished %d in %.1fs", rid, up.status, time.monotonic() - started)
            return out
    except (ConnectionResetError, asyncio.CancelledError):
        log.info("[%s] client disconnected mid-response", rid)
        raise
    except Exception as e:  # upstream down, refused, …
        log.warning("[%s] upstream error: %s", rid, e)
        return web.json_response({"error": f"upstream unavailable: {e.__class__.__name__}"},
                                 status=502)
    finally:
        gate.in_flight -= 1
        if gate.slots:
            gate.slots.release()


def build_app(upstream: str, token: str, max_concurrent: Optional[int] = None) -> web.Application:
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app[UPSTREAM] = upstream.rstrip("/")
    app[TOKEN] = token

    async def startup(app):
        app[GATE] = Gate(max_concurrent)
        # No read timeout: a long generation must never be cut off here.
        app[SESSION] = ClientSession(timeout=ClientTimeout(total=None, connect=30,
                                                             sock_read=None),
                                       auto_decompress=False)

    async def cleanup(app):
        await app[SESSION].close()

    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
    app.router.add_route("*", "/gate/{action}", control)
    app.router.add_route("*", "/v1/{tail:.*}", proxy)
    return app


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(),
                        format="%(asctime)s %(levelname)s %(message)s",
                        stream=sys.stdout)
    token = os.environ.get("GATE_TOKEN", "").strip()
    if not token:
        sys.exit("GATE_TOKEN is required (see .env.example); refusing to start")
    cap = os.environ.get("MAX_CONCURRENT_UPSTREAM", "").strip()
    app = build_app(os.environ.get("UPSTREAM_URL", "http://127.0.0.1:1234"), token,
                    int(cap) if cap else None)
    host = os.environ.get("GATE_HOST", "0.0.0.0")
    port = int(os.environ.get("GATE_PORT", "8080"))
    log.info("inference-gate on %s:%d → %s (unpaused)", host, port, app[UPSTREAM])
    web.run_app(app, host=host, port=port, print=None, access_log=None)


if __name__ == "__main__":
    main()
