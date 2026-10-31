"""Decision-model client: typed questions answered with a probability per
option, in one pass with no generated text.

Speaks the generic decisions protocol (POST {endpoint}/decisions): `input`
is a string, or OpenAI-style messages whose content carries input_text /
input_image parts; `questions` is a list of typed questions:

    {"name", "type": "predicate", "instructions"}                  yes/no
    {"name", "type": "choice", "instructions",
     "choices": [{"value", "description"}]}                        one of
    {"name", "type": "score", "instructions", "levels": [{"label"}]}

Configured under `decision` (config.yaml); unset `model` = no decision model,
and every caller falls back to the chat model. Nothing here assumes a
particular model or server.
"""

from typing import Dict, List, Optional

import requests

from config import get_config


class DecisionError(RuntimeError):
    """The decision model couldn't answer (unreachable, refused, malformed)."""


def _cfg() -> dict:
    return get_config().get("decision") or {}


def model() -> Optional[str]:
    """The configured decision model, or None (callers use the chat model)."""
    return (_cfg().get("model") or "").strip() or None


def endpoint() -> str:
    from inference import _get_endpoint_url
    return ((_cfg().get("endpoint_url") or "").strip() or _get_endpoint_url()).rstrip("/")


def threshold(task: str) -> float:
    """The confidence a `task` answer ("classify", "match") must reach."""
    return float(_cfg().get(f"{task}_threshold", 0.8))


def image_max_side() -> int:
    """Images are shrunk to this longest side first: a decision server
    refuses an input longer than its batch."""
    return int(_cfg().get("image_max_side", 896))


def predicate(name: str, instructions: str) -> dict:
    return {"name": name, "type": "predicate", "instructions": instructions}


def choice(name: str, instructions: str, options: Dict[str, str]) -> dict:
    """`options` maps each value to its description (order is kept)."""
    return {"name": name, "type": "choice", "instructions": instructions,
            "choices": [{"value": v, "description": d} for v, d in options.items()]}


def ask(questions: List[dict], text: str = "", images: Optional[List[tuple]] = None) -> Dict[str, dict]:
    """Answers by question name. `images` are (mime, base64) pairs.

    A choice answer is {"choice", "probability", "confidence",
    "probabilities": {value: p}};
    a predicate answer is {"probability"}. Raises DecisionError."""
    who = model()
    if not who:
        raise DecisionError("no decision model is configured")
    if images:
        content = ([{"type": "input_text", "text": text}] if text else []) + [
            {"type": "input_image", "image_url": f"data:{m};base64,{b}"} for m, b in images]
        payload_input = [{"role": "user", "content": content}]
    else:
        payload_input = text
    try:
        r = requests.post(f"{endpoint()}/decisions",
                          json={"model": who, "input": payload_input, "questions": questions},
                          timeout=float(_cfg().get("timeout", 30)))
        r.raise_for_status()
        answers = r.json()["answers"]
    except requests.exceptions.RequestException as e:
        body = getattr(getattr(e, "response", None), "text", "") or ""
        raise DecisionError(f"decision request to {who} failed: {e}"
                            + (f" — {body[:200]}" if body else ""))
    except (KeyError, TypeError, ValueError) as e:
        raise DecisionError(f"decision model {who} returned an unreadable reply: {e}")
    out = {}
    for a in answers if isinstance(answers, list) else []:
        if not isinstance(a, dict) or not a.get("name"):
            continue
        if a.get("type") == "choice":
            probs = {p.get("value"): float(p.get("probability") or 0)
                     for p in a.get("probabilities") or [] if isinstance(p, dict)}
            pick = a.get("choice")
            # Thresholds compare `probability` (the pick's share); the
            # server's own `confidence` is kept for the log.
            out[a["name"]] = {"choice": pick, "probabilities": probs,
                              "probability": probs.get(pick, 0.0),
                              "confidence": float(a.get("confidence") or 0)}
        elif a.get("type") == "predicate":
            out[a["name"]] = {"probability": float(a.get("probability") or 0)}
        else:
            out[a["name"]] = a
    missing = [q["name"] for q in questions if q["name"] not in out]
    if missing:
        raise DecisionError(f"decision model {who} left unanswered: {', '.join(missing)}")
    return out
