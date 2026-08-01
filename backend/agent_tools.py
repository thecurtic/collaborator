"""Standalone agent tools: calculator, Gitea reader, video transcription, location.

Each is a plain function returning a JSON-serializable dict; main.py wires them
into tool schemas + the executor. Kept out of main.py to stop it growing.
"""

import ast
import math
import operator
import os
import subprocess
import tempfile
import threading

from config import get_config

# --- Calculator -----------------------------------------------------------------
# AST-whitelisted arithmetic — no eval(), no names, no attribute access. Size
# guards keep pathological inputs (10**10**10, factorial(1e9)) from wedging the
# process.

_BINOPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
}


def _safe_pow(a, b):
    if abs(b) > 1000:
        raise ValueError("exponent too large (max 1000)")
    if isinstance(a, int) and isinstance(b, int) and abs(a) > 1 and abs(b) > 64 \
            and abs(a) ** min(abs(b), 64) > 10 ** 300:
        raise ValueError("result too large")
    return a ** b


def _safe_factorial(n):
    n = int(n)
    if n < 0 or n > 5000:
        raise ValueError("factorial argument must be 0..5000")
    return math.factorial(n)


_FUNCS = {name: getattr(math, name) for name in (
    "sqrt", "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
    "log", "log10", "log2", "exp", "floor", "ceil", "fabs",
    "degrees", "radians", "hypot", "gcd", "isqrt",
)}
_FUNCS.update({"abs": abs, "round": round, "min": min, "max": max, "sum": sum,
               "factorial": _safe_factorial, "pow": _safe_pow})
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau, "inf": math.inf}


def _calc_eval(node):
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("only numbers are allowed")
        return node.value
    if isinstance(node, ast.BinOp):
        if isinstance(node.op, ast.Pow):
            return _safe_pow(_calc_eval(node.left), _calc_eval(node.right))
        fn = _BINOPS.get(type(node.op))
        if fn is None:
            raise ValueError(f"operator {type(node.op).__name__} not allowed")
        return fn(_calc_eval(node.left), _calc_eval(node.right))
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _calc_eval(node.operand)
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS \
                or node.keywords:
            raise ValueError("only whitelisted math functions are allowed")
        return _FUNCS[node.func.id](*[_calc_eval(a) for a in node.args])
    if isinstance(node, ast.Name):
        if node.id in _CONSTS:
            return _CONSTS[node.id]
        raise ValueError(f"unknown name {node.id!r}")
    if isinstance(node, (ast.Tuple, ast.List)):
        return [_calc_eval(e) for e in node.elts]
    raise ValueError(f"syntax not allowed: {type(node).__name__}")


def calculate(expression: str) -> dict:
    """Evaluate a basic arithmetic expression safely. Returns {result} or {error}."""
    expression = (expression or "").strip()
    if not expression:
        return {"error": "empty expression"}
    if len(expression) > 500:
        return {"error": "expression too long (max 500 chars)"}
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as e:
        return {"error": f"syntax error: {e.msg}"}
    try:
        value = _calc_eval(tree.body)
    except ZeroDivisionError:
        return {"error": "division by zero"}
    except (ValueError, TypeError, OverflowError) as e:
        return {"error": str(e)[:200]}
    if isinstance(value, float) and not math.isfinite(value):
        value = str(value)
    return {"expression": expression, "result": value}


# --- Gitea (read-only repository access) ----------------------------------------
# Config: tools.git {api_url (e.g. http://host:3000/api/v1), token (read-only),
# max_chars, timeout}. Self-gating: the tool only registers when configured.
# GitHub's API shares these routes, so kind never needed so far.


def _git_cfg() -> dict:
    return (get_config().get("tools", {}) or {}).get("git") or {}


def git_configured() -> bool:
    cfg = _git_cfg()
    return bool(cfg.get("api_url") and cfg.get("token"))


