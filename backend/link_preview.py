"""Link previews for Scratch: a link shows its page title and favicon, a
YouTube link its title, channel and thumbnail (UX doc, Scratch: "each item
renders as what it is").

One row per URL in `link_previews`, fetched once in the background when the
link is captured (or first listed), never by a model. The fetch takes the
same exit as fetch_url and keeps its guards:
- tools.fetch_url.webtool_url set: the page is fetched through the webtool
  (its VPN), and icons/thumbnails are SKIPPED rather than fetched direct;
- otherwise direct, or through tools.fetch_url.proxy when set;
- private/internal hosts refused (unless tools.fetch_url.allow_private),
  every redirect hop re-checked.
`scratch.link_previews: false` turns it off; links then show as URLs.

Icons and thumbnails are stored content-addressed beside Scratch's media
(scratch-media/previews/) and served by the app, so a phone rendering the
stream never contacts the linked site itself. SVG is never stored (it could
carry script); the page's own icon is tried, then /favicon.ico.
"""

import hashlib
import json
import os
import queue
import sqlite3
import threading
from html.parser import HTMLParser
from typing import Dict, Optional, Tuple
from urllib.parse import urljoin, urlparse

import requests

from config import get_config

_HTML_MAX = 512 * 1024
_IMAGE_MAX = 512 * 1024
_IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
                "image/gif": ".gif", "image/x-icon": ".ico",
                "image/vnd.microsoft.icon": ".ico"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS link_previews (
    url TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT,
    site TEXT,
    icon_path TEXT,
    icon_mime TEXT,
    image_path TEXT,
    image_mime TEXT,
    error TEXT,
    fetched_at TEXT
)
"""


def enabled() -> bool:
    return bool(((get_config().get("scratch") or {}).get("link_previews", True)))


def ensure_schema(conn) -> None:
    conn.execute(SCHEMA)


def preview_dir(db_path: str) -> str:
    return os.path.join(os.path.dirname(db_path), "scratch-media", "previews")


def is_youtube(url: str) -> bool:
    import scratch
    return bool(scratch._YOUTUBE_RE.search(url or ""))


# --- Fetching ------------------------------------------------------------------

def _fetch_cfg() -> Dict:
    return ((get_config().get("tools") or {}).get("fetch_url") or {})


def _guard(url: str) -> Optional[str]:
    from inference import _host_is_private
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return "not an http(s) URL"
    if not _fetch_cfg().get("allow_private", False) and _host_is_private(parsed.hostname or ""):
        return "private/internal address"
    return None


def _get(url: str, max_bytes: int) -> Tuple[bytes, str, str]:
    """(body, content-type, final url) through fetch_url's safe redirects."""
    from inference import _get_following_safe_redirects
    fcfg = dict(_fetch_cfg())
    fcfg["timeout"] = min(int(fcfg.get("timeout", 20)), 15)
    response = _get_following_safe_redirects(url, fcfg, fcfg.get("proxy"))
    if isinstance(response, dict):
        raise RuntimeError(response["error"])
    try:
        response.raise_for_status()
        pieces, size = [], 0
        for piece in response.iter_content(65536):
            pieces.append(piece)
            size += len(piece)
            if size > max_bytes:
                break
        ctype = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
        return b"".join(pieces)[:max_bytes], ctype, response.url or url
    finally:
        response.close()


def _get_html(url: str) -> Tuple[str, str]:
    """(html, final url), through the webtool when one is configured."""
    fcfg = _fetch_cfg()
    if fcfg.get("webtool_url"):
        r = requests.post(f"{fcfg['webtool_url'].rstrip('/')}/fetch",
                          json={"url": url, "text_only": False, "wait_ms": 0},
                          timeout=fcfg.get("webtool_timeout", 60))
        r.raise_for_status()
        data = r.json()
        return (data.get("content") or "")[:_HTML_MAX], data.get("url") or url
    body, ctype, final = _get(url, _HTML_MAX)
    if ctype and ctype not in ("text/html", "application/xhtml+xml"):
        raise RuntimeError(f"not a web page ({ctype})")
    return body.decode("utf-8", errors="replace"), final


def _images_allowed() -> bool:
    # Fail closed: with a webtool configured, nothing goes out direct.
    return not _fetch_cfg().get("webtool_url")


def _save_image(db_path: str, url: str) -> Tuple[Optional[str], Optional[str]]:
    """Fetch an image and store it content-addressed. (path, mime) or Nones."""
    if not url or _guard(url):
        return None, None
    try:
        data, ctype, _ = _get(url, _IMAGE_MAX)
    except Exception:
        return None, None
    ext = _IMAGE_TYPES.get(ctype)
    if not ext or not data:                  # SVG and anything unknown: skip
        return None, None
    name = hashlib.sha256(data).hexdigest() + ext
    directory = preview_dir(db_path)
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(data)
    return name, ctype


