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
