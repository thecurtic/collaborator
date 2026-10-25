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
- **Feed, Calendar and Projects**: a warm feed of what needs you, a calendar
  with recurrence and .ics import, and projects as tags over your notes and
  chats. Attachments and one unified search across all of it.
- **Agents**: coding-agent backends (such as pi-session-manager) pair over
  the tailnet and show up inside a project as channels. Send them notes, answer
  their questions, start projects and approve merges with signed requests, try
  test builds, and ask for a run report (tokens, cost, timeline, and the gaps
  where Collaborator wasn't listening).
- **Money**: a Lightning wallet (LNbits, or NWC) for paid tools such as DITTA
  search, with the model's spending capped per payment and per day.
- **Tool log**: every tool call the model makes, with arguments, results and a
  risk filter, for your own audit.
- **Inference gate** (`gate/`): a small proxy on the inference box that lets
  coding agents share the model server, and holds their requests whenever
  Collaborator wants the model to itself.
- **Mobile-first PWA** plus a thin Android shell.

## Layout

```
backend/     FastAPI server: SQLite persistence, notes vault + index, tools, voice
frontend/    Vite + React PWA, Capacitor Android shell
deploy/      systemd unit and reverse-proxy example
gate/        the inference gate for the model box (own deps and tests)
docs/        known issues, design notes, the request-signing test vector
*.md         design documents and the prompt files the backend loads
```

The prompt files at the root (`system-prompt.md`, `tools-spec.md`, the
synthesis and style prompts) are read by the backend at runtime, most of them
fresh on every turn, and are meant to be edited. `config.yaml` names which
file plays which role.

## Quick start

Needs Python 3.10 to 3.12 with `venv` (the pinned requirements don't install
on 3.13 yet; on a newer system use `python3.12 -m venv backend/.venv`),
Node 20+, and ffmpeg for transcription.

```bash
cp config.yaml.example config.yaml      # edit inference.endpoint_url at least
./dev.sh                                # backend on :8001, app on http://localhost:3000
```

The first run creates `backend/.venv`, installs requirements and runs
`npm install`. Ctrl-C stops both servers. To run the two halves yourself:

```bash
cd backend && .venv/bin/uvicorn main:app --port 8001 --reload
cd frontend && npm run dev              # proxies /api to :8001
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

- [INTENTS.md](INTENTS.md): the original design rationale (July 2026). Its
  philosophy and data model still hold; parts are superseded, see its status
  note.
- [Collaborator UX Redesign — Intentions](Collaborator%20UX%20Redesign%20%E2%80%94%20Intentions.md): where it is going.
- [NOTES-FORMAT.md](NOTES-FORMAT.md): the on-disk note format.
- [API-SPEC.md](API-SPEC.md): the HTTP, streaming and WebSocket API, including
  the agent seam's frames, signed requests and run logs. The REST routes are
  also documented live by the running backend at `/docs`.
- [docs/known-issues.md](docs/known-issues.md): bugs and the optimization backlog.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agents working in this repo follow
[AGENTS.md](AGENTS.md).

## AI-assisted code

Much of the code in this repository was written with AI coding tools,
including Claude Code, working to the author's designs and direction and
tested by the author on real use. Treat it as you would any code you didn't
write: read it before you trust it, especially the authentication, payment
and network-facing parts.

## License

MIT, see [LICENSE](LICENSE).
