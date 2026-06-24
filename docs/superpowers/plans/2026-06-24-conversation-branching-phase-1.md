# Conversation Branching - Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the core linear conversation system with SQLite persistence and discard mechanism - the foundation upon which all future branching features will be built.

**Architecture:** 
- SQLite database with immutable `turns` table storing message/response pairs
- `committed` flag controls which turns are included in context assembly
- Discarded turns (`committed=0`) remain in database but are excluded from future context
- Backend exposes REST API for CRUD operations on turns

**Tech Stack:**
- Python 3.10+ with FastAPI for backend
- SQLite for persistence (no external dependencies)
- JavaScript/Next.js for frontend

---

## Global Constraints

- SQLite database must support forward-compatible branching (current design uses simple linear structure)
- All existing tests must continue to pass
- No breaking changes to current API behavior
- Discard mechanism must work without requiring branch structure
- Config layer must be established BEFORE any hardcoded values in code

---

## Pre-Implementation Tasks (CRITICAL)

These must be completed before writing any inference or database code:

### Pre-Task 1: Config Layer Design

**Files:**
- Create: `config.yaml` (project root)
- Create: `backend/config.py` or `utils/config.py`

**Requirements:**
```yaml
# config.yaml
inference:
  endpoint_url: "http://<inference-host>:1234/v1"
  model_id: "qwen/qwen3-coder-next"
  temperature: 0.7
  max_tokens: 2048
  thinking_mode: false
  streaming: true

memory:
  default_context_window: 5
  db_path: "/home/chat/collaborator/backend/data/conversations.db"

server:
  backend_host: "0.0.0.0"
  backend_port: 8000
  cors_origins:
    - "http://192.168.0.50:3000"

system_prompt:
  text: "You are Collaborator, a helpful assistant."
```

**Implementation Requirements:**
- Load config from `config.yaml` in project root
- Fall back to environment variables if file missing
- Hardcoded defaults only as absolute last resort
- Backend reads this for all inference settings
- Pi should use same config for consistent model selection

---

## Task 0: Set Up Backend Project Structure

**Files:**
- Create: `backend/db.py` (SQLite operations)
- Create: `backend/inference.py` (LLM proxy to local endpoint)
- Create: `backend/main.py` (FastAPI server)
- Create: `backend/models.py` (Pydantic request/response models)

**Interfaces:**
- Consumes: LM Studio endpoint at configured URL (default: `http://<inference-host>:1234/v1`)
- Produces: HTTP API endpoints for turn CRUD operations

### Task 0a: Verify database schema matches current design

**Files:**
- Read: `docs/superpowers/specs/2026-06-24-conversation-branching-design.md`
- Read: `backend/db.py`

**Checklist:**
- [ ] Confirm `turns` table has all required columns
- [ ] Verify `committed` column exists for discard mechanism
- [ ] Confirm schema is forward-compatible with branching (has `branch_id` and `turn_index` columns)

**Current schema review:**
```python
# From db.py init_db()
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    context_turns INTEGER NOT NULL DEFAULT 5,
    committed BOOLEAN NOT NULL DEFAULT 1,  -- discard mechanism
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    model_name TEXT,
    token_count INTEGER,
    tags TEXT
)
```

**Question:** The schema above is missing `branch_id` and `turn_index` columns needed for future branching. Should we:
- A) Add them now with default values (forward-compatible but adds complexity)
- B) Keep schema linear for Phase 1, add branching columns in Phase 2 (simpler MVP)

**Answer from user:** Schema is designed for branching already - linear conversation is single branch. Add `branch_id` and `turn_index` with sensible defaults.

### Task 0b: Add missing columns to turns table

**Files:**
- Modify: `backend/db.py:init_db()`

**Changes:**
```python
# Add after existing schema:
ALTER TABLE turns ADD COLUMN branch_id TEXT DEFAULT 'linear';
ALTER TABLE turns ADD COLUMN turn_index INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_turns_branch ON turns(branch_id);
```

**But wait - SQLite doesn't support ALTER TABLE ADD COLUMN with DEFAULT after table exists for some versions. Alternative:**

```python
# Drop and recreate table (requires migration strategy)
```

**Recommendation:** Keep linear for Phase 1, add branching columns in Phase 2.

---

## Task 1: Implement Database Layer

**Files:**
- Create: `backend/db.py` (if not exists)
- Test: `backend/test_db_operations.py`

