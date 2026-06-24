"""Tests for LLM inference proxy in Collaborator backend."""

import json
from unittest.mock import patch, MagicMock

from inference import call_llm, get_available_models, chat_with_retry


def test_call_llm_basic_message():
    """Test basic LLM call with no context."""
    mock_response = {
        "choices": [
            {"message": {"content": "Hello, how can I help you?"}}
        ]
    }
    
    with patch('requests.post') as mock_post:
        mock_response_obj = MagicMock()
        mock_response_obj.raise_for_status = MagicMock()
        mock_response_obj.json.return_value = mock_response
        mock_post.return_value = mock_response_obj
        
        result = call_llm("Hello")
        
        assert "Hello, how can I help you?" in result
        mock_post.assert_called_once()


def test_call_llm_with_context():
    """Test LLM call with previous context turns."""
    mock_response = {
        "choices": [
            {"message": {"content": "Based on your previous message, I can help."}}
        ]
    }
    
    context = [
        {"role": "user", "content": "What is Python?"},
        {"role": "assistant", "content": "Python is a programming language."}
    ]
    
    with patch('requests.post') as mock_post:
        mock_response_obj = MagicMock()
        mock_response_obj.raise_for_status = MagicMock()
        mock_response_obj.json.return_value = mock_response
        mock_post.return_value = mock_response_obj
        
        result = call_llm("Can you explain?", context)
        
        assert "Based on your previous message" in result
        mock_post.assert_called_once()


def test_get_available_models():
    """Test fetching available models."""
    mock_response = {
        "data": [
            {"id": "model1"},
            {"id": "model2"},
        ]
    }
    
    with patch('requests.get') as mock_get:
        mock_response_obj = MagicMock()
        mock_response_obj.raise_for_status = MagicMock()
        mock_response_obj.json.return_value = mock_response
        mock_get.return_value = mock_response_obj
        
        models = get_available_models()
        
        assert "model1" in models
        assert "model2" in models


def test_chat_with_retry_success():
    """Test chat with retry on first attempt."""
    mock_response = {
        "choices": [
            {"message": {"content": "Success on first try"}}
        ]
    }
    
    with patch('requests.post') as mock_post:
        mock_response_obj = MagicMock()
        mock_response_obj.raise_for_status = MagicMock()
        mock_response_obj.json.return_value = mock_response
        mock_post.return_value = mock_response_obj
        
        result = chat_with_retry("Test message")
        
        assert "Success on first try" in result
        assert mock_post.call_count == 1


def test_chat_with_retry_retries_then_succeeds():
    """Test chat with retry mechanism."""
    mock_response = {
        "choices": [
            {"message": {"content": "Success after retry"}}
        ]
    }
    
    call_count = [0]
    
    def side_effect(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] < 3:
            from requests.exceptions import ConnectionError
            raise ConnectionError("Connection failed")
        mock_response_obj = MagicMock()
        mock_response_obj.raise_for_status = MagicMock()
        mock_response_obj.json.return_value = mock_response
        return mock_response_obj
    
    with patch('requests.post', side_effect=side_effect):
        result = chat_with_retry("Test message")
        
        assert "Success after retry" in result
        assert call_count[0] == 3


if __name__ == "__main__":
    test_call_llm_basic_message()
    print("✓ basic message test passed")
    
    test_call_llm_with_context()
    print("✓ context test passed")
    
    test_get_available_models()
    print("✓ available models test passed")
    
    test_chat_with_retry_success()
    print("✓ chat with retry success test passed")
    
    test_chat_with_retry_retries_then_succeeds()
    print("✓ chat with retry mechanism test passed")
    
    print("\n✓ All inference tests passed!")
