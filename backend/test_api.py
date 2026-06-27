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
    
    with patch('main.create_user_db') as mock_create_db, \
         patch('main.get_recent_turns') as mock_get_recent, \
         patch('main.call_llm') as mock_call_llm, \
         patch('main.create_turn'):
        
        mock_create_db.return_value = "/tmp/test.db"
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
        
        # Mock sqlite3.connect
        with patch('sqlite3.connect') as mock_sqlite:
            mock_conn = MagicMock()
            mock_cursor = MagicMock()
            mock_conn.cursor.return_value = mock_cursor
            mock_sqlite.return_value = mock_conn
            
            response = client.post(
                "/api/messages",
                json={"message": "Hello"}
            )
        
        assert response.status_code == 200
        data = response.json()
        assert "response" in data
        assert data["response"] == "Hello! How can I help you?"
        assert data["committed"] is True


def test_get_messages():
    """Test retrieving messages."""
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    with patch('main.create_user_db') as mock_create_db, \
         patch('main.get_recent_turns') as mock_get_recent:
        
        mock_create_db.return_value = "/tmp/test.db"
        mock_get_recent.return_value = [
            {"id": 1, "content": "Hello"},
            {"id": 2, "content": "Hi there"},
        ]
        
        response = client.get("/api/messages")
        
        assert response.status_code == 200
        data = response.json()
        assert "turns" in data
        assert "count" in data
        assert len(data["turns"]) == 2
        assert data["count"] == 2


def test_discard_turn_success():
    """Test discarding a turn."""
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    with patch('main.create_user_db') as mock_create_db, \
         patch('main.get_turn_by_id'), \
         patch('main.update_turn_committed') as mock_update:
        
        mock_create_db.return_value = "/tmp/test.db"
        mock_update.return_value = True
        
        response = client.delete("/api/messages/1")
        
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == 1
        assert data["committed"] is False


if __name__ == "__main__":
    test_config_loaded()
    print("✓ config loaded test passed")
    
    test_health_check()
    print("✓ health check test passed")
    
    test_send_message_success()
    print("✓ send message success test passed")
    
    test_get_messages()
    print("✓ get messages test passed")
    
    test_discard_turn_success()
    print("✓ discard turn success test passed")
    
    print("\n✓ All API tests passed!")
