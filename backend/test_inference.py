"""Tests for LLM inference proxy in Collaborator backend."""

import json
from unittest.mock import patch, MagicMock

from inference import call_llm, get_available_models, chat_with_retry


def test_call_llm_basic_message():
    """Test basic LLM call with no context (streaming mode)."""
    # Mock SSE response
    mock_response_text = '''data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":", how can I "},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"help you?"},"finish_reason":null}]}
data: [DONE]
'''
    
    with patch('requests.post') as mock_post:
        mock_response_obj = MagicMock()
        mock_response_obj.raise_for_status = MagicMock()
        
        def iter_lines(decode_unicode=False):
            # Real requests.iter_lines() yields bytes; the parser decodes UTF-8.
            for line in mock_response_text.strip().split('\n'):
                yield line.encode('utf-8')
        
        mock_response_obj.iter_lines = iter_lines
        mock_post.return_value = mock_response_obj
        
        response = call_llm("Hello")
        
        assert "Hello" in response.text
        mock_post.assert_called_once()


def test_call_llm_with_context():
    """Test LLM call with previous context turns."""
    mock_response_text = '''data: {"choices":[{"delta":{"content":"Based on your previous message"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":", I can help."},"finish_reason":null}]}
data: [DONE]
'''
    
    context = [
        {"role": "user", "content": "What is Python?"},
        {"role": "assistant", "content": "Python is a programming language."}
    ]

    with patch('requests.post') as mock_post:
        mock_response_obj = MagicMock()
        mock_response_obj.raise_for_status = MagicMock()
        
        def iter_lines(decode_unicode=False):
            # Real requests.iter_lines() yields bytes; the parser decodes UTF-8.
            for line in mock_response_text.strip().split('\n'):
                yield line.encode('utf-8')
        
        mock_response_obj.iter_lines = iter_lines
        mock_post.return_value = mock_response_obj
        
        response = call_llm("Tell me more", context)
        
        assert "Based on your previous message" in response.text
        mock_post.assert_called_once()


def test_call_llm_utf8_streaming():
    """UTF-8 content (incl. a multi-byte char split across chunks) stays intact."""
    text = "I don’t have bugs — 3 × 4"  # don't  em-dash  times
    sse = ('data: ' + json.dumps({"choices": [{"delta": {"content": text}}]},
                                  ensure_ascii=False) + '\ndata: [DONE]\n')
    raw = sse.encode('utf-8')
    # Split the byte stream mid-character to mimic a network chunk boundary.
    cut = raw.index('’'.encode('utf-8')) + 1
    chunks = [raw[:cut], raw[cut:]]

    def iter_lines(decode_unicode=False):
        # Reassemble lines from byte chunks the way requests does.
        buf = b''
        for ch in chunks:
            buf += ch
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                yield line
        if buf:
            yield buf

    with patch('requests.post') as mock_post:
        mock_response_obj = MagicMock()
        mock_response_obj.raise_for_status = MagicMock()
        mock_response_obj.iter_lines = iter_lines
        mock_post.return_value = mock_response_obj

        response = call_llm("hi")
        assert response.text == text, f"mojibake: {response.text!r}"
        assert "â" not in response.text  # no latin-1 'â' leakage


def test_system_prompt_layers_from_files():
    """The paragraph layer is appended every turn; voice layer only in voice mode."""
    import inference

    base = inference._build_messages("hi")[0]["content"]
    assert "blank line" in base.lower()                 # paragraph layer present
    assert "voice mode" not in base.lower()             # voice layer absent

    voiced = inference._build_messages("hi", mode="voice")[0]["content"]
    assert "voice mode" in voiced.lower()               # voice layer present
    assert "blank line" in voiced.lower()               # paragraph layer still present

    # Layers resolve from files (precedence: file > inline string > default).
    import tempfile, os
    p = os.path.join(tempfile.mkdtemp(), "para.md")
    with open(p, "w", encoding="utf-8") as f:
        f.write("CUSTOM PARAGRAPH LAYER")
    assert inference._load_prompt_layer(
        {"paragraph_file": p}, "paragraph_file", "paragraph_text",
        inference.DEFAULT_PARAGRAPH_STYLE) == "CUSTOM PARAGRAPH LAYER"
    assert inference._load_prompt_layer(
        {"paragraph_text": "INLINE"}, "paragraph_file", "paragraph_text",
        inference.DEFAULT_PARAGRAPH_STYLE) == "INLINE"
    print("✓ system prompt layers load from files (paragraph always, voice in voice mode)")


