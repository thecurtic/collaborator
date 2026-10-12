"""Canonical identity for video URLs, so one video is one transcript.

The same YouTube video arrives as youtu.be/ID, watch?v=ID&t=42s, &si=…,
m.youtube.com, /shorts/ID, /live/ID or /embed/ID. Keying the transcripts cache
on the raw string made each form a separate row (and a fresh download). Every
lookup and every yt-dlp call goes through canonical_video() instead.
"""

import re
from typing import Tuple
from urllib.parse import parse_qs, urlsplit, urlunsplit

_YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com",
             "music.youtube.com", "youtube-nocookie.com",
             "www.youtube-nocookie.com"}


def _youtube_id(parts) -> str:
    host = (parts.hostname or "").lower()
    path = parts.path or ""
    candidate = ""
    if host in ("youtu.be", "www.youtu.be"):
        candidate = path.strip("/").split("/")[0]
    elif host in _YT_HOSTS:
        if path == "/watch":
            candidate = (parse_qs(parts.query).get("v") or [""])[0]
        else:
            m = re.match(r"^/(?:shorts|live|embed|v)/([^/?#]+)", path)
            candidate = m.group(1) if m else ""
    return candidate if _YT_ID.match(candidate) else ""


def canonical_video(url: str) -> Tuple[str, str]:
    """(key, canonical_url) for a video URL.

    YouTube: key "youtube:<id>", URL https://www.youtube.com/watch?v=<id>
    (timestamps, share ids and playlists dropped). Anything else: the URL with
    a lowercased host and no fragment, which is also its key.
    """
    raw = (url or "").strip()
    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw, raw
    vid = _youtube_id(parts)
    if vid:
        return f"youtube:{vid}", f"https://www.youtube.com/watch?v={vid}"
    if not parts.scheme or not parts.netloc:
        return raw, raw
    clean = urlunsplit((parts.scheme.lower(), parts.netloc.lower(),
                        parts.path, parts.query, ""))
    return clean, clean
