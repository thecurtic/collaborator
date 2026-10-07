#!/usr/bin/env python3
"""
Integration test for Collaborator backend with actual LLM endpoint.

This requires the LLM endpoint to be running and pip packages installed.
Run with: `pip install requests && python3 test_integration.py`
"""

import os
import json

# Load environment variables
from dotenv import load_dotenv
load_dotenv()

LLM_ENDPOINT = os.environ.get("LLM_ENDPOINT", "http://localhost:1234/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen/qwen3-coder-next")


def test_llm_connection():
    """Test if we can connect to the LLM endpoint."""
    print("=" * 60)
    print("Testing LLM Endpoint Connection")
    print("=" * 60)
    
    try:
        import requests
        
        # Check if endpoint is reachable
        response = requests.get(f"{LLM_ENDPOINT}/models", timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            models = [m["id"] for m in data.get("data", [])]
            print(f"\n✓ LLM endpoint is reachable")
            print(f"  Available models: {models}")
            
            if LLM_MODEL in models:
                print(f"✓ Target model '{LLM_MODEL}' is available")
            else:
                print(f"⚠ Target model '{LLM_MODEL}' not found. Using first available.")
                LLM_MODEL = models[0]
            
            return True
        else:
            print(f"✗ LLM endpoint returned status {response.status_code}")
            return False
            
    except requests.exceptions.ConnectionError:
        print(f"✗ Failed to connect to LLM endpoint at {LLM_ENDPOINT}")
        print("  Make sure LM Studio is running with the server started.")
        return False
    except Exception as e:
        print(f"✗ Error checking LLM endpoint: {e}")
        return False


def test_chat_completions():
    """Test the chat completions endpoint with a simple message."""
    print("\n" + "=" * 60)
    print("Testing Chat Completions")
    print("=" * 60)
    
    try:
        import requests
        
        payload = {
            "model": LLM_MODEL,
            "messages": [
                {"role": "system", "content": "You are Collaborator, a helpful assistant."},
                {"role": "user", "content": "Say hello in 5 words."}
            ],
            "temperature": 0.7
        }
        
        response = requests.post(f"{LLM_ENDPOINT}/chat/completions", json=payload, timeout=60)
        
        if response.status_code == 200:
            data = response.json()
            
            if "choices" in data and len(data["choices"]) > 0:
                reply = data["choices"][0]["message"]["content"]
                print(f"\n✓ Got response from LLM:")
                print(f"  '{reply}'")
                return True
            else:
                print(f"\n✗ No choices in response")
                print(json.dumps(data, indent=2))
                return False
        else:
            print(f"\n✗ Chat completions returned status {response.status_code}")
            print(response.text)
            return False
            
    except requests.exceptions.ConnectionError:
        print(f"\n✗ Failed to connect to LLM endpoint")
        return False
    except Exception as e:
        print(f"\n✗ Error calling LLM: {e}")
        return False


def test_end_to_end():
    """Test the complete message loop including database persistence."""
    print("\n" + "=" * 60)
    print("Testing End-to-End Message Loop")
    print("=" * 60)
    
    try:
        import requests
        from dotenv import load_dotenv
        load_dotenv()
        
        # Load DB path
        db_path = os.environ.get("DB_PATH", "/home/chat/collaborator/backend/data/conversations.db")
        
        # Ensure directory exists
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        
        import sqlite3
        
        # Initialize database
        db = sqlite3.connect(db_path)
        cursor = db.cursor()
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                context_turns INTEGER NOT NULL DEFAULT 5,
                committed BOOLEAN NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                model_name TEXT,
                token_count INTEGER,
                tags TEXT
            )
        """)
        db.commit()
        print("\n✓ Database initialized")
        
        # Test 1: Send user message
        user_msg = "Test message from integration test"
        print(f"\n→ Sending: '{user_msg}'")
        
        payload = {
            "model": LLM_MODEL,
            "messages": [
                {"role": "system", "content": "You are Collaborator, a helpful assistant."},
                {"role": "user", "content": user_msg}
            ],
            "temperature": 0.7
        }
        
        response = requests.post(f"{LLM_ENDPOINT}/chat/completions", json=payload, timeout=60)
        
        if response.status_code != 200:
            print(f"✗ LLM endpoint error: {response.status_code}")
            db.close()
            return False
        
        llm_response = response.json()["choices"][0]["message"]["content"]
        print(f"← Got: '{llm_response}'")
        
        # Persist turns
        cursor.execute(
            "INSERT INTO turns (user_id, role, content, committed) VALUES (?, ?, ?, 1)",
            ("integration-test", "user", user_msg)
        )
        cursor.execute(
            "INSERT INTO turns (user_id, role, content, committed) VALUES (?, ?, ?, 1)",
            ("integration-test", "assistant", llm_response)
        )
        db.commit()
        
        print(f"✓ Persisted both turns to database")
        
        # Verify
        cursor.execute("SELECT COUNT(*) FROM turns WHERE user_id = ?", ("integration-test",))
        count = cursor.fetchone()[0]
        print(f"✓ Found {count} turns for integration-test user")
        
        # Cleanup
        cursor.execute("DELETE FROM turns WHERE user_id = ?", ("integration-test",))
        db.commit()
        
        db.close()
        
        print("\n✓ End-to-end test completed successfully")
        return True
        
    except Exception as e:
        print(f"\n✗ Error in end-to-end test: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Run all integration tests."""
    results = []
    
    # Test 1: LLM connection
    results.append(("LLM Connection", test_llm_connection()))
    
    # Test 2: Chat completions
    results.append(("Chat Completions", test_chat_completions()))
    
    # Test 3: End-to-end
    results.append(("End-to-End Loop", test_end_to_end()))
    
    # Summary
    print("\n" + "=" * 60)
    print("Test Results Summary")
    print("=" * 60)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for test_name, result in results:
        status = "✓ PASS" if result else "✗ FAIL"
        print(f"{status}: {test_name}")
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    return all(result for _, result in results)


if __name__ == "__main__":
    import sys
    success = main()
    sys.exit(0 if success else 1)
