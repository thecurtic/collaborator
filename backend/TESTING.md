# Collaborator Backend - Testing

## Quick Test (No Dependencies)

Run the mock test that simulates the backend without external dependencies:

```bash
cd backend
python3 test_basic_loop.py
```

This tests:
- Database initialization and queries
- Turn creation and retrieval
- Discard/uncommitted functionality
- Context assembly logic

## Integration Test (Requires LLM Endpoint)

Run the integration test that connects to the actual LM Studio endpoint:

```bash
# First, ensure you have requests installed
pip install --break-system-packages requests python-dotenv

# Run the integration test
cd backend
python3 test_integration.py
```

This tests:
- LLM endpoint connectivity
- Chat completions API
- End-to-end message flow with database persistence

## Running the Actual FastAPI Server

Once dependencies are installed:

```bash
cd backend
pip install --break-system-packages -r requirements.txt

# Start the server
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Then test with curl:

```bash
# Health check
curl http://localhost:8000/api/health

# Send a message
curl -X POST http://localhost:8000/api/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "context_turns": 5}'

# Get conversation history
curl http://localhost:8000/api/messages?limit=10

# Discard a turn (replace {id} with actual turn ID)
curl -X DELETE http://localhost:8000/api/messages/{id}
```

## Prerequisites

1. **LM Studio** running with local model loaded
2. **LLM endpoint** accessible at configured URL (default: `http://<inference-host>:1234/v1`)
3. **Python** >= 3.10
4. **pip** for installing Python packages

## Database Location

Default: `/home/chat/collaborator/backend/data/conversations.db`

You can override with `DB_PATH` environment variable.
