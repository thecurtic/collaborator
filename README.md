# Collaborator

A self-hosted personal chat interface backed by local LLM inference.

## Project Status

**Current Phase:** Planning and Architecture

- [x] Updated AGENTS.md with new architecture
- [x] Updated README.md with monorepo structure
- [ ] Define SQLite schema for conversation turns
- [ ] Set up backend project structure with minimal FastAPI app
- [ ] Wire single endpoint for user message → inference → persist flow
- [ ] Implement memory model with discard capability

See the [Contributing](#contributing) section for how to help.

## Architecture

This is a monorepo with two runtime contexts:

- **backend/** — runs on this VM. Manages SQLite conversation persistence, context assembly, and proxies inference to the local LLM endpoint. Exposes a simple HTTP API.
- **frontend/** — served from a separate machine on the tailnet. Web UI for sending messages, viewing responses, editing or discarding turns before they commit to memory.

They are loosely coupled. The frontend talks to the backend over HTTP. Either side can be swapped without breaking the other.

## Development

### Prerequisites
- Node.js >= 20 (for frontend)
- Python >= 3.10 (for backend with FastAPI)
- Local LLM inference endpoint (same as Pi: `qwen/qwen3-coder-next` via LM Studio at `http://<inference-host>:1234/v1`)

### Setup

```bash
# Install dependencies
npm install

# Run development server (frontend)
npm run dev

# Backend (in backend/ directory)
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Testing

```bash
npm test
npm run test:watch
npm run test:coverage
```

### Backend Testing

```bash
cd backend
pytest
```

### Build

```bash
npm run build
```

## Deployment

This project is designed for self-hosted deployment. The web UI is served from a separate machine on the local network.

### Deployment Steps

1. **Backend** — Deploy to this VM:
   - Set up Python environment with FastAPI dependencies
   - Configure `LLM_ENDPOINT` and other environment variables
   - Run the FastAPI server (e.g., with `uvicorn` or `gunicorn`)

2. **Frontend** — Deploy to the tailnet machine:
   - Run `npm run build`
   - Serve the `out/` directory with a static file server (e.g., nginx, Caddy)
   - Configure the frontend to point to your backend's tailnet IP

3. **Configuration**:
   - Backend: `LLM_ENDPOINT`, `DB_PATH`, `PORT`
   - Frontend: `BACKEND_URL` (tailnet IP of this VM)

## Project Structure

```
.
├── backend/                # Python FastAPI server
│   ├── main.py            # Entry point
│   ├── db.py              # SQLite database operations
│   ├── inference.py       # LLM inference proxy
│   └── requirements.txt
├── frontend/              # Next.js web UI
│   ├── src/
│   │   ├── components/    # Reusable UI components
│   │   ├── pages/         # Page components (Next.js)
│   │   ├── services/      # API client code
│   │   └── utils/         # Utility functions
│   ├── public/            # Static assets
│   └── next.config.js
├── docs/                  # Design documents and specs
└── tests/                 # Integration and e2e tests
```

## Principles

- **Minimal dependencies** - Only include what's necessary
- **Privacy-first** - No external services unless explicitly requested
- **Self-hosted everything** - Full control over infrastructure
- **Local inference only** - All LLM calls go to your local endpoint

## License

MIT

## Contributing

This is a personal, self-hosted project. We welcome contributions that align with the principles above.

### Development Workflow

1. **Create a feature branch** from `main`
   ```bash
   git checkout -b feature/your-feature-name main
   ```

2. **Make your changes** following the project structure

3. **Run tests**
   ```bash
   npm test
   npm run lint
   cd backend && pytest
   ```

4. **Commit with a descriptive message**
   ```bash
   git commit -m "feat: add description of change"
   ```

5. **Push and create a pull request**

### For Backend Development

See `backend/README.md` for Python-specific development instructions (to be created).

### For Frontend Development

See `frontend/README.md` for Next.js-specific development instructions (to be created).
