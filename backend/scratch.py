"""Scratch (notes-to-self): capture pipe + opt-in one-shot agent actions.

Design contract (spec agreed 2026-08-05):
- The pipe is INERT by default; the LLM touches an item only on an explicit
  per-item action request (hold-send). Intent is the user's gesture, never
  inferred from content.
- Storage is a separate table (db.py) so the conversation agent's queries
  physically cannot reach scratch content. NOTHING here logs item content —
  a leak through read_logs would break the agent-blind guarantee.
- Media is content-addressed on disk (sha256 filename) for dedupe now and
  sync integrations (Nextcloud) later.
- Actions never chat. The grammar is: propose (a graph draft, approved on the
  card via the normal drafts machinery), transcript (video jobs), suggest_chat
  (question-shaped input -> offer to open a real conversation), flag (secret /
  opaque / unactionable -> left as a note, with the reason), unsupported.
"""

import hashlib
import json
import os
import re
from typing import Optional, Tuple

from config import get_config

MEDIA_KINDS = {"image", "audio", "video", "file"}

_URL_RE = re.compile(r"^https?://\S+$")
_YOUTUBE_RE = re.compile(
    r"(youtube\.com/(watch|shorts|live)|youtu\.be/)", re.IGNORECASE)


def _cfg() -> dict:
    return get_config().get("scratch", {}) or {}


def detect_kind(content: Optional[str], media_mime: Optional[str]) -> str:
    if media_mime:
        base = media_mime.split("/")[0]
        return base if base in ("image", "audio", "video") else "file"
    text = (content or "").strip()
    if _URL_RE.match(text):
        return "url"
    return "text"


# --- Secret guard ----------------------------------------------------------------
# Deliberately THIN: only unambiguous formats are hard-refused before any model
# sees the text (the catastrophic class costs nothing to catch). Everything
# fuzzier is the model's judgment via the 'flag' action — per the owner's call.

_SECRET_PATTERNS = [
    ("bitcoin address", re.compile(r"\b(bc1[a-z0-9]{20,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b")),
    ("ethereum address/key", re.compile(r"\b0x[a-fA-F0-9]{40}(\b|[a-fA-F0-9]{24}\b)")),
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("PGP block", re.compile(r"-----BEGIN PGP (PRIVATE|SECRET)")),
    ("ssh private key", re.compile(r"-----BEGIN OPENSSH PRIVATE KEY-----")),
    ("API key", re.compile(r"\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[bap]-[A-Za-z0-9-]{20,})")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("WIF key", re.compile(r"\b[5KL][1-9A-HJ-NP-Za-km-z]{50,52}\b")),
]


def detect_secret(text: Optional[str]) -> Optional[str]:
    """Label of the first unambiguous secret format found, else None."""
    if not text:
        return None
    for label, pattern in _SECRET_PATTERNS:
        if pattern.search(text):
            return label
    return None


# --- Media store (content-addressed) ---------------------------------------------

def media_dir(db_path: str) -> str:
    return os.path.join(os.path.dirname(db_path), "scratch-media")


_EXT_BY_MIME = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
                "image/gif": ".gif", "audio/webm": ".webm", "audio/ogg": ".ogg",
                "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/mpeg": ".mp3",
                "video/mp4": ".mp4", "video/webm": ".webm",
                "text/calendar": ".ics"}


def save_media(db_path: str, data: bytes, mime: Optional[str],
               filename: Optional[str] = None) -> Tuple[str, str, int]:
    """Store bytes content-addressed. Returns (relative_path, sha256, size).

    Filename = <sha256><ext>: identical content dedupes to one file, and the
    hash column makes future sync a set-difference instead of a crawl.
    """
    max_mb = _cfg().get("max_media_mb", 50)
    if len(data) > max_mb * 1024 * 1024:
        raise ValueError(f"media exceeds the {max_mb}MB limit")
    digest = hashlib.sha256(data).hexdigest()
    ext = _EXT_BY_MIME.get((mime or "").split(";")[0].strip().lower())
    if not ext and filename and "." in filename:
        candidate = "." + filename.rsplit(".", 1)[1].lower()
        ext = candidate if re.match(r"^\.[a-z0-9]{1,8}$", candidate) else ""
    name = f"{digest}{ext or ''}"
    directory = media_dir(db_path)
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(data)
    return name, digest, len(data)


