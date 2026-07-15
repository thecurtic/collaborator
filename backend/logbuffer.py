"""In-process log ring buffer so the agent can read its own recent logs.

Captures the backend's output two ways and keeps the last N lines in memory:
- a tee on sys.stdout/sys.stderr (print() warnings, stray tracebacks), and
- a logging.Handler on the root + uvicorn loggers (request logs, framework
  errors — these hold their own stream references, so the tee alone misses them).

This works identically under systemd, nohup, or a dev shell — no journalctl
permissions, no log-file paths — and the normal log destinations are untouched
(the tee passes everything through). The buffer is lost on restart by design:
the point is "what just went wrong", not history.
"""

import sys
import time
import logging
from collections import deque

_BUFFER = deque(maxlen=2000)


def _append(line: str) -> None:
    if line.strip():
        _BUFFER.append((time.strftime("%Y-%m-%d %H:%M:%S"), line.rstrip()))


class _Tee:
    def __init__(self, stream):
        self._stream = stream
        self._partial = ""

    def write(self, data):
        try:
            self._stream.write(data)
        except Exception:
            pass
        self._partial += data
        while "\n" in self._partial:
            line, self._partial = self._partial.split("\n", 1)
            _append(line)
        return len(data)

    def flush(self):
        try:
            self._stream.flush()
        except Exception:
            pass

    def __getattr__(self, name):
        return getattr(self._stream, name)


class _BufferHandler(logging.Handler):
    def emit(self, record):
        try:
            _append(self.format(record))
        except Exception:
            pass


def install() -> None:
    """Idempotent: safe to call again (e.g. module reloads in tests)."""
    if not isinstance(sys.stdout, _Tee):
        sys.stdout = _Tee(sys.stdout)
    if not isinstance(sys.stderr, _Tee):
        sys.stderr = _Tee(sys.stderr)

    handler = _BufferHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    # Root catches propagated records; uvicorn's loggers don't propagate, so
    # attach to them directly. Guard against double-attach on reinstall.
    for logger in [logging.getLogger()] + [
            logging.getLogger(n) for n in ("uvicorn", "uvicorn.error", "uvicorn.access")]:
        if not any(isinstance(h, _BufferHandler) for h in logger.handlers):
            logger.addHandler(handler)


def get_lines(limit: int = 100, grep: str = None) -> list:
    """Most recent captured lines (timestamped), optionally case-insensitive
    filtered, capped at 500."""
    try:
        limit = int(limit or 100)
    except (TypeError, ValueError):
        limit = 100
    limit = max(1, min(limit, 500))
    lines = [f"{ts} {line}" for ts, line in _BUFFER]
    if grep:
        needle = str(grep).lower()
        lines = [l for l in lines if needle in l.lower()]
    return lines[-limit:]