class _Meta(HTMLParser):
    """<title>, og:/twitter: title and site name, and the page's icon links."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title, self.meta, self.icons = "", {}, []
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key in ("og:title", "og:site_name", "twitter:title", "application-name"):
                self.meta.setdefault(key, a.get("content", "").strip())
        elif tag == "link" and a.get("href"):
            rel = a.get("rel", "").lower().split()
            if "icon" in rel or "apple-touch-icon" in rel:
                self.icons.append(("apple-touch-icon" in rel, a.get("type", ""), a["href"]))

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and len(self.title) < 500:
            self.title += data


def _clean(text: Optional[str], limit: int = 300) -> Optional[str]:
    text = " ".join((text or "").split())
    return text[:limit] or None


def fetch_page(db_path: str, url: str) -> Dict:
    html, final = _get_html(url)
    m = _Meta()
    try:
        m.feed(html)
    except Exception:
        pass
    title = _clean(m.meta.get("og:title") or m.meta.get("twitter:title") or m.title)
    site = _clean(m.meta.get("og:site_name") or m.meta.get("application-name"), 80)
    out = {"title": title, "site": site}
    if _images_allowed():
        # Prefer a plain icon over the (larger) touch icon; never SVG.
        icons = sorted((i for i in m.icons if "svg" not in i[1] and not i[2].lower().endswith(".svg")),
                       key=lambda i: i[0])
        for _, _, href in icons[:2] + [(False, "", "/favicon.ico")]:
            path, mime = _save_image(db_path, urljoin(final, href))
            if path:
                out.update(icon_path=path, icon_mime=mime)
                break
    return out


def fetch_youtube(db_path: str, url: str) -> Dict:
    """oEmbed: title, channel, thumbnail. Through the webtool when one is set
    (title and channel only then)."""
    oembed = "https://www.youtube.com/oembed?format=json&url=" + requests.utils.quote(url, safe="")
    fcfg = _fetch_cfg()
    if fcfg.get("webtool_url"):
        html, _ = _get_html(oembed)
        try:
            data = json.loads(html)
        except ValueError:
            # The webtool may wrap JSON in a page; fall back to the page title.
            return fetch_page(db_path, url)
    else:
        body, _, _ = _get(oembed, 64 * 1024)
        data = json.loads(body.decode("utf-8", errors="replace"))
    out = {"title": _clean(data.get("title")),
           "site": _clean(data.get("author_name"), 120)}
    if _images_allowed():
        path, mime = _save_image(db_path, data.get("thumbnail_url") or "")
        if path:
            out.update(image_path=path, image_mime=mime)
    return out


def refresh(db_path: str, url: str) -> None:
    """Fetch and store one URL's preview (the worker's job)."""
    err = _guard(url)
    result: Dict = {}
    if not err:
        try:
            result = fetch_youtube(db_path, url) if is_youtube(url) else fetch_page(db_path, url)
        except Exception as e:
            err = f"{e.__class__.__name__}: {str(e)[:160]}"
    conn = sqlite3.connect(db_path)
    try:
        ensure_schema(conn)
        conn.execute(
            "UPDATE link_previews SET status = ?, title = ?, site = ?, icon_path = ?, "
            "icon_mime = ?, image_path = ?, image_mime = ?, error = ?, "
            "fetched_at = datetime('now') WHERE url = ?",
            ("failed" if err else "done", result.get("title"), result.get("site"),
             result.get("icon_path"), result.get("icon_mime"), result.get("image_path"),
             result.get("image_mime"), err, url))
        conn.commit()
    finally:
        conn.close()


# --- The queue -------------------------------------------------------------------

_jobs: "queue.Queue[Tuple[str, str]]" = queue.Queue()
_queued: set = set()
_lock = threading.Lock()
_worker: Optional[threading.Thread] = None


def _run_worker():
    while True:
        db_path, url = _jobs.get()
        try:
            refresh(db_path, url)
        except Exception as e:
            print(f"Warning: link preview worker: {e.__class__.__name__}")
        finally:
            with _lock:
                _queued.discard((db_path, url))


def ensure(db_path: str, url: str) -> None:
    """Make sure this URL has (or is getting) a preview. Cheap when it has."""
    if not enabled() or not url:
        return
    conn = sqlite3.connect(db_path)
    try:
        ensure_schema(conn)
        cur = conn.execute("INSERT OR IGNORE INTO link_previews (url) VALUES (?)", (url,))
        conn.commit()
        fresh = cur.rowcount > 0
        if not fresh:
            status = conn.execute("SELECT status FROM link_previews WHERE url = ?",
                                  (url,)).fetchone()[0]
            if status != "pending":
                return
    finally:
        conn.close()
    global _worker
    with _lock:
        if (db_path, url) in _queued:
            return
        _queued.add((db_path, url))
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run_worker, daemon=True,
                                       name="link-previews")
            _worker.start()
    _jobs.put((db_path, url))


def wait_idle(timeout: float = 10.0) -> None:
    """Tests: block until the queue has drained."""
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        with _lock:
            if not _queued:
                return
        time.sleep(0.05)