def test_datetime_grounding_in_system_prompt():
    """Every turn carries today's date + the don't-argue rule — in a LATE
    system message (dynamic content near the prompt head would invalidate LM
    Studio's prefix cache every minute)."""
    import time as _time
    import inference

    msgs = inference._build_messages("hi")
    assert _time.strftime("%Y-%m-%d") not in msgs[0]["content"]   # head stays static
    dynamic = msgs[-2]
    assert dynamic["role"] == "system" and msgs[-1]["role"] == "user"
    system = dynamic["content"]
    assert _time.strftime("%Y-%m-%d") in system          # today's actual date, filled in
    assert "ground truth" in system.lower()
    assert "{now}" not in system                          # placeholder substituted

    # Inline config override respected, with substitution. (inference reads the
    # live config singleton — no separate cache to poke.)
    import config
    sp = config.get_config().setdefault("system_prompt", {})
    had = "datetime_text" in sp
    orig = sp.get("datetime_text")
    sp["datetime_text"] = "It is {now}, trust me."
    try:
        system = inference._build_messages("hi")[-2]["content"]
        assert "trust me" in system and _time.strftime("%Y-%m-%d") in system
    finally:
        if had:
            sp["datetime_text"] = orig
        else:
            del sp["datetime_text"]
    print("✓ datetime grounding: injected every turn, substituted, overridable")


def test_extract_message_text_reasoning_models():
    import inference
    # Normal answer passes through.
    data = {"choices": [{"message": {"content": "Transit Planning Session"}}]}
    assert inference._extract_message_text(data) == "Transit Planning Session"
    # Reasoning model with a real answer: content used, reasoning ignored.
    data = {"choices": [{"message": {"reasoning_content": "The user discussed...",
                                     "content": "Transit Planning"}}]}
    assert inference._extract_message_text(data) == "Transit Planning"
    # Inline <think> block stripped.
    data = {"choices": [{"message": {"content": "<think>hmm, a title</think>\nGood Title"}}]}
    assert inference._extract_message_text(data) == "Good Title"
    # Budget eaten by reasoning: empty string (logged), never the reasoning text.
    data = {"choices": [{"message": {"reasoning_content": "Let me think about",
                                     "content": ""}}]}
    assert inference._extract_message_text(data, "title generation") == ""
    # Malformed response never raises.
    assert inference._extract_message_text({}) == ""
    print("✓ reasoning-aware extraction: content only, <think> stripped, safe")


def test_generate_title_with_reasoning_model():
    from unittest.mock import patch, MagicMock
    import inference
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = lambda: {"choices": [{"message": {
        "reasoning_content": "They talked about transit mostly.",
        "content": "Transit and City Design\nextra line ignored"}}]}
    with patch("requests.post", return_value=resp) as p:
        title = inference.generate_title([{"role": "user", "content": "transit talk"}])
        assert title == "Transit and City Design"
        # Reasoning headroom: budget no longer starves the answer.
        assert p.call_args.kwargs["json"]["max_tokens"] >= 256
    print("✓ generate_title: reasoning model handled, headroom budget")


