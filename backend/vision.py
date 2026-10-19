"""The one vision path: images go to the chat model.

UX doc (Attachments): "The local model already handles vision natively, OCR
included, so none of this needs a second model standing beside it or a
separate OCR engine wired in." Everything that needs eyes — an image attached
to a chat, OCR of a scanned PDF page, screenshot_page — asks `model()` and
calls `look()`.

Whether the chat model can see is `inference.vision`:
- "auto" (default): ask LM Studio (/api/v0/models reports type "vlm" for a
  model loaded with its vision projector, "llm" for text only); unknown when
  the server doesn't say, which counts as no.
- true / false: the operator says so (other OpenAI-compatible servers).
"""

import base64
import io
import time
from typing import Dict, List, Optional

import requests

from config import get_config

_vlm_cache: Dict[str, tuple] = {}     # model_id -> (monotonic_ts, bool|None)
_CACHE_S = 300


def _inference() -> dict:
    return get_config().get("inference", {}) or {}


def lmstudio_type(model_id: str) -> Optional[str]:
    """LM Studio's "type" for this model ("vlm" | "llm" | "embeddings"), or
    None when the endpoint doesn't expose /api/v0/models."""
    from inference import get_models_detail, model_ids_match
    for m in get_models_detail():
        if model_ids_match(model_id, m.get("id")):
            return m.get("type")
    return None


def chat_model_sees(model_id: Optional[str] = None) -> bool:
    """Can the chat model (or `model_id`) read images?"""
    model_id = model_id or _inference().get("model_id")
    setting = _inference().get("vision", "auto")
    if setting is True or str(setting).lower() == "true":
        return True
    if setting is False or str(setting).lower() == "false":
        return False
    now = time.monotonic()
    hit = _vlm_cache.get(model_id)
    if hit and now - hit[0] < _CACHE_S:
        return bool(hit[1])
    seen = lmstudio_type(model_id)
    sees = None if seen is None else seen == "vlm"
    _vlm_cache[model_id] = (now, sees)
    return bool(sees)


def model() -> Optional[str]:
    """The model that reads images: the chat model when it can, else None
    (no vision)."""
    chat = _inference().get("model_id")
    return chat if chat and chat_model_sees(chat) else None


def status() -> dict:
    """For Settings: who reads images, and why."""
    chat = _inference().get("model_id")
    setting = _inference().get("vision", "auto")
    sees = chat_model_sees(chat)
    out = {"chat_model": chat, "chat_model_sees": sees,
           "setting": setting if isinstance(setting, bool) else str(setting),
           "model": model()}
    if str(setting).lower() == "auto":
        out["lmstudio_type"] = lmstudio_type(chat) if chat else None
    return out


def prepare_image(data: bytes, mime: Optional[str], max_side: int = None):
    """(mime, base64) ready for an image_url part: downscaled so the longest
    side is at most `max_side` px (tokens scale with pixels), re-encoded as
    JPEG/PNG. Falls back to the raw bytes when Pillow can't read it."""
    max_side = max_side or int(((get_config().get("attachments") or {})
                                .get("image_max_side", 1600)))
    try:
        from PIL import Image, ImageOps
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        if max(img.size) > max_side:
            img.thumbnail((max_side, max_side))
        out = io.BytesIO()
        if img.mode in ("RGBA", "LA", "P"):
            img.save(out, format="PNG")
            mime = "image/png"
        else:
            img.convert("RGB").save(out, format="JPEG", quality=88)
            mime = "image/jpeg"
        data = out.getvalue()
    except Exception:
        mime = mime or "image/png"
    return mime, base64.b64encode(data).decode("ascii")


def image_part(mime: str, b64: str) -> dict:
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}


def look(images: List[tuple], prompt: str, max_tokens: int = 1024,
         timeout: float = None, temperature: float = 0.2) -> str:
    """Ask the vision model about one or more images ((mime, base64) pairs).
    Raises RuntimeError with a readable reason on any failure."""
    from inference import _get_endpoint_url
    who = model()
    if not who:
        raise RuntimeError("no model here can read images: the chat model is "
                           "text-only (see Settings → Model)")
    scfg = ((get_config().get("tools") or {}).get("screenshot") or {})
    payload = {
        "model": who,
        "messages": [{"role": "user", "content": [
            *[image_part(m, b) for m, b in images],
            {"type": "text", "text": prompt},
        ]}],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    try:
        # Generous timeout: LM Studio may load the model on first use.
        r = requests.post(f"{_get_endpoint_url()}/chat/completions", json=payload,
                          timeout=timeout or scfg.get("timeout", 180))
        r.raise_for_status()
        msg = r.json()["choices"][0]["message"]
        text = (msg.get("content") or "").strip()
    except requests.exceptions.RequestException as e:
        body = getattr(getattr(e, "response", None), "text", "") or ""
        raise RuntimeError(f"vision request to {who} failed: {e}"
                           + (f" — {body[:200]}" if body else ""))
    except (KeyError, IndexError, ValueError) as e:
        raise RuntimeError(f"vision model {who} returned an unreadable reply: {e}")
    # Reasoning models may wrap the answer; keep only what follows </think>.
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1].strip()
    if not text:
        raise RuntimeError(f"vision model {who} returned no text")
    return text


def self_test() -> dict:
    """Draw a card with a known word on it and ask the vision model to read
    it back: the quickest proof that images actually reach the model."""
    from PIL import Image, ImageDraw, ImageFont
    word = "PELICAN 47"
    img = Image.new("RGB", (480, 160), "white")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default(size=56)
    except TypeError:                          # Pillow < 10.1
        font = ImageFont.load_default()
    draw.text((30, 45), word, fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    out = status()
    try:
        answer = look([("image/png", base64.b64encode(buf.getvalue()).decode())],
                      "What text is written in this image? Reply with the text only.",
                      max_tokens=256, timeout=180)
    except RuntimeError as e:
        out.update(ok=False, error=str(e))
        return out
    norm = "".join(ch for ch in answer.upper() if ch.isalnum())
    out.update(ok="PELICAN47" in norm, expected=word, answer=answer[:300])
    return out
