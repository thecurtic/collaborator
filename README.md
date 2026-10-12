# Collaborator

A self-sovereign personal AI hub. One place for your own AI, running on local
inference over your own chats, notes, people, events and transcripts. Nothing
leaves your machines unless you send it.

- **Chat** with a local model (any OpenAI-compatible endpoint, e.g. LM Studio),
  with tool use: web search, page fetch and screenshots, YouTube
  transcription, calendar, notes, read-only access to a Gitea or GitHub repo,
  Lightning payments. Every tool is opt-in through `config.yaml`.
- **Memory you can see.** Conversations are trees you can branch; recall
  (off by default) shows the remembered context as a visible block above the
  reply; ideas worth keeping become atomic markdown notes in a plain vault
  (Obsidian-compatible), always through a draft you approve.
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

The prompt files at the root (`system-prompt.md`, `tools-spec.md`, the
synthesis and style prompts) are read by the backend at runtime, most of them
fresh on every turn, and are meant to be edited. `config.yaml` names which
file plays which role.

## Quick start

Backend:

```bash
cp config.yaml.example config.yaml      # edit inference.endpoint_url at least
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cd backend && .venv/bin/uvicorn main:app --port 8001
```

Frontend (in a second terminal):

```bash
cd frontend
npm install
npm run dev                             # http://localhost:3000, proxies /api to :8001
```

Authentication is on by default, so create a passkey before the first login
(it prints once; the identity hash it also prints names your data directory):

```bash
cd backend && .venv/bin/python data/passkey.py create
```

For a throwaway local setup you can instead set `authentication.enabled: false`
in `config.yaml`, which runs a single anonymous account with no lock screen.

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