def test_utility_model_routing():
    """Titles/synthesis route to utility_model when set; notes synthesis (vault-
    authoring) always stays on the chat model."""
    from unittest.mock import patch, MagicMock
    import config as _config, inference
    inf = _config.get_config()["inference"]
    orig = inf.get("utility_model")
    inf["utility_model"] = "small-utility"
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = lambda: {"choices": [{"message": {"content": "Ok Title"}}]}
    try:
        with patch("requests.post", return_value=resp) as p:
            inference.generate_title([{"role": "user", "content": "x"}])
            assert p.call_args.kwargs["json"]["model"] == "small-utility"
            inference.synthesize_recall("q", [{"text": "m", "tags": [], "score": 1}])
            assert p.call_args.kwargs["json"]["model"] == "small-utility"
            inference.synthesize("memory", ["a"])
            assert p.call_args.kwargs["json"]["model"] == "small-utility"
            resp.json = lambda: {"choices": [{"message": {"content": '{"notes": []}'}}]}
            inference.synthesize_notes({"id": 1, "children": []})
            assert p.call_args.kwargs["json"]["model"] == inf["model_id"]  # chat model
        # Unset -> everything falls back to the chat model.
        inf["utility_model"] = None
        resp.json = lambda: {"choices": [{"message": {"content": "T"}}]}
        with patch("requests.post", return_value=resp) as p:
            inference.generate_title([{"role": "user", "content": "x"}])
            assert p.call_args.kwargs["json"]["model"] == inf["model_id"]
    finally:
        inf["utility_model"] = orig
    print("✓ utility model: titles/synthesis routed; vault-authoring stays on chat")


def test_available_models():
    """Test getting available models."""
    mock_response = {
        "data": [
            {"id": "model-1"},
            {"id": "model-2"}
        ]
    }
    
    with patch('requests.get') as mock_get:
        mock_response_obj = MagicMock()
        mock_response_obj.raise_for_status = MagicMock()
        mock_response_obj.json.return_value = mock_response
        mock_get.return_value = mock_response_obj
        
        models = get_available_models()
        
        assert "model-1" in models
        assert "model-2" in models


def test_chat_with_retry_success():
    """Test chat with retry on success."""
    mock_response_text = '''data: {"choices":[{"delta":{"content":"Hello!"},"finish_reason":null}]}
data: [DONE]
'''
    
    with patch('requests.post') as mock_post:
        mock_response_obj = MagicMock()
        mock_response_obj.raise_for_status = MagicMock()
        
        def iter_lines(decode_unicode=False):
            # Real requests.iter_lines() yields bytes; the parser decodes UTF-8.
            for line in mock_response_text.strip().split('\n'):
                yield line.encode('utf-8')
        
        mock_response_obj.iter_lines = iter_lines
        mock_post.return_value = mock_response_obj
        
        result = chat_with_retry("Hello")
        
        assert "Hello!" in result


if __name__ == "__main__":
    test_call_llm_basic_message()
    print("✓ basic message test passed")
    
    test_call_llm_with_context()
    print("✓ context test passed")

    test_call_llm_utf8_streaming()
    print("✓ utf-8 streaming test passed")

    test_system_prompt_layers_from_files()

    test_datetime_grounding_in_system_prompt()

    test_available_models()
    print("✓ available models test passed")
    
    test_chat_with_retry_success()
    print("✓ chat with retry success test passed")
    
    print("\n✓ All inference tests passed!")


def test_empty_reasoning_only_stream_is_honest():
    """A stream of pure reasoning_content (budget exhausted before the answer)
    must yield an explanatory message, never silent emptiness."""
    from unittest.mock import patch, MagicMock
    import inference
    lines = [
        b'data: {"choices":[{"delta":{"reasoning_content":"thinking..."},"finish_reason":null}]}',
        b'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        b'data: [DONE]',
    ]
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.iter_lines = lambda: iter(lines)
    with patch("requests.post", return_value=resp):
        out = "".join(inference.stream_llm_tokens("hard question"))
    assert "internal reasoning" in out and "max_tokens" in out
    print("✓ reasoning-only stream yields an honest message, not emptiness")


