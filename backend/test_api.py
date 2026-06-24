"""Tests for FastAPI endpoints in Collaborator backend.

Uses mocking to test without running actual server.
"""

from unittest.mock import patch, MagicMock
import os

# Set test environment before importing app
os.environ["BACKEND_HOST"] = "127.0.0.1"
os.environ["PORT"] = "8001"

from main import app, config


def test_config_loaded():
    """Test that config is loaded on startup."""
    assert config is not None
    assert "inference" in config
    assert "server" in config


def test_health_check():
    """Test the health check endpoint."""
    # Access the endpoint through FastAPI's TestClient
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    response = client.get("/api/health")
    
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["version"] == "0.1.0"


def test_send_message_success():
    """Test sending a message."""
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    mock_db = MagicMock()
    
    # Mock recent turns
    mock_recent_turns = []
    
    with patch('main.get_db') as mock_get_db, \
         patch('main.get_recent_turns') as mock_get_recent, \
         patch('main.call_llm') as mock_call_llm, \
         patch('main.create_turn') as mock_create:
        
        mock_get_db.return_value = mock_db
        mock_get_recent.return_value = mock_recent_turns
        
        # Mock LLM response
        mock_call_llm.return_value = "Hello! How can I help you?"
        
        # Mock turn creation
        mock_turn_data = {
            "id": 1,
            "user_id": None,
            "role": "assistant",
            "content": "Hello! How can I help you?",
            "context_turns": 5,
            "committed": True,
        }
        mock_create.return_value = mock_turn_data
        
        response = client.post(
            "/api/messages",
            json={"message": "Hello"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "response" in data
        assert data["response"] == "Hello! How can I help you?"
        assert data["committed"] is True
        
        # Verify LLM was called
        mock_call_llm.assert_called_once()


def test_send_message_with_context():
    """Test sending a message with custom context window."""
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    mock_db = MagicMock()
    
    with patch('main.get_db') as mock_get_db, \
         patch('main.get_recent_turns') as mock_get_recent, \
         patch('main.call_llm') as mock_call_llm, \
         patch('main.create_turn'):
        
        mock_get_db.return_value = mock_db
        mock_get_recent.return_value = [{"role": "user", "content": "Previous message"}]
        
        mock_call_llm.return_value = "I can help with that."
        
        response = client.post(
            "/api/messages",
            json={"message": "Tell me more", "context_turns": 3}
        )
        
        assert response.status_code == 200
        
        # Verify context_turns was passed to get_recent_turns
        mock_get_recent.assert_called_once()
        call_kwargs = mock_get_recent.call_args[1]
        assert call_kwargs.get("limit") == 3


def test_send_message_discard():
    """Test sending a message with commit=False."""
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    mock_db = MagicMock()
    
    with patch('main.get_db') as mock_get_db, \
         patch('main.get_recent_turns'), \
         patch('main.call_llm') as mock_call_llm, \
         patch('main.create_turn'):
        
        mock_get_db.return_value = mock_db
        mock_call_llm.return_value = "Response"
        
        response = client.post(
            "/api/messages",
            json={"message": "Test", "commit": False}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["committed"] is False


def test_get_messages():
    """Test retrieving messages."""
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    mock_db = MagicMock()
    
    with patch('main.get_db') as mock_get_db, \
         patch('main.get_recent_turns') as mock_get_recent:
        
        mock_get_db.return_value = mock_db
        
        # Mock returned turns
        mock_turns = [
            {"id": 1, "content": "Hello"},
            {"id": 2, "content": "Hi there"},
        ]
        mock_get_recent.return_value = mock_turns
        
        response = client.get("/api/messages")
        
        assert response.status_code == 200
        data = response.json()
        assert "turns" in data
        assert "count" in data
        assert len(data["turns"]) == 2
        assert data["count"] == 2


def test_get_messages_pagination():
    """Test message retrieval with pagination."""
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    mock_db = MagicMock()
    
    with patch('main.get_db') as mock_get_db, \
         patch('main.get_recent_turns') as mock_get_recent:
        
        mock_get_db.return_value = mock_db
        mock_get_recent.return_value = []
        
        response = client.get("/api/messages?limit=10&offset=5")
        
        assert response.status_code == 200
        mock_get_recent.assert_called_once()
        call_kwargs = mock_get_recent.call_args[1]
        assert call_kwargs.get("limit") == 10
        assert call_kwargs.get("offset") == 5


def test_discard_turn_success():
    """Test discarding a turn."""
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    mock_db = MagicMock()
    
    with patch('main.get_db') as mock_get_db, \
         patch('main.update_turn_committed') as mock_update:
        
        mock_get_db.return_value = mock_db
        mock_update.return_value = True
        
        response = client.delete("/api/messages/1")
        
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == 1
        assert data["committed"] is False


def test_discard_turn_not_found():
    """Test discarding a non-existent turn."""
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    mock_db = MagicMock()
    
    with patch('main.get_db') as mock_get_db, \
         patch('main.update_turn_committed') as mock_update:
        
        mock_get_db.return_value = mock_db
        mock_update.return_value = False
        
        response = client.delete("/api/messages/999")
        
        assert response.status_code == 404


if __name__ == "__main__":
    test_config_loaded()
    print("✓ config loaded test passed")
    
    test_health_check()
    print("✓ health check test passed")
    
    test_send_message_success()
    print("✓ send message success test passed")
    
    test_send_message_with_context()
    print("✓ send message with context test passed")
    
    test_send_message_discard()
    print("✓ send message discard test passed")
    
    test_get_messages()
    print("✓ get messages test passed")
    
    test_get_messages_pagination()
    print("✓ get messages pagination test passed")
    
    test_discard_turn_success()
    print("✓ discard turn success test passed")
    
    test_discard_turn_not_found()
    print("✓ discard turn not found test passed")
    
    print("\n✓ All API tests passed!")
