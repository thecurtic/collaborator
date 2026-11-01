# Forking Collaborator

Collaborator is my personal project. I build it for my own use, on my own
hardware, and change it whenever that use calls for it. It's open source
so you can read it, run it and make it yours, but it isn't a product, and
I don't support it for anyone else.

In practice:

- **Pull requests:** I'm not taking them right now. A PR will likely be
  closed unread, however good it is; that's no comment on the work.
- **Issues:** you're welcome to report a real bug, but expect no reply, no
  fix on any schedule, and no help setting it up.
- **Stability:** nothing is promised. Endpoints, config keys, the database
  schema and the note format change when I need them to, with no migration
  path for anyone but me.

**Forking is encouraged.** That's the point of it being open. Take it,
rename it, rip out what you don't want, build what you do. The MIT license
lets you do all of that; you don't need to ask.

## Getting it running

```bash
# backend
cp config.yaml.example config.yaml
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
backend/.venv/bin/python -m pytest backend -q

# frontend
cd frontend
npm install
npm run dev          # http://localhost:3000, proxies /api to the backend on :8001
npm run typecheck && npm run build && npm test
```

`frontend/DEV.md` covers the dev loop in more detail (PWA testing, phones,
the Android shell). `DEPLOY.md` covers running it on a server.

## How it's built, if you're changing it

These are the conventions the code follows. Your fork is yours, but keeping
them makes the existing docs stay true.

- Each change updates the docs it touches: `API-SPEC.md` for endpoints,
  `config.yaml.example` (with a default in `backend/config.py`) for options,
  `NOTES-FORMAT.md` for the note format, and `INTENTS.md` or the UX
  intentions doc for design decisions.
- Tests for backend behaviour go in `backend/test_*.py`, frontend tests next
  to the code. Tests never call a live model.
- Nothing personal in the repository: no hostnames, IPs, names or
  credentials. Use placeholders like `<inference-host>`; real values live
  only in the gitignored `config.yaml`.
- Follow the surrounding code. Comment the why, not the what.
- Backend: plain Python, few dependencies, no framework magic.
- Frontend: functional React components, Tailwind, and the existing
  `CollaboratorApi` seam for anything that talks to the backend.
- Commits use conventional prefixes: `feat:`, `fix:`, `docs:`, `refactor:`.

`AGENTS.md` holds the same rules for AI coding agents working in the repo.