def test_title_excerpt_spans_whole_conversation():
    """Long threads: the title excerpt samples opening + recent turns, so the
    title names the thread, not the latest tangent."""
    from unittest.mock import patch, MagicMock
    import inference
    turns = ([{"role": "user", "content": "OPENING: let's design a birdhouse"}]
             + [{"role": "assistant", "content": f"mid {i}"} for i in range(30)]
             + [{"role": "user", "content": "RECENT: paint color tangent"}])
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = lambda: {"choices": [{"message": {"content": "Birdhouse Design"}}]}
    with patch("requests.post", return_value=resp) as p:
        inference.generate_title(turns)
    excerpt = p.call_args.kwargs["json"]["messages"][1]["content"]
    assert "OPENING: let's design a birdhouse" in excerpt
    assert "RECENT: paint color tangent" in excerpt
    assert "turns omitted" in excerpt
    print("✓ title excerpt includes the opening AND the tail of long threads")


def test_stream_error_payloads_surface():
    """LM Studio streams errors as JSON lines (e.g. jinja template failures) —
    they must raise, never be silently skipped into an empty response."""
    from unittest.mock import patch, MagicMock
    import pytest, inference
    lines = [b'data: {"error":{"message":"No user query found in messages."}}']
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.iter_lines = lambda: iter(lines)
    with patch("requests.post", return_value=resp):
        with pytest.raises(Exception) as e:
            list(inference.stream_llm_tokens("hi"))
    assert "No user query found" in str(e.value)
    print("✓ in-stream error payloads raise with the real message")


def test_empty_history_turns_skipped():
    """Poisoned histories (empty assistant turns from past failures) heal on
    read: empty-content turns never reach the model."""
    import inference
    ctx = [
        {"role": "user", "content": "real question"},
        {"role": "assistant", "content": ""},          # the poison
        {"role": "assistant", "content": "   "},
        {"role": "user", "content": "follow-up"},
    ]
    msgs = inference._build_messages("now", ctx)
    contents = [m["content"] for m in msgs if m["role"] in ("user", "assistant")]
    assert "real question" in contents and "follow-up" in contents
    assert "" not in contents and "   " not in contents
    print("✓ empty history turns filtered out of context assembly")


def test_model_ids_match_loose():
    from inference import model_ids_match
    assert model_ids_match("MiniMax-M2.5-REAP-29-MLX", "minimax-m2.5-reap-29-mlx")
    assert model_ids_match("qwen/qwen3-4b-2507", "qwen3-4b-2507")
    assert model_ids_match("qwen3-4b-2507:2", "qwen/qwen3-4b-2507")
    assert not model_ids_match("qwen3-4b-2507", "qwen3-32b")
    assert not model_ids_match(None, "x") and not model_ids_match("x", "")
    print("✓ loose id matching: case, publisher prefix, instance suffix")


def test_leading_assistant_turns_dropped():
    """The turns window / token trimmer can slice a chain mid-pair, stranding
    an assistant turn at the front of history — qwen3.6's template hard-errors
    on it ('No user query found'). History must always open with a user turn."""
    import inference
    ctx = [
        {"role": "assistant", "content": "stranded reply"},
        {"role": "user", "content": "first real question"},
        {"role": "assistant", "content": "answer"},
    ]
    msgs = inference._build_messages("now", ctx)
    convo = [m for m in msgs if m["role"] in ("user", "assistant")]
    assert convo[0]["role"] == "user" and convo[0]["content"] == "first real question"
    assert all(m["content"] != "stranded reply" for m in convo)

    # Empty-filtering can CREATE the stranded case: empty user then assistant.
    ctx2 = [
        {"role": "user", "content": "   "},
        {"role": "assistant", "content": "reply to nothing"},
        {"role": "user", "content": "real"},
    ]
    msgs = inference._build_messages("now", ctx2)
    convo = [m for m in msgs if m["role"] in ("user", "assistant")]
    assert convo[0]["content"] == "real"
    print("✓ history never opens with an assistant turn")


# --- Chain-of-thought dialects (side fields + inline markers) ----------------

