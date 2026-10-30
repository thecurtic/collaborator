"""Transcripts of the user's own audio and video files.

A file attached to a chat or captured in Scratch is transcribed only when
the user asks (holding send); a tap sends or saves it untouched. The text
lands in the same `transcripts` table as link transcripts, with `source`
saying where it came from ('attachment' | 'scratch') and `source_ref` naming
the item. Identical bytes from the same source reuse one transcript.

Jobs run one at a time on a background worker (speech-to-text is one model
on one machine); whoever asked gets a callback when the text is in, and a
long job also sends a notification, as long video transcripts do. A restart
re-queues whatever was still processing.

Video is transcribed from its audio track. With ffmpeg present (DEPLOY.md
lists it) the audio is first squeezed to 16 kHz mono Opus, so an hour of
recording uploads to the speech-to-text server as ~10 MB instead of the
original file.
"""

import os
import queue
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from typing import Callable, Dict, List, Optional, Tuple

import db as _db

SOURCES = ("attachment", "scratch")

# A job that ran this long gets a notification: the user has moved on.
_NOTIFY_AFTER_S = 20

_jobs: "queue.Queue[Tuple[str, int, str]]" = queue.Queue()
_queued: set = set()
_callbacks: Dict[Tuple[str, int], List[Callable]] = {}
_lock = threading.Lock()
_worker: Optional[threading.Thread] = None
_resumed: set = set()


def file_key(sha256: str) -> str:
    return f"file:{sha256}"


def probe_duration(path: str) -> Optional[int]:
    """Seconds of audio/video, or None when it can't be told."""
    try:
        import av
        with av.open(path) as container:
            if container.duration:
                return int(container.duration / 1_000_000)
    except Exception:
        pass
    if shutil.which("ffprobe"):
        try:
            out = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", path],
                capture_output=True, text=True, timeout=60)
            return int(float(out.stdout.strip()))
        except Exception:
            pass
    return None


def _max_minutes() -> int:
    from config import get_config
    cfg = (get_config().get("tools", {}) or {}).get("transcribe_video") or {}
    return int(cfg.get("max_minutes", 240))


def transcribe_path(path: str, duration_s: Optional[int]) -> str:
    """Blocking speech-to-text of one file (audio or video)."""
    import voice
    if not shutil.which("ffmpeg"):
        return voice.transcribe_batch(path, duration_s=duration_s)
    with tempfile.TemporaryDirectory() as tmp:
        squeezed = os.path.join(tmp, "audio.ogg")
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "libopus", "-b:a", "24k", squeezed],
            capture_output=True)
        if proc.returncode != 0 or not os.path.exists(squeezed):
            err = proc.stderr.decode(errors="replace").strip().splitlines()
            raise RuntimeError("couldn't read the audio: "
                               + (err[-1][:200] if err else "ffmpeg failed"))
        return voice.transcribe_batch(squeezed, duration_s=duration_s)


def _ensure_worker() -> None:
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_run, daemon=True,
                                   name="media-transcripts")
        _worker.start()


def _queue(db_path: str, transcript_id: int, path: str,
           on_done: Optional[Callable]) -> None:
    with _lock:
        if on_done:
            _callbacks.setdefault((db_path, transcript_id), []).append(on_done)
        if (db_path, transcript_id) in _queued:
            return
        _queued.add((db_path, transcript_id))
        _ensure_worker()
    _jobs.put((db_path, transcript_id, path))


def _finish(db_path: str, transcript_id: int, text: Optional[str],
            error: Optional[str]) -> None:
    with _lock:
        _queued.discard((db_path, transcript_id))
        callbacks = _callbacks.pop((db_path, transcript_id), [])
    for cb in callbacks:
        try:
            cb(text, error)
        except Exception as e:
            print(f"Warning: transcript #{transcript_id} callback failed: {e}")