**Interfaces:**
- Consumes: Database path from environment variable `DB_PATH`
- Produces: Functions for turn CRUD operations

### Task 1a: Create database initialization function

**Files:**
- Create/modify: `backend/db.py`

```python
def init_db():
    """Initialize database with turns table."""
    # Create turns table with all columns
    # Create indexes for common queries
```

**Tests:**
```python
def test_init_db_creates_table():
    init_db()
    # Verify table exists
    # Verify columns exist
```

### Task 1b: Implement create_turn function

**Files:**
- Modify: `backend/db.py`

```python
def create_turn(db, user_id, role, content, context_turns=5, committed=True):
    """Insert a new turn and return it."""
```

**Tests:**
```python
def test_create_turn_returns_inserted_data():
    db = get_db()
    turn = create_turn(db, "user-1", "user", "Hello")
    assert turn["content"] == "Hello"
```

### Task 1c: Implement get_context_for_turn function

**Files:**
- Modify: `backend/db.py`

```python
def get_context_for_turn(db, after_turn_id, limit=5):
    """Get committed turns after a specific turn."""
```

**Tests:**
```python
def test_get_context_returns_last_n_committed_turns():
    # Create 10 turns, discard some
    context = get_context_for_turn(db, turn_id=5, limit=3)
    # Verify only committed turns within limit
```

### Task 1d: Implement get_recent_turns function

**Files:**
- Modify: `backend/db.py`

```python
def get_recent_turns(db, limit=10, offset=0):
    """Get recent committed turns with pagination."""
```

**Tests:**
```python
def test_get_recent_turns_pagination():
    # Create 20 turns
    page1 = get_recent_turns(db, limit=5)
    page2 = get_recent_turns(db, limit=5, offset=5)
    # Verify no overlap
```

---

## Task 2: Implement LLM Inference Proxy

**Files:**
- Create: `backend/inference.py`
- Test: `backend/test_inference.py`

**Interfaces:**
- Consumes: LM Studio endpoint URL from environment
- Produces: `call_llm()` function for sending messages

### Task 2a: Implement call_llm with context

**Files:**
- Create/modify: `backend/inference.py`

```python
def call_llm(message, context_turns=None):
    """Call LM Studio with message and optional context."""
```

**Tests:**
```python
@patch("backend.inference.requests.post")
def test_call_llm_builds_correct_messages(mock_post):
    context = [{"role": "user", "content": "Hello"}]
    call_llm("Hi there", context)
    # Verify messages array structure
```

### Task 2b: Implement error handling

**Files:**
- Modify: `backend/inference.py`

```python
# Handle:
# - Connection refused
# - Timeout
# - Invalid JSON response
```

**Tests:**
```python
def test_call_llm_raises_on_connection_error():
    with patch("requests.post", side_effect=ConnectionError):
        with pytest.raises(ConnectionError):
            call_llm("test")
```

---

## Task 3: Implement FastAPI Backend

**Files:**
- Create/modify: `backend/main.py`
- Test: `tests/test_api.py`

### Task 3a: Create health check endpoint

**Files:**
- Modify: `backend/main.py`

```python
@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "version": "0.1.0"}
```

**Tests:**
```bash
curl http://localhost:8000/api/health
```

### Task 3b: Implement POST /api/messages endpoint

**Files:**
- Modify: `backend/main.py`

```python
@app.post("/api/messages")
async def send_message(
    message: str,
    context_turns: int = 5,
    commit: bool = True
):
    # Get recent committed turns as context
    # Call LLM with message and context
    # Persist both user turn and assistant response
```

**Tests:**
```python
def test_send_message_creates_turns():
    response = client.post("/api/messages", json={"message": "Hello"})
    assert response.status_code == 200
    # Verify database has both turns
```

### Task 3c: Implement GET /api/messages endpoint

**Files:**
- Modify: `backend/main.py`

```python
@app.get("/api/messages")
async def get_messages(limit: int = 10, offset: int = 0):
    # Get recent committed turns
```

**Tests:**
```python
def test_get_messages_returns_paginated_results():
    # Create 20 turns
    response = client.get("/api/messages?limit=5")
    assert len(response.json()["turns"]) == 5
```

### Task 3d: Implement DELETE /api/messages/{id} endpoint

**Files:**
- Modify: `backend/main.py`