def test_delta_reasoning_reads_every_known_side_field():
    """Servers disagree on the field name — all of them must light the pane."""
    from inference import _delta_reasoning
    assert _delta_reasoning({"reasoning_content": "a"}) == "a"   # llama.cpp / LM Studio
    assert _delta_reasoning({"reasoning": "b"}) == "b"           # OpenRouter / gpt-oss
    assert _delta_reasoning({"thinking": "c"}) == "c"            # Ollama-style
    assert _delta_reasoning({"reasoning": {"text": "d"}}) == "d"
    assert _delta_reasoning({"reasoning": [{"type": "text", "text": "e"}]}) == "e"
    assert _delta_reasoning({"content": "answer"}) == ""
    assert _delta_reasoning({}) == "" and _delta_reasoning(None) == ""
    print("✓ reasoning side fields: reasoning_content / reasoning / thinking")


def test_think_splitter_inline_tags_across_chunks():
    """<think>…</think> inline in content, with markers split across chunks."""
    from inference import _ThinkSplitter
    s = _ThinkSplitter()
    chunks = ["<thi", "nk>let me ", "reason</th", "ink>The ans", "wer is 4."]
    r, a = "", ""
    for c in chunks:
        tr, ta = s.feed(c)
        r += tr
        a += ta
    tr, ta = s.flush()
    r += tr
    a += ta
    assert r == "let me reason"
    assert a == "The answer is 4."
    print("✓ <think> blocks split out of content even across chunk boundaries")


def test_think_splitter_harmony_channels():
    """Raw gpt-oss harmony framing leaking through content: analysis channel
    becomes reasoning, final channel becomes the answer, control tokens vanish."""
    from inference import _ThinkSplitter
    s = _ThinkSplitter()
    text = ("<|channel|>analysis<|message|>User wants sum.<|end|>"
            "<|start|>assistant<|channel|>final<|message|>2 + 2 = 4<|return|>")
    r, a = "", ""
    for i in range(0, len(text), 7):   # awkward 7-char chunks
        tr, ta = s.feed(text[i:i + 7])
        r += tr
        a += ta
    tr, ta = s.flush()
    r += tr
    a += ta
    assert r == "User wants sum."
    assert a == "2 + 2 = 4"
    assert "<|" not in a
    print("✓ harmony analysis/final channels split; control tokens dropped")


def test_think_splitter_plain_content_untouched():
    """No markers: everything passes through verbatim, including '<' in prose."""
    from inference import _ThinkSplitter
    s = _ThinkSplitter()
    out = ""
    for c in ["if a < b then", " <b>bold</b> ok", " and 3 <", " 5 done"]:
        out += s.feed(c)[1]
    out += s.flush()[1]
    assert out == "if a < b then <b>bold</b> ok and 3 < 5 done"
    assert not s.saw_marker
    print("✓ plain content passes the splitter untouched")


def test_stream_llm_tokens_reasoning_field_dialect():
    """A server that streams thinking under `reasoning` (gpt-oss on LM Studio)
    yields reasoning events, exactly like the reasoning_content dialect."""
    from unittest.mock import patch, MagicMock
    import inference
    lines = [
        b'data: {"choices":[{"delta":{"reasoning":"Let me "},"finish_reason":null}]}',
        b'data: {"choices":[{"delta":{"reasoning":"think."},"finish_reason":null}]}',
        b'data: {"choices":[{"delta":{"content":"Paris."},"finish_reason":null}]}',
        b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        b'data: [DONE]',
    ]
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.iter_lines = lambda: iter(lines)
    with patch("requests.post", return_value=resp):
        events = list(inference.stream_llm_tokens("capital?", include_reasoning=True))
    reasoning = "".join(e["content"] for e in events if e["type"] == "reasoning")
    tokens = "".join(e["content"] for e in events if e["type"] == "token")
    assert reasoning == "Let me think."
    assert tokens == "Paris."
    print("✓ stream_llm_tokens: `reasoning` field dialect streams to the pane")


