# Backend testing

The suite is pytest, runs without a model or network, and uses temporary
databases. Run it from the `backend/` directory so the modules import by
name:

```bash
cd backend
../backend/.venv/bin/python -m pytest -q
```

Conventions:

- One `test_<area>.py` per area (`test_sessions.py`, `test_notes_tools.py`,
  `test_nwc.py`, …). New behaviour gets a test in the matching file.
- Tests set `DB_PATH` and other config at runtime through fixtures; nothing
  reads your real `config.yaml` or data.
- `test_integration.py` is the one exception: it talks to a live inference
  endpoint (`LLM_ENDPOINT`, default `http://localhost:1234/v1`) and is for
  manual use.

Quick manual checks against a running backend:

```bash
curl http://localhost:8001/api/health
curl -X POST http://localhost:8001/api/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "commit": false}'
```
