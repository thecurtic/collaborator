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
├── db.py              # SQLite database operations
├── inference.py       # LLM inference proxy
├── models.py          # Pydantic models for API requests/responses
├── requirements.txt   # Python dependencies
└── .env.example       # Environment variable template
```

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

## Configuration

See `.env.example` for environment variables.
