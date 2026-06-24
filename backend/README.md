# Collaborator Backend

Python FastAPI server for SQLite persistence and LLM inference proxying.

## Development

### Prerequisites
- Python >= 3.10
- Local LLM inference endpoint (same as Pi: `qwen/qwen3-coder-next` via LM Studio)

### Setup

```bash
# Install dependencies
cd backend
pip install -r requirements.txt

# Create environment file (copy from .env.example)
cp .env.example .env
# Edit .env with your configuration

# Run development server
uvicorn main:app --reload
```

### Testing

```bash
cd backend
pytest
```

## Project Structure

```
backend/
├── main.py            # FastAPI entry point, routes
│   ├── /api/messages           # Send and retrieve messages
│   ├── /api/branches/{id}/fork # Fork from a specific turn
│   ├── /api/branches/active    # Get current active branch path
│   └── /api/synthesis          # Combine insights from multiple branches
├── db.py              # SQLite database operations (with tree support)
├── inference.py       # LLM inference proxy
├── models.py          # Pydantic models for API requests/responses
├── requirements.txt   # Python dependencies
└── .env.example       # Environment variable template
```

## Conversation Branching

Conversations form a tree structure where:
- Each turn can have multiple children (branches)
- There's an active branch path from root to current position
- Users can fork at any point to explore alternatives
- When exhausted, users return to the fork and try another branch
- Synthesis turns combine insights from multiple branches

## API Endpoints

### POST /api/messages
Send a user message and get the model response.

**Request Body:**
```json
{
  "message": "Your message here",
  "contextTurns": 5,
  "commit": true
}
```

**Response:**
```json
{
  "id": 123,
  "userId": "user-1",
  "message": "Your message here",
  "response": "The model's response",
  "turnsAgo": 0,
  "committed": true
}
```

### GET /api/messages?limit=10&offset=0
Retrieve conversation history.

### DELETE /api/messages/{id}
Discard a specific turn (removes from context but keeps in database with flag).

### POST /api/branches/{turnId}/fork
Fork from a specific turn to create a new branch.

**Request Body:**
```json
{
  "message": "Starting new branch from turn {turnId}",
  "contextTurns": 5
}
```

**Response:**
```json
{
  "forkedFromTurnId": 5,
  "newBranchRootId": 124,
  "message": "Starting new branch from turn {turnId}",
  "response": "The model's response",
  "committed": true
}
```

### GET /api/branches/active
Get the current active branch path (list of turn IDs from root to current).

**Response:**
```json
{
  "branchPath": [1, 2, 5, 8],
  "currentTurnId": 8
}
```

### POST /api/branches/{branchId}/activate
Switch to a different branch.

**Request Body:**
```json
{
  "branchId": 3
}
```

### POST /api/synthesis
Initiate a synthesis turn that draws from multiple branches.

**Request Body:**
```json
{
  "branchIds": [2, 5, 8],
  "synthesisPrompt": "Combine insights from these branches into a coherent summary"
}
```

**Response:**
```json
{
  "synthesisTurnId": 15,
  "summary": "Based on branches 2, 5, and 8, the synthesized insight is...",
  "sources": [
    {"branchId": 2, "turnId": 7},
    {"branchId": 5, "turnId": 12},
    {"branchId": 8, "turnId": 14}
  ]
}
```

## Configuration

See `.env.example` for environment variables.
