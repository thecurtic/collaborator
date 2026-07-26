"""Tests for FastAPI endpoints in Collaborator backend.

Runs against a real temporary SQLite DB (auth disabled) with the LLM mocked.
"""

import os
import tempfile

# Configure a throwaway DB and disable auth BEFORE importing the app.
os.environ["BACKEND_HOST"] = "127.0.0.1"
os.environ["PORT"] = "8001"
os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")

import config
config.get_config._config = config.load_config()
import main
from main import app, config as app_config
from starlette.testclient import TestClient


def _mock_stream():
    def fake_stream(message, context_turns=None, mode=None, recall=None):
        for tok in ["Hello!", " ", "How can I help?"]:
            yield tok
    main.stream_llm_tokens = fake_stream


def test_config_loaded():
    assert app_config is not None
    assert "inference" in app_config and "server" in app_config


def test_health_check():
    client = TestClient(app)
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "healthy"
    assert r.json()["version"] == "0.4.0"
    assert set(r.json()["capabilities"]) == {"stt_stream", "tts_stream", "phrases"}


def test_send_message_streams_and_persists():
    _mock_stream()
    client = TestClient(app)
    r = client.post("/api/messages", json={"message": "Hello", "context_turns": 5})
    assert r.status_code == 200
    assert '"type": "token"' in r.text
    assert '"type": "done"' in r.text
    # The exchange is now retrievable.
    hist = client.get("/api/messages").json()
    assert hist["count"] >= 2
    assert any(t["role"] == "assistant" and t["content"] == "Hello! How can I help?"
               for t in hist["turns"])


def test_get_messages():
    client = TestClient(app)
    r = client.get("/api/messages")
    assert r.status_code == 200
    data = r.json()
    assert "turns" in data and "count" in data


def test_delete_reparents_children():
    _mock_stream()
    import sqlite3, db
    path = os.environ["DB_PATH"]
    conn = sqlite3.connect(path)
    root = db.create_turn(conn, None, "user", "root")
    mid = db.create_turn(conn, None, "assistant", "mid", parent_turn_id=root["id"])
    leaf = db.create_turn(conn, None, "user", "leaf", parent_turn_id=mid["id"])
    conn.close()

    client = TestClient(app)
    # Delete the middle turn: leaf should reparent up to root.
    r = client.delete(f"/api/messages/{mid['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["deleted"] is True
    assert body["removed_turn_ids"] == [mid["id"]]
    assert body["reparented_to"] == root["id"]
    assert leaf["id"] in body["reparented_children"]

    conn = sqlite3.connect(path)
    assert db.get_turn_by_id(conn, mid["id"]) is None          # row is gone (hard delete)
    assert db.get_turn_by_id(conn, leaf["id"])["parent_turn_id"] == root["id"]
    conn.close()

    # Deleting a missing turn -> 404
    assert client.delete("/api/messages/999999").status_code == 404


def test_delete_subtree():
    import sqlite3, db
    path = os.environ["DB_PATH"]
    conn = sqlite3.connect(path)
    a = db.create_turn(conn, None, "user", "branch-root")
    b = db.create_turn(conn, None, "assistant", "child", parent_turn_id=a["id"])
    c = db.create_turn(conn, None, "user", "grandchild", parent_turn_id=b["id"])
    conn.close()

    client = TestClient(app)
    r = client.delete(f"/api/messages/{a['id']}?subtree=true")
    assert r.status_code == 200
    assert r.json()["removed_count"] == 3
    assert set(r.json()["removed_turn_ids"]) == {a["id"], b["id"], c["id"]}

    conn = sqlite3.connect(path)
    assert all(db.get_turn_by_id(conn, t) is None for t in (a["id"], b["id"], c["id"]))
    conn.close()


if __name__ == "__main__":
    test_config_loaded(); print("✓ config loaded")
    test_health_check(); print("✓ health check")
    test_send_message_streams_and_persists(); print("✓ send message streams + persists")
    test_get_messages(); print("✓ get messages")
    test_delete_reparents_children(); print("✓ delete reparents children")
    test_delete_subtree(); print("✓ delete subtree")
    print("\n✓ All API tests passed!")