def _run() -> None:
    while True:
        db_path, transcript_id, path = _jobs.get()
        started = time.monotonic()
        text, error, title = None, None, None
        conn = sqlite3.connect(db_path)
        try:
            row = _db.get_transcript(conn, transcript_id)
            if row is None:
                error = "the transcript was deleted"
            else:
                title = row.get("title")
                try:
                    from attachments import _cap
                    text = _cap(transcribe_path(path, row.get("duration_s")))
                    if not text:
                        error = "no speech was found in it"
                except Exception as e:
                    # Content-free logging: the error, never the text.
                    print(f"Warning: media transcript #{transcript_id} failed: {e}")
                    error = str(e)[:600] or "transcription failed"
                _db.set_transcript_result(conn, transcript_id,
                                          text=None if error else text,
                                          error=error)
        except Exception as e:
            print(f"Warning: media transcript worker: {e}")
            error = error or str(e)[:600]
        finally:
            conn.close()
        _finish(db_path, transcript_id, None if error else text, error)
        if time.monotonic() - started >= _NOTIFY_AFTER_S:
            import agent_tools
            agent_tools._notify_transcript(db_path, transcript_id,
                                           title or "A recording", error)


def start(db_path: str, path: str, *, sha256: str, title: Optional[str],
          source: str, source_ref: str,
          on_done: Optional[Callable[[Optional[str], Optional[str]], None]] = None
          ) -> dict:
    """Transcribe the file at `path` into a transcript row (returned at once,
    status 'processing', or 'done' when these bytes were transcribed before).
    `on_done(text, error)` runs when the text is in — at once for a reused
    transcript. Raises ValueError when the file is over the length cap."""
    assert source in SOURCES
    key = file_key(sha256)
    conn = sqlite3.connect(db_path)
    try:
        row = _db.get_transcript_by_key(conn, key, source)
        if row and row["status"] == "done":
            if on_done:
                on_done(row.get("text"), None)
            return row
        if row and row["status"] == "processing":
            _queue(db_path, row["id"], path, on_done)
            return row
        duration = probe_duration(path)
        cap = _max_minutes()
        if duration and duration > cap * 60:
            raise ValueError(f"it's {duration // 60} minutes long — over the "
                             f"{cap}-minute limit for transcripts")
        if row:                                   # failed before: try again
            _db.restart_transcript(conn, row["id"])
            row = _db.get_transcript(conn, row["id"])
        else:
            row = _db.create_file_transcript(conn, key, title, duration,
                                             source, source_ref)
    finally:
        conn.close()
    _queue(db_path, row["id"], path, on_done)
    return row


def _path_for(db_path: str, source_ref: Optional[str]) -> Optional[str]:
    """The stored file behind a transcript's source item."""
    kind, _, ident = (source_ref or "").partition(":")
    try:
        ident = int(ident)
    except ValueError:
        return None
    conn = sqlite3.connect(db_path)
    try:
        if kind == "attachment":
            import attachments
            att = attachments.get(conn, ident)
            return attachments.file_path(db_path, att) if att else None
        if kind == "scratch":
            import scratch
            row = _db.get_scratch(conn, ident)
            if row and row.get("media_path"):
                return os.path.join(scratch.media_dir(db_path), row["media_path"])
    finally:
        conn.close()
    return None


def resume_once(db_path: str) -> None:
    """Re-queue file transcripts a restart interrupted (first touch of a
    user's DB in this process)."""
    with _lock:
        if db_path in _resumed:
            return
        _resumed.add(db_path)
    if not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        try:
            rows = conn.execute(
                "SELECT id, source_ref FROM transcripts WHERE status = 'processing' "
                "AND source IN ('attachment', 'scratch')").fetchall()
        finally:
            conn.close()
    except sqlite3.OperationalError:
        return                                     # schema not migrated yet
    for tid, ref in rows:
        path = _path_for(db_path, ref)
        if path and os.path.exists(path):
            _queue(db_path, tid, path, None)
        else:
            conn = sqlite3.connect(db_path)
            try:
                _db.set_transcript_result(conn, tid, error="the file is gone")
            finally:
                conn.close()


def wait(db_path: str, transcript_id: int, timeout: float) -> Optional[dict]:
    """The row once it's no longer processing, or as it is at `timeout`."""
    deadline = time.monotonic() + timeout
    while True:
        conn = sqlite3.connect(db_path)
        try:
            row = _db.get_transcript(conn, transcript_id)
        finally:
            conn.close()
        if row is None or row["status"] != "processing" or time.monotonic() >= deadline:
            return row
        time.sleep(0.25)