def test_stream_llm_tokens_inline_think_dialect():
    """Inline <think> in content (parsing off server-side) never reaches the
    saved answer and does reach the pane."""
    from unittest.mock import patch, MagicMock
    import inference
    lines = [
        b'data: {"choices":[{"delta":{"content":"<think>hmm"},"finish_reason":null}]}',
        b'data: {"choices":[{"delta":{"content":" ok</think>Ans"},"finish_reason":null}]}',
        b'data: {"choices":[{"delta":{"content":"wer"},"finish_reason":null}]}',
        b'data: [DONE]',
    ]
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.iter_lines = lambda: iter(lines)
    with patch("requests.post", return_value=resp):
        events = list(inference.stream_llm_tokens("q", include_reasoning=True))
    reasoning = "".join(e["content"] for e in events if e["type"] == "reasoning")
    tokens = "".join(e["content"] for e in events if e["type"] == "token")
    assert reasoning == "hmm ok" and tokens == "Answer"
    # Legacy plain-string mode: the think block is simply absent from the text.
    with patch("requests.post", return_value=resp):
        plain = "".join(inference.stream_llm_tokens("q"))
    assert plain == "Answer"
    print("✓ stream_llm_tokens: inline <think> split out of the answer")


def test_generate_with_tools_harmony_reasoning():
    """The tool loop handles both dialects too: side-field `reasoning` AND raw
    harmony channels in content; the answer tokens carry no markers."""
    from unittest.mock import patch, MagicMock
    import inference
    lines = [
        b'data: {"choices":[{"delta":{"reasoning":"side-channel thought "},"finish_reason":null}]}',
        b'data: {"choices":[{"delta":{"content":"<|channel|>analysis<|message|>inline thought<|end|>"},"finish_reason":null}]}',
        b'data: {"choices":[{"delta":{"content":"<|start|>assistant<|channel|>final<|message|>Final answer."},"finish_reason":null}]}',
        b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        b'data: [DONE]',
    ]
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.iter_lines = lambda: iter(lines)
    schema = {"type": "function", "function": {"name": "calculate",
              "description": "x", "parameters": {"type": "object", "properties": {}}}}
    with patch("requests.post", return_value=resp):
        events = list(inference.generate_with_tools(
            "q", [], None, tool_schemas=[schema],
            execute_tool=lambda n, a: "{}", max_rounds=2))
    reasoning = "".join(e["content"] for e in events if e["type"] == "reasoning")
    tokens = "".join(e["content"] for e in events if e["type"] == "token")
    assert "side-channel thought" in reasoning and "inline thought" in reasoning
    assert tokens == "Final answer."
    assert not any(e["type"] == "error" for e in events)
    print("✓ generate_with_tools: side-field + harmony reasoning both stream")


def test_extract_message_text_other_dialects():
    """Non-streaming: `reasoning`/`thinking` side fields count as reasoning for
    the budget warning, and harmony framing is stripped from content."""
    from inference import _extract_message_text
    data = {"choices": [{"message": {
        "reasoning": "thinking", "content":
        "<|start|>assistant<|channel|>final<|message|>Title Here<|return|>"}}]}
    assert _extract_message_text(data) == "Title Here"
    data = {"choices": [{"message": {"thinking": "all budget", "content": ""}}]}
    assert _extract_message_text(data) == ""
    data = {"choices": [{"message": {"content": "<think>x</think>Real"}}]}
    assert _extract_message_text(data) == "Real"
    print("✓ non-streaming extraction handles every dialect")


def test_reasoning_effort_passthrough():
    """inference.reasoning_effort rides the payload only when set."""
    import config, inference
    cfg = config.get_config()["inference"]
    old = cfg.get("reasoning_effort")
    try:
        cfg["reasoning_effort"] = None
        assert "reasoning_effort" not in inference._build_payload([], stream=True)
        cfg["reasoning_effort"] = "high"
        assert inference._build_payload([], stream=True)["reasoning_effort"] == "high"
    finally:
        cfg["reasoning_effort"] = old
    print("✓ reasoning_effort forwarded only when configured")