def git_read(action: str, repo: str = None, path: str = None, ref: str = None) -> dict:
    """Read-only forge access: list_repos | list_files | read_file."""
    import requests
    cfg = _git_cfg()
    if not git_configured():
        return {"error": "git access is not configured (tools.git.api_url + token)"}
    base = cfg["api_url"].rstrip("/")
    headers = {"Authorization": f"token {cfg['token']}"}
    timeout = cfg.get("timeout", 15)
    params = {"ref": ref} if ref else None
    try:
        if action == "list_repos":
            r = requests.get(f"{base}/user/repos", params={"limit": 50},
                             headers=headers, timeout=timeout)
            r.raise_for_status()
            return {"repos": [{
                "name": x.get("full_name"),
                "description": (x.get("description") or "")[:120],
                "private": x.get("private"),
                "updated": x.get("updated_at"),
                "default_branch": x.get("default_branch"),
            } for x in r.json()]}
        if not repo:
            return {"error": f"{action} needs repo (owner/name)"}
        if action == "list_files":
            r = requests.get(f"{base}/repos/{repo}/contents/{(path or '').strip('/')}",
                             params=params, headers=headers, timeout=timeout)
            if r.status_code == 404:
                return {"error": f"not found: {repo} / {path or '(root)'}"}
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict):
                data = [data]
            return {"repo": repo, "path": path or "", "entries": [{
                "name": e.get("name"), "path": e.get("path"),
                "type": e.get("type"), "size": e.get("size"),
            } for e in data]}
        if action == "read_file":
            if not path:
                return {"error": "read_file needs path"}
            r = requests.get(f"{base}/repos/{repo}/contents/{path.strip('/')}",
                             params=params, headers=headers, timeout=timeout)
            if r.status_code == 404:
                return {"error": f"not found: {repo}/{path}"}
            r.raise_for_status()
            data = r.json()
            if data.get("type") != "file":
                return {"error": f"{path} is not a file — use list_files"}
            import base64
            try:
                text = base64.b64decode(data.get("content") or "").decode("utf-8")
            except (ValueError, UnicodeDecodeError):
                return {"error": f"{path} is not a UTF-8 text file"}
            max_chars = cfg.get("max_chars", 20000)
            return {"repo": repo, "path": path, "ref": ref,
                    "size": data.get("size"),
                    "truncated": len(text) > max_chars,
                    "content": text[:max_chars]}
        return {"error": f"unknown action {action!r} — use list_repos, "
                         "list_files, or read_file"}
    except requests.exceptions.HTTPError as e:
        # Gitea's 401/403 bodies say WHY (e.g. which token scopes are missing) —
        # surface that instead of a bare status code.
        body = ""
        resp = getattr(e, "response", None)
        if resp is not None and resp.text:
            body = f" — {resp.text[:200]}"
        hint = ""
        if resp is not None and resp.status_code == 403:
            hint = (" (Gitea 403 usually means the token lacks scopes; it needs "
                    "read:user AND read:repository — scopes can only be set at "
                    "token creation, so regenerate it)")
        return {"error": f"git api request failed: {e}{body}{hint}"}
    except requests.exceptions.RequestException as e:
        return {"error": f"git api request failed: {e}"}


