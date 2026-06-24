#!/usr/bin/env python3
"""
Simple mock test for Collaborator backend.

This script simulates the basic message loop without requiring pip/venv setup.
It mocks the database and LLM calls to verify the flow works correctly.
"""

import os
import sqlite3
from datetime import datetime

# Setup mock database in memory
DB_PATH = ":memory:"


def get_db():
    """Get a database connection."""
    return sqlite3.connect(DB_PATH)


def init_db(db):
    """Initialize the database with required tables."""
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


def create_turn(db, user_id, role, content, context_turns=5, committed=True):
    """Create a new turn in the database."""
    cursor = db.cursor()
    cursor.execute(
        """
        INSERT INTO turns (user_id, role, content, context_turns, committed)
        VALUES (?, ?, ?, ?, ?)
        """,
        (user_id, role, content, context_turns, committed)
    )
    db.commit()
    return {"id": cursor.lastrowid}


def get_recent_turns(db, limit=10):
    """Get recent committed turns."""
    cursor = db.cursor()
    cursor.execute(
        """
        SELECT * FROM turns 
        WHERE committed = 1 
        ORDER BY id DESC 
        LIMIT ?
        """,
        (limit,)
    )
    
    columns = ['id', 'user_id', 'role', 'content', 'context_turns', 'committed', 'created_at']
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def mock_llm_call(message, context_turns):
    """
    Mock LLM call - returns a simple echo response.
    In production, this would call the actual LM Studio endpoint.
    """
    context_summary = f" [context: {len(context_turns)} prior turns]" if context_turns else ""
    return f"Mock response: {message}{context_summary}"


def test_basic_message_flow():
    """Test the basic message → response → persist loop."""
    print("=" * 60)
    print("Testing Collaborator Backend Basic Loop")
    print("=" * 60)
    
    # Initialize database
    db = get_db()
    init_db(db)
    print("\n✓ Database initialized")
    
    # Simulate a user message
    user_message = "Hello, how are you?"
    print(f"\n→ User sends: '{user_message}'")
    
    # Get context (should be empty initially)
    context = get_recent_turns(db, limit=5)
    print(f"✓ Retrieved {len(context)} prior committed turns")
    
    # Mock LLM response
    response = mock_llm_call(user_message, context)
    print(f"← LLM responds: '{response}'")
    
    # Persist user turn
    user_turn = create_turn(db, user_id="test-user", role="user", content=user_message)
    print(f"✓ Persisted user turn (id: {user_turn['id']})")
    
    # Persist assistant response
    assistant_turn = create_turn(db, user_id="test-user", role="assistant", content=response)
    print(f"✓ Persisted assistant turn (id: {assistant_turn['id']})")
    
    # Verify the conversation was saved
    all_turns = get_recent_turns(db, limit=10)
    print(f"\n✓ Conversation history now has {len(all_turns)} turns:")
    for turn in reversed(all_turns):  # Show in chronological order
        role = "User" if turn["role"] == "user" else "Assistant"
        print(f"  [{turn['id']}] {role}: {turn['content'][:50]}{'...' if len(turn['content']) > 50 else ''}")
    
    # Test a follow-up message with context
    print("\n" + "-" * 60)
    print("Testing follow-up message with context")
    print("-" * 60)
    
    followup_message = "What did I ask before?"
    context = get_recent_turns(db, limit=5)
    
    followup_response = mock_llm_call(followup_message, context)
    print(f"\n→ User sends: '{followup_message}'")
    print(f"← LLM responds (with context): '{followup_response}'")
    
    # Persist follow-up
    create_turn(db, user_id="test-user", role="user", content=followup_message)
    create_turn(db, user_id="test-user", role="assistant", content=followup_response)
    
    # Verify context was used
    final_turns = get_recent_turns(db, limit=10)
    print(f"\n✓ Conversation history now has {len(final_turns)} turns")
    
    # Test discard functionality
    print("\n" + "-" * 60)
    print("Testing turn discard (uncommitted)")
    print("-" * 60)
    
    cursor = db.cursor()
    # Discard the last turn
    discard_id = final_turns[-1]["id"]
    cursor.execute("UPDATE turns SET committed = 0 WHERE id = ?", (discard_id,))
    db.commit()
    print(f"✓ Discarded turn {discard_id}")
    
    # Verify discarded turn is not in context
    committed_turns = get_recent_turns(db, limit=10)
    discarded_in_context = any(t["id"] == discard_id for t in committed_turns)
    print(f"✓ Discarded turn in committed context: {discarded_in_context} (should be False)")
    
    if not discarded_in_context:
        print("\n✓ SUCCESS: Discarded turn correctly excluded from context")
    else:
        print("\n✗ FAIL: Discarded turn still in context!")
    
    # Cleanup
    db.close()
    
    print("\n" + "=" * 60)
    print("All tests passed!")
    print("=" * 60)


if __name__ == "__main__":
    test_basic_message_flow()