def delete_media_if_unshared(db_path: str, row: dict) -> None:
    if row.get("media_path") and not row.get("media_shared"):
        try:
            os.remove(os.path.join(media_dir(db_path), row["media_path"]))
        except OSError:
            pass


# --- One-shot agent action (hold-send) -------------------------------------------

# Only tools that serve capture->graph: search/read for dedupe and people
# linking, propose for output. No web, no git, no calculator — a scratch
# action is not a conversation.
ACTION_TOOLS = {"search_notes", "get_note", "get_notes", "propose_note",
                "propose_edit"}

DEFAULT_ACTION_PROMPT = (
    "You process ONE captured item from the user's scratch stream — a quick "
    "note fired at you for action. You are not in a conversation; produce no "
    "prose reply. Decide and act:\n"
    "1. Entity-shaped (an event, person, goal, decision, idea worth keeping): "
    "search the vault first (dedupe; link existing people/projects), then "
    "propose ONE note (or propose_edit an existing one) with the right "
    "category tag and typed fields. Resolve relative dates against today.\n"
    "2. Question-shaped (the user seems to want an answer or a discussion): "
    "do NOT answer. Emit exactly: "
    '{\"action\": \"suggest_chat\", \"note\": \"<why this wants a chat>\"}\n'
    "3. Secret-shaped, opaque, or you genuinely don't know what to do with "
    "it: do not summarize or store it. Emit exactly: "
    '{\"action\": \"flag\", \"note\": \"<one line: what this looks like>\"}\n'
    "After proposing a draft, emit exactly: "
    '{\"action\": \"proposed\", \"note\": \"<one line: what you extracted>\"}\n'
    "Your final message must be ONLY one of those JSON objects."
)


def _parse_action_reply(text: str) -> Optional[dict]:
    text = (text or "").strip()
    match = re.search(r"\{[^{}]*\"action\"[^{}]*\}", text, re.S)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
    except ValueError:
        return None
    if isinstance(obj, dict) and obj.get("action") in ("proposed",
                                                       "suggest_chat", "flag"):
        return obj
    return None


def run_text_action(db_path: str, text: str, build_tools, generate) -> dict:
    """Run the restricted one-shot agent over hold-sent text.

    Returns an action_result dict: {kind, note?, draft_id?}. build_tools and
    generate are injected (main._build_tools / inference.generate_with_tools)
    to avoid an import cycle. Content-free on the logging side by contract.
    """
    from config import resolve_path
    cfg = _cfg()
    prompt = DEFAULT_ACTION_PROMPT
    prompt_file = cfg.get("action_prompt_file")
    if prompt_file:
        try:
            with open(resolve_path(prompt_file), "r", encoding="utf-8") as f:
                loaded = f.read().strip()
                if loaded:
                    prompt = loaded
        except IOError:
            pass

    schemas, execute, state = build_tools(db_path)
    schemas = [s for s in schemas if s["function"]["name"] in ACTION_TOOLS]

    final_text = ""
    for ev in generate(
            f"{prompt}\n\nThe captured item:\n{text}", [], None,
            tool_schemas=schemas, execute_tool=execute,
            max_rounds=cfg.get("max_rounds", 4),
            emit_status=False, emit_results=False):
        if ev.get("type") == "token":
            final_text += ev["content"]
        elif ev.get("type") == "error":
            return {"kind": "error", "note": ev.get("detail", "action failed")}

    drafts = state.get("proposed_drafts") or []
    reply = _parse_action_reply(final_text)
    if drafts:
        titles = [d["title"] for d in drafts]
        return {"kind": "proposed",
                "note": (reply or {}).get("note") or f"Proposed: {', '.join(titles)}",
                "draft_id": drafts[0]["id"],
                # ALL drafts from this action — the caller re-tags every one of
                # them (a multi-proposal action must not leak siblings into the
                # drafts inbox), and the card renders the full set.
                "draft_ids": [d["id"] for d in drafts],
                "draft_count": len(drafts),
                "draft_kind": drafts[0].get("kind", "new"),
                "draft_title": drafts[0]["title"],
                "draft_titles": titles}
    if reply and reply["action"] == "suggest_chat":
        return {"kind": "chat_suggestion",
                "note": reply.get("note") or "This looks like a conversation starter."}
    if reply and reply["action"] == "flag":
        return {"kind": "flagged",
                "note": reply.get("note") or "Left as a note."}
    # No draft, no recognizable verdict: treat as flagged, never as chat.
    return {"kind": "flagged",
            "note": "The agent couldn't extract anything actionable — left as a note."}
