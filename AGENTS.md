## Project Context

**Never use subagents.** Do all work directly in the main session.

Collaborator is a self-hosted personal AI hub backed by local LLM inference.
This is a monorepo: `backend/` (Python, FastAPI, SQLite, markdown notes vault)
and `frontend/` (Vite + React PWA with a Capacitor Android shell). They talk
over the HTTP and WebSocket API documented in `API-SPEC.md`.

## Principles

- Minimal dependencies.
- Privacy-first: no external service unless the user explicitly configures it.
- Self-hosted everything; local inference by default.
- Nothing personal in the repository: no hostnames, IPs, names or credentials.
  Use placeholders like `<inference-host>` in examples. Real values live only
  in the gitignored `config.yaml`.

## Layout

```
backend/            FastAPI app (main.py), db.py, notes_index.py, tools, voice, auth
backend/test_*.py   pytest suite
frontend/src/       React app; frontend/android/ the Capacitor shell
deploy/             systemd unit, reverse-proxy example
docs/               known issues, design notes
*.md at the root    design docs + prompt files the backend loads at runtime
config.yaml         machine-local, gitignored; config.yaml.example is the template
```

## Workflow

1. Make the change.
2. Test it:
   ```bash
   backend/.venv/bin/python -m pytest backend -q        # backend
   cd frontend && npm run typecheck && npm run build && npm test   # frontend
   ```
3. Housekeeping (same commit):
   - New or changed endpoint or schema: update `API-SPEC.md`.
   - New config option: add it to `config.yaml.example` with a comment and a
     default in `backend/config.py`.
   - Note format change: update `NOTES-FORMAT.md`.
   - Design decision: record it in `INTENTS.md` or the UX intentions doc.
4. Commit with a conventional prefix (`feat:`, `fix:`, `docs:`, `refactor:`).
5. Deploy on the server with `./deploy.sh` (see `DEPLOY.md`).

## Inference

All inference goes to the OpenAI-compatible endpoint in `config.yaml`
(`inference.endpoint_url`). Tests never call a live model.

## Memory model

Conversations are trees of turns in SQLite. A turn records the user message
and the final model response. Discarded turns never enter future context.
Context for a new turn is the active branch (root to current turn) plus the
recall block. Ideas worth keeping become atomic notes (`NOTES-FORMAT.md`),
always through a draft the user approves; the model never writes to the vault
directly.

## Authentication

Passkeys (Argon2id-hashed) map to a stable identity hash that names the
user's data directory. Clients hold a session token, never the passkey.
`backend/data/passkey.py` manages passkeys (`create`, `rotate`, `revoke`,
`list`).
