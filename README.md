# Collaborator (Backend)

A self-hosted personal chat interface backed by local LLM inference.

## Status

**Backend development only. Frontend to be developed separately.**

### Backend
- ✅ FastAPI server with SQLite persistence
- ✅ Local LLM inference via OpenAI-compatible endpoints (e.g., LM Studio)
- ✅ Conversation context management with discard functionality
- ✅ Production-ready deployment script

### Frontend
- 📋 API spec defined in `API-SPEC.md`
- 🚧 To be developed separately by another agent

---

## Backend API

See [API-SPEC.md](API-SPEC.md) for complete endpoint documentation.

### Quick Start

1. Create `config.yaml` based on `config.yaml.example`
2. Run backend: `cd backend && uvicorn main:app --host 0.0.0.0 --port 8001`
3. Deploy using `./deploy.sh`

### Configuration

See [DEPLOY.md](DEPLOY.md) for deployment instructions.

---

## Project Structure

```
collaborator/
├── backend/               # FastAPI server
│   ├── main.py           # API endpoints
│   ├── config.py         # YAML configuration loader
│   ├── db.py             # SQLite database operations
│   └── inference.py      # LLM inference proxy
├── API-SPEC.md           # Frontend API specification
└── deploy.sh             # Production deployment script
```

---

## Development

Backend is written in Python with FastAPI. No frontend build tools required.

### Prerequisites
- Python 3.10+
- SQLite 3.37+

---

## License

MIT License (see LICENSE file)
