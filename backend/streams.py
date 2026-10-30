"""Streamed replies that can be stopped, and that keep what they said.

A client gives each streamed turn an id (`stream_id`). Stopping it is a
request (POST /api/streams/{id}/stop), not a dropped connection: the
generator sees the flag between events, ends the model call, saves the
exchange so far and finishes normally, and the stop request returns once
it's saved, so the client knows the turns exist before it reloads.

A connection that drops without asking (a hang-up, the network) gets the
same outcome through `closing()`: Starlette just stops iterating a
generator whose client left, so the code after the loop (the save) would
never run. `closing()` lets the step in flight finish, then closes the
generator, whose GeneratorExit handler saves what it has.
"""

import asyncio
import threading
import time
from typing import Dict, Iterator, Optional

from starlette.concurrency import run_in_threadpool

_KEEP_SECONDS = 600


class Stream:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.stop = threading.Event()
        self.saved = threading.Event()
        self.result: Dict = {}
        self.started = time.time()

    def stopped(self) -> bool:
        return self.stop.is_set()

    def mark_saved(self, **result) -> None:
        self.result = result
        self.saved.set()


_lock = threading.Lock()
_streams: Dict[str, Stream] = {}


def register(stream_id: Optional[str], db_path: str) -> Optional[Stream]:
    """Track a stream by its client-given id (None when the client gave none)."""
    if not stream_id:
        return None
    now = time.time()
    with _lock:
        for sid in [s for s, st in _streams.items() if now - st.started > _KEEP_SECONDS]:
            _streams.pop(sid, None)
        st = Stream(db_path)
        _streams[stream_id] = st
        return st


def get(stream_id: str) -> Optional[Stream]:
    with _lock:
        return _streams.get(stream_id)


async def request_stop(stream_id: str, db_path: str, wait: float = 15.0) -> Dict:
    """Flag a stream to stop and wait (bounded) until its turns are saved.
    A stream that's unknown (already finished and gone) counts as saved."""
    st = get(stream_id)
    if st is None or st.db_path != db_path:
        return {"saved": st is None, "known": False}
    st.stop.set()
    saved = await asyncio.to_thread(st.saved.wait, wait)
    return {"saved": saved, "known": True, **st.result}


_END = object()
_closers: set = set()


def closing(gen: Iterator[str]):
    """An async stream over a sync generator that closes it (letting it save)
    when the client goes away, after the step it's in finishes."""
    it = iter(gen)

    async def run():
        pending = None
        try:
            while True:
                pending = asyncio.ensure_future(run_in_threadpool(next, it, _END))
                # Shielded: a disconnect must not cancel the step mid-flight,
                # or the generator would still be running when we close it.
                chunk = await asyncio.shield(pending)
                pending = None
                if chunk is _END:
                    return
                yield chunk
        finally:
            async def close(step):
                if step is not None:
                    try:
                        await step
                    except BaseException:
                        pass
                await run_in_threadpool(it.close)

            task = asyncio.ensure_future(close(pending))
            _closers.add(task)
            task.add_done_callback(_closers.discard)

    return run()
