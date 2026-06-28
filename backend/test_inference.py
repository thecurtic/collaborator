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

    test_available_models()
    print("✓ available models test passed")
    
    test_chat_with_retry_success()
    print("✓ chat with retry success test passed")
    
    print("\n✓ All inference tests passed!")