def git_issue(action: str, repo: str = None, title: str = None,
              body: str = None, labels=None, issue_number=None) -> dict:
    """Write to Gitea issues: create | comment. The ONLY write surface of the
    git tools — git_read stays read-only forever. Requires a token with
    write:issue scope (covers comments too); code remains untouchable (no
    write:repository). Guidance requires user confirmation before calling."""
    import requests
    cfg = _git_cfg()
    if not git_configured():
        return {"error": "git access is not configured (tools.git.api_url + token)"}
    base = cfg["api_url"].rstrip("/")
    headers = {"Authorization": f"token {cfg['token']}"}
    timeout = cfg.get("timeout", 15)
    if not repo:
        return {"error": f"{action} needs repo (owner/name)"}
    try:
        if action == "create":
            if not (title or "").strip():
                return {"error": "create needs a title"}
            payload = {"title": title.strip(), "body": (body or "").strip()}
            if labels:
                # Gitea wants label IDs; resolve names best-effort, skip unknowns.
                try:
                    r = requests.get(f"{base}/repos/{repo}/labels",
                                     headers=headers, timeout=timeout)
                    r.raise_for_status()
                    by_name = {l["name"].lower(): l["id"] for l in r.json()}
                    ids = [by_name[str(n).lower()] for n in labels
                           if str(n).lower() in by_name]
                    if ids:
                        payload["labels"] = ids
                except requests.exceptions.RequestException:
                    pass
            r = requests.post(f"{base}/repos/{repo}/issues",
                              json=payload, headers=headers, timeout=timeout)
            r.raise_for_status()
            data = r.json()
            return {"created": True, "repo": repo,
                    "number": data.get("number"),
                    "title": data.get("title"),
                    "url": data.get("html_url"),
                    "note": "Share the issue URL with the user."}
        if action == "comment":
            try:
                index = int(issue_number)
            except (TypeError, ValueError):
                return {"error": "comment needs issue_number (the issue's number)"}
            if not (body or "").strip():
                return {"error": "comment needs body"}
            r = requests.post(f"{base}/repos/{repo}/issues/{index}/comments",
                              json={"body": body.strip()},
                              headers=headers, timeout=timeout)
            if r.status_code == 404:
                return {"error": f"no issue #{index} in {repo}"}
            r.raise_for_status()
            return {"commented": True, "repo": repo, "issue_number": index,
                    "url": r.json().get("html_url")}
        return {"error": f"unknown action {action!r} — use create or comment"}
    except requests.exceptions.HTTPError as e:
        resp = getattr(e, "response", None)
        detail = f" — {resp.text[:200]}" if resp is not None and resp.text else ""
        hint = ""
        if resp is not None and resp.status_code == 403:
            hint = (" (403: the token likely lacks the write:issue scope — "
                    "regenerate it with write:issue added, or the collaborator "
                    "account lacks issue permission on this repo)")
        return {"error": f"git issue request failed: {e}{detail}{hint}"}
    except requests.exceptions.RequestException as e:
        return {"error": f"git issue request failed: {e}"}


# --- Video transcription (yt-dlp audio -> STT, never captions) -------------------
# Config: tools.transcribe_video {sync_max_minutes, max_minutes, proxy,
# return_chars}. Videos under sync_max_minutes transcribe within the turn;
# longer ones run in a background thread and are surfaced via the transcripts
# table (GET /api/transcripts) — the model re-checks by calling again.


def _video_cfg() -> dict:
    return (get_config().get("tools", {}) or {}).get("transcribe_video") or {}


def _probe_video(url: str) -> dict:
    """Metadata only (no download): {title, duration_s} or {error}."""
    import yt_dlp
    opts = {"quiet": True, "no_warnings": True, "noplaylist": True}
    if _video_cfg().get("proxy"):
        opts["proxy"] = _video_cfg()["proxy"]
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        return {"error": f"could not read video metadata: {str(e)[:200]}"}
    return {"title": info.get("title") or url,
            "duration_s": int(info.get("duration") or 0)}


def _download_and_transcribe(url: str) -> str:
    """Blocking: fetch the audio track, normalize with ffmpeg, run STT.

    Uses voice.transcribe_batch, so it follows the configured STT backend
    (speaches on the inference machine, or local faster-whisper).
    """
    import yt_dlp
    import voice
    cfg = _video_cfg()
    with tempfile.TemporaryDirectory() as tmp:
        opts = {"quiet": True, "no_warnings": True, "noplaylist": True,
                "format": "bestaudio/best",
                "outtmpl": os.path.join(tmp, "audio.%(ext)s")}
        if cfg.get("proxy"):
            opts["proxy"] = cfg["proxy"]
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(url, download=True)
        files = [os.path.join(tmp, f) for f in os.listdir(tmp)]
        if not files:
            raise RuntimeError("download produced no audio file")
        wav = os.path.join(tmp, "norm.wav")
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", files[0], "-ar", "16000", "-ac", "1", wav],
            capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode(errors='replace')[:200]}")
        return voice.transcribe_batch(wav)