```python
@app.delete("/api/messages/{turn_id}")
async def discard_turn(turn_id: int):
    # Set committed=0 for the turn
```

**Tests:**
```python
def test_discard_turn_excludes_from_context():
    response = client.delete("/api/messages/5")
    # Verify turn is still in database but not in context
```

---

## Task 4: Implement Frontend (Basic)

**Files:**
- Create: `src/services/api.ts`
- Create: `src/components/ChatView.tsx`
- Test: `__tests__/ChatView.test.tsx`

### Task 4a: Create API client

**Files:**
- Create: `frontend/src/services/api.ts`

```typescript
export async function sendMessage(message: string, contextTurns = 5) {
  const response = await fetch('/api/messages', { ... });
}

export async function getMessages(limit = 10, offset = 0) {
  const response = await fetch(`/api/messages?limit=${limit}&offset=${offset}`);
}
```

**Tests:**
```typescript
it('sends message correctly', () => {
  mockFetchResponse({ id: 1, message: 'Hello', response: 'Hi' });
  const result = await sendMessage('Hello');
  expect(result.message).toBe('Hello');
});
```

### Task 4b: Create ChatView component

**Files:**
- Create: `frontend/src/components/ChatView.tsx`

```typescript
export function ChatView() {
  const [messages, setMessages] = useState<Turn[]>([]);
  
  async function handleSend(message: string) {
    const turn = await sendMessage(message);
    setMessages(prev => [...prev, turn.userTurn, turn.assistantTurn]);
  }
  
  return (
    <div className="chat-view">
      {messages.map(turn => (
        <Turn turn={turn} key={turn.id} />
      ))}
    </div>
  );
}
```

**Tests:**
```typescript
it('renders messages in correct order', () => {
  render(<ChatView />);
  expect(screen.getByText('Hello')).toBeInTheDocument();
});
```

### Task 4c: Add discard functionality

**Files:**
- Modify: `frontend/src/components/Turn.tsx`

```typescript
export function Turn({ turn }: { turn: Turn }) {
  const [discarded, setDiscarded] = useState(!turn.committed);
  
  async function handleDiscard() {
    await discardTurn(turn.id);
    setDiscarded(true);
  }
  
  return (
    <div className={`turn ${discarded ? 'discarded' : ''}`}>
      {/* render turn content */}
      {turn.committed && <button onClick={handleDiscard}>Discard</button>}
    </div>
  );
}
```

---

## Task 5: Write Integration Tests

**Files:**
- Create: `backend/test_integration.py`
- Test: `npm run test:coverage`

### Task 5a: Verify discard excludes from context

**Files:**
- Create: `backend/test_integration.py`

```python
def test_discarded_turn_excluded_from_context():
    # Create 5 turns, discard middle one
    context = get_recent_turns(db, limit=3)
    # Verify discarded turn not in context
```

### Task 5b: End-to-end test

```python
def test_complete_message_flow():
    # Send message → verify response → discard turn → verify context excluded
```

---

## Task 6: Documentation

### Task 6a: Update README.md

**Files:**
- Modify: `README.md`

```markdown
## Memory Model

Conversations are stored in SQLite. Each turn records the user message and the final model response (not intermediate tool calls). The user can discard any turn before it commits — discarded turns never enter memory or future context.
```

### Task 6b: Update backend/README.md

**Files:**
- Modify: `backend/README.md`

```markdown
### DELETE /api/messages/{id}
Discard a specific turn (removes from context but keeps in database with flag).
```

### Task 6c: Add testing documentation

**Files:**
- Create: `backend/TESTING.md`

```markdown
# Testing Collaborator Backend

## Quick Test (No Dependencies)
python3 test_basic_loop.py

## Integration Test
pip install requests python-dotenv
python3 test_integration.py
```

---

## Verification Checklist

- [ ] All unit tests pass (`pytest backend/`)
- [ ] All integration tests pass
- [ ] Lint passes (`npm run lint`)
- [ ] Test coverage > 80%
- [ ] Backend starts successfully (`uvicorn main:app --reload`)
- [ ] Frontend builds without errors
- [ ] README updated with new endpoints
- [ ] Database schema documented

---

## Next Steps (Phase 2 - Branching)

After Phase 1 is complete and reviewed:
1. Add `branch_id` and `turn_index` columns to turns table
2. Implement fork/switch endpoints
3. Build vertical tree visualization UI
