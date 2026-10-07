# Contributing to Collaborator

This is a personal, self-hosted project that is open for others to run and
improve. Issues and pull requests are welcome; open an issue first for
anything large.

## Development

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
the Android shell).

## Pull requests

1. Branch from `main`.
2. Keep the change focused; tests for backend behaviour go in
   `backend/test_*.py`, frontend tests next to the code.
3. Update the docs the change touches: `API-SPEC.md` for endpoints,
   `config.yaml.example` for options, `NOTES-FORMAT.md` for the note format.
4. Never commit hostnames, IPs, names or credentials. Use placeholders.
5. Conventional commit prefixes: `feat:`, `fix:`, `docs:`, `refactor:`.

## Style

- Follow the surrounding code. Comment the why, not the what.
- Backend: plain Python, few dependencies, no framework magic.
- Frontend: functional React components, Tailwind, the existing `CollaboratorApi`
  seam for anything that talks to the backend.
