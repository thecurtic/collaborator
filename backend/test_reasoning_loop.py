"""Reasoning-loop guard: detect looping thoughts, cut, retry once with a nudge."""

import json
import random
from pathlib import Path
from unittest.mock import patch, MagicMock

import inference
from inference import _LoopDetector, LOOP_RETRY_NUDGE

LOOP_PHRASES = [
    "Wait, but the user asked about X. Let me reconsider whether X implies Y.",
    "Hmm, actually, if X implies Y then Z must follow, unless we consider W.",
    "But wait, W was ruled out earlier. So maybe I should re-examine X itself.",
]


def _feed(detector, text, chunk=40):
    """Feed text in stream-sized chunks; True if the detector tripped."""
    return any(detector.feed(text[i:i + chunk]) for i in range(0, len(text), chunk))


def test_repeated_sentence_trips():
    looped = " ".join([LOOP_PHRASES[0]] * 4)
    assert _feed(_LoopDetector(), looped)
    assert not _feed(_LoopDetector(), " ".join([LOOP_PHRASES[0]] * 3))


def test_short_repeats_do_not_trip():
    # Short stock phrases ("Let me check.") recur in honest reasoning.
    assert not _feed(_LoopDetector(), "Let me check. Okay. Hmm. Wait. " * 50)


def test_reworded_loop_trips_on_compression():
    # Each sentence is unique (numbered), so only the compression check sees it.
    rng = random.Random(0)
    text = " ".join(f"{rng.choice(LOOP_PHRASES)[:-1]} ({i})." for i in range(120))
    assert _feed(_LoopDetector(), text)


def test_real_prose_does_not_trip():
    # The repo's own long design docs stand in for long, honest reasoning.
    root = Path(__file__).resolve().parent.parent
    for name in ("INTENTS.md", "API-SPEC.md"):
        assert not _feed(_LoopDetector(), (root / name).read_text()), name


def _resp(lines):
    r = MagicMock()
    r.raise_for_status = MagicMock()
    r.iter_lines = lambda: iter(lines)
    return r


def _reasoning_line(text):
    return ("data: " + json.dumps({"choices": [{"delta": {"reasoning_content": text},
                                                "finish_reason": None}]})).encode()


LOOPING = [_reasoning_line(LOOP_PHRASES[0] + " ") for _ in range(10)] + [b"data: [DONE]"]
GOOD = [_reasoning_line("Short thought. "),
        b'data: {"choices":[{"delta":{"content":"The answer."},"finish_reason":null}]}',
        b"data: [DONE]"]


def test_stream_llm_tokens_cuts_and_retries_with_nudge():
    first, second = _resp(LOOPING), _resp(GOOD)
    with patch("requests.post", side_effect=[first, second]) as post:
        events = list(inference.stream_llm_tokens("hard idea", include_reasoning=True))
    assert post.call_count == 2
    first.close.assert_called()
    retry_system = " ".join(m["content"] for m in post.call_args_list[1].kwargs["json"]["messages"]
                            if m["role"] == "system")
    assert LOOP_RETRY_NUDGE in retry_system
    # The user's message itself is untouched.
    assert post.call_args_list[1].kwargs["json"]["messages"][-1]["content"] == "hard idea"
    assert any(e["type"] == "status" and "circles" in e["label"] for e in events)
    assert "".join(e["content"] for e in events if e["type"] == "token") == "The answer."


def test_stream_llm_tokens_retries_only_once():
    with patch("requests.post", side_effect=[_resp(LOOPING), _resp(LOOPING)]) as post:
        list(inference.stream_llm_tokens("hard idea", include_reasoning=True))
    assert post.call_count == 2


def test_loop_retry_can_be_disabled():
    cfg = inference._get_config()
    cfg = {**cfg, "inference": {**cfg["inference"], "reasoning_loop_retry": False}}
    with patch("inference._get_config", return_value=cfg), \
         patch("requests.post", side_effect=[_resp(LOOPING)]) as post:
        list(inference.stream_llm_tokens("hard idea", include_reasoning=True))
    assert post.call_count == 1


def test_generate_with_tools_retries_same_round():
    schema = {"type": "function", "function": {"name": "calculate",
              "description": "x", "parameters": {"type": "object", "properties": {}}}}
    with patch("requests.post", side_effect=[_resp(LOOPING), _resp(GOOD)]) as post:
        events = list(inference.generate_with_tools(
            "hard idea", [], None, tool_schemas=[schema],
            execute_tool=lambda n, a: "{}", max_rounds=2))
    assert post.call_count == 2
    retry = post.call_args_list[1].kwargs["json"]
    assert "tools" in retry   # the retry did not use up a tools round
    assert retry["messages"][-1] == {"role": "system", "content": LOOP_RETRY_NUDGE}
    assert not any(e["type"] == "error" for e in events)
    assert "".join(e["content"] for e in events if e["type"] == "token") == "The answer."