def transcribe_video(db_path: str, url: str) -> dict:
    """Transcribe a video/audio URL from its actual audio (never captions).

    Short videos (<= sync_max_minutes) return the transcript in-turn. Longer
    ones start a background job: this returns status=processing, and a later
    call with the same URL (or GET /api/transcripts) returns the result.
    """
    import sqlite3
    import db as _db
    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        return {"error": f"transcribe_video needs an http(s) URL, got {url!r}"}
    cfg = _video_cfg()
    return_chars = cfg.get("return_chars", 15000)

    previous_error = None
    conn = sqlite3.connect(db_path)
    try:
        existing = _db.get_transcript_by_url(conn, url)
        if existing and existing["status"] == "done":
            text = existing["text"] or ""
            return {"url": url, "title": existing["title"],
                    "duration_s": existing["duration_s"], "status": "done",
                    "transcript": text[:return_chars],
                    "truncated": len(text) > return_chars}
        if existing and existing["status"] == "processing":
            return {"url": url, "title": existing["title"], "status": "processing",
                    "note": "Still transcribing in the background — tell the user "
                            "and check again next turn."}
        if existing and existing["status"] == "error":
            # Surface the failure honestly AND retry — never mask an error as
            # eternal "processing". The model should relay the error to the user.
            previous_error = existing.get("error")
    finally:
        conn.close()

    meta = _probe_video(url)
    if meta.get("error"):
        return meta
    minutes = meta["duration_s"] / 60
    hard_max = cfg.get("max_minutes", 240)
    if minutes > hard_max:
        return {"error": f"video is {minutes:.0f} min — over the "
                         f"{hard_max} min cap (tools.transcribe_video.max_minutes)"}

    if minutes <= cfg.get("sync_max_minutes", 10):
        conn = sqlite3.connect(db_path)
        try:
            row = _db.create_transcript(conn, url, meta["title"], meta["duration_s"])
            try:
                text = _download_and_transcribe(url)
            except Exception as e:
                print(f"Warning: transcribe_video failed for {url}: {e}")
                _db.set_transcript_result(conn, row["id"], error=str(e)[:300])
                return {"error": f"transcription failed: {str(e)[:200]}"}
            _db.set_transcript_result(conn, row["id"], text=text)
        finally:
            conn.close()
        out = {"url": url, "title": meta["title"],
               "duration_s": meta["duration_s"], "status": "done",
               "transcript": text[:return_chars],
               "truncated": len(text) > return_chars}
        if previous_error:
            out["note"] = f"an earlier attempt failed ({previous_error}); this retry succeeded"
        return out

    # Long video: background job, surfaced via the transcripts table.
    conn = sqlite3.connect(db_path)
    try:
        row = _db.create_transcript(conn, url, meta["title"], meta["duration_s"])
    finally:
        conn.close()

    def _worker():
        import sqlite3 as _sq
        print(f"transcribe_video: background job #{row['id']} started "
              f"({minutes:.0f} min): {url}")
        wconn = _sq.connect(db_path)
        try:
            try:
                text = _download_and_transcribe(url)
                _db.set_transcript_result(wconn, row["id"], text=text)
                print(f"transcribe_video: job #{row['id']} done "
                      f"({len(text)} chars)")
            except Exception as e:
                print(f"Warning: transcribe_video job #{row['id']} failed: {e}")
                _db.set_transcript_result(wconn, row["id"], error=str(e)[:300])
        finally:
            wconn.close()

    threading.Thread(target=_worker, daemon=True,
                     name=f"transcribe-{row['id']}").start()
    out = {"url": url, "title": meta["title"], "duration_s": meta["duration_s"],
           "status": "processing",
           "note": f"~{minutes:.0f} min video — transcribing in the background. "
                   "Tell the user it's underway; call this tool again with the "
                   "same URL on a later turn to fetch the finished transcript."}
    if previous_error:
        out["note"] += (f" NOTE: a previous attempt FAILED with: {previous_error} "
                        "— tell the user; if this retry hits the same problem "
                        "you'll see the error on the next check.")
    return out


# --- Location -------------------------------------------------------------------


def describe_location(loc: dict) -> str:
    """Context line for a turn's location: raw coordinates, nothing more.

    Deliberately minimal (user decision 2026-07-28): no place naming, no
    geocoding — coordinates become useful when OSM browsing arrives. Nothing
    ever leaves this machine."""
    try:
        lat, lon = float(loc["lat"]), float(loc["lon"])
    except (KeyError, TypeError, ValueError):
        return ""
    accuracy = ""
    try:
        if loc.get("accuracy"):
            accuracy = f" (±{int(float(loc['accuracy']))}m)"
    except (TypeError, ValueError):
        pass
    return (f"User location right now: {lat:.5f}, {lon:.5f}{accuracy}. "
            "Use only when relevant.")
