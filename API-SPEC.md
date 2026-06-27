# Collaborator Backend API Specification

## Overview
Self-hosted personal chat interface backed by local LLM inference. This document defines the REST API endpoints for backend development.

## Authentication (Passkey System)

### Overview
Collaborator uses a passkey system for user database isolation. Each passkey maps to a unique user conversation database.

### Passkey Management (CLI)
Admin generates and manages passkeys via CLI:
```bash
# Generate new passkey
python -m backend.data.passkey generate

# List all passkeys
python -m backend.data.passkey list

# Revoke a passkey
python -m backend.data.passkey revoke <passkey_hash>
```

### Passkey Header
All API requests require the `X-Passkey` header (when authentication is enabled):
```
X-Passkey: <your-passkey-here>
```

### Response (403 Forbidden) - Missing/Invalid Passkey
```json
{
  "detail": "Passkey required"
}
```

---

## Base URL
- Development: `http://localhost:8001`
- Production: Configured via `config.yaml`

---

## Endpoints

### 1. Health Check
```
GET /api/health
```

**Response (200 OK)**
```json
{
  "status": "healthy",
  "version": "0.1.0"
}
```

---

### 2. Send Message
```
POST /api/messages
Content-Type: application/json
X-Passkey: <your-passkey>
```

**Request Body**
```json
{
  "message": "string",
  "context_turns": 5,
  "commit": true,
  "user_id": "optional-string"
}
```

**Fields:**
- `message` (required): User's input text
- `context_turns` (optional, default: 5): Number of prior committed turns to include
- `commit` (optional, default: true): Whether to persist this turn to database
- `user_id` (optional): User identifier

**Response (201 Created)**
```json
{
  "id": 42,
  "user_id": null,
  "message": "Hello",
  "response": "Hi there! How can I help?",
  "committed": true
}
```

---

### 3. Get Messages
```
GET /api/messages?limit=10&offset=0
X-Passkey: <your-passkey>
```

**Query Parameters:**
- `limit` (optional, default: 10): Number of turns to return
- `offset` (optional, default: 0): Pagination offset

**Response (200 OK)**
```json
{
  "turns": [
    {
      "id": 1,
      "user_id": null,
      "role": "user",
      "message": "Hello",
      "response": "Hi there!",
      "committed": true,
      "context_turns": 5,
      "created_at": "2024-01-01T00:00:00Z",
      "model_name": "qwen/qwen3-coder-next",
      "token_count": 25,
      "tags": null
    },
    {
      "id": 2,
      "user_id": null,
      "role": "assistant",
      "message": "",
      "response": "Hi there! How can I help?",
      "committed": true,
      "context_turns": 5,
      "created_at": "2024-01-01T00:00:01Z",
      "model_name": "qwen/qwen3-coder-next",
      "token_count": 12,
      "tags": null
    }
  ],
  "count": 2
}
```

---

### 4. Discard Turn (Remove from Context)
```
DELETE /api/messages/{turn_id}
X-Passkey: <your-passkey>
```

**Path Parameters:**
- `turn_id` (required): ID of the turn to discard

**Response (200 OK)**
```json
{
  "id": 1,
  "committed": false
}
```

---

## Data Models

### Turn
```typescript
interface Turn {
  id: number;
  user_id?: string | null;
  role: 'user' | 'assistant';
  message: string;        // For user: input text, for assistant: empty
  response: string;       // For user: empty, for assistant: model output
  committed: boolean;
  context_turns: number;
  created_at: string;     // ISO 8601 format
  model_name?: string | null;
  token_count?: number | null;
  tags?: string | null;
}
```

---

## Error Handling

All errors return JSON with appropriate HTTP status code:

```json
{
  "detail": "Error message describing what went wrong"
}
```

| Status Code | Description |
|-------------|-------------|
| 200 | Success (GET) / OK (DELETE) |
| 201 | Created (POST) |
| 403 | Forbidden - Missing or invalid passkey |
| 404 | Not Found - Resource doesn't exist |
| 500 | Internal Server Error |

---

## Request Flow

1. **Client sends message** → POST `/api/messages` with `X-Passkey` header
2. **Backend validates passkey** (if auth enabled)
3. **Backend processes:**
   - Retrieves recent committed turns for context
   - Calls LLM with prompt + context
   - Saves user turn to database
   - Saves assistant response to database
4. **Returns response** → JSON with new turn ID and response text

---

## Configuration (config.yaml)

```yaml
# Enable passkey authentication
authentication:
  enabled: false
  passkeys_db_path: "/home/chat/collaborator/backend/data/authentication/passkeys.db"
  users_dir: "/home/chat/collaborator/backend/data/users"

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
  backend_port: 8001
  cors_origins:
    - "http://localhost:3000"
    - "https://your-domain.com"

system_prompt:
  text: "You are Collaborator, a helpful assistant."
```

---

## Notes for Frontend Developers

1. **Passkey Requirement**: All endpoints require `X-Passkey` header when authentication is enabled
2. **Database Isolation**: Each passkey has its own conversation database - no cross-user visibility
3. **Initial Setup**:
   - Admin generates passkey via CLI: `python -m backend.data.passkey generate`
   - Share passkey with user via secure channel
4. **Error Handling**:
   - 403 Forbidden = missing or invalid passkey
   - Always include `X-Passkey` header on all requests
5. ** revocation**: Admin can revoke passkeys via CLI, invalidating all devices using that key
