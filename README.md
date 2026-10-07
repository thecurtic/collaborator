# Collaborator

A self-sovereign personal AI hub. One place for your own AI, running on local
inference over your own chats, notes, people, events and transcripts. Nothing
leaves your machines unless you send it.

- **Chat** with a local model (any OpenAI-compatible endpoint, e.g. LM Studio),
  with tool use: web search, page fetch, YouTube transcription, calendar,
  notes, Lightning payments.
- **Memory you can see and edit.** Conversations are trees you can branch;
  recall is a visible block you can correct; ideas worth keeping become
  atomic markdown notes in a plain vault (Obsidian-compatible).
- **Voice**: calls with streaming transcription and spoken replies, on-device
  or on your server.
- **Scratch**: a cross-device inbox for links, photos and files.
- **Mobile-first PWA** plus a thin Android shell.

## Layout

```
backend/     FastAPI server: SQLite persistence, notes vault + index, tools, voice
frontend/    Vite + React PWA, Capacitor Android shell
deploy/      systemd unit and reverse-proxy example
docs/        known issues and design notes
*.md         design documents and the prompt files the backend loads
```

The prompt files at the root (`system-prompt.md`, `tools-spec.md`, …) are
loaded by the backend at runtime and are meant to be edited.

## Quick start

Backend:

```bash
cp config.yaml.example config.yaml      # edit inference.endpoint_url at least
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cd backend && ../backend/.venv/bin/uvicorn main:app --port 8001
```

Frontend (in a second terminal):

```bash
cd frontend
npm install
npm run dev                             # http://localhost:3000, proxies /api to :8001
```

Authentication is off by default. To turn it on, set `authentication.enabled`
in `config.yaml` and create a passkey:

```bash
cd backend && ../backend/.venv/bin/python data/passkey.py create
```

See [DEPLOY.md](DEPLOY.md) for a server install and [frontend/DEV.md](frontend/DEV.md)
for the frontend dev loop, PWA testing and the Android shell.

## Design documents

- [INTENTS.md](INTENTS.md): philosophy and architecture decisions.
- [Collaborator UX Redesign — Intentions](Collaborator%20UX%20Redesign%20%E2%80%94%20Intentions.md): where it is going.
- [NOTES-FORMAT.md](NOTES-FORMAT.md): the on-disk note format.
- [API-SPEC.md](API-SPEC.md): the REST and WebSocket contract.
- [docs/known-issues.md](docs/known-issues.md): bugs and the optimization backlog.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agents working in this repo follow
[AGENTS.md](AGENTS.md).

## License

MIT, see [LICENSE](LICENSE).
