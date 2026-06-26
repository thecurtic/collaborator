# Local Dev Testing — Frontend + Backend

How to run the Collaborator frontend against a **local** backend on this
machine. The backend runs from a sibling directory and is never committed to
this repo (see [`AGENTS.md`](./AGENTS.md)).

```
E:\Tools\Apps\
├── collaborator-frontend\   <- this repo (pushed to the frontend remote)
└── collaborator-backend\    <- sibling clone, NOT part of this repo
```

## Architecture of the dev loop

```
Browser → http://localhost:3000  (Vite dev server)
            │  requests to /api/* are proxied (same-origin, no CORS)
            ▼
         http://127.0.0.1:8001    (FastAPI backend)
            │  calls the OpenAI-compatible LLM endpoint
            ▼
         http://<inference-host>:1234/v1  (LM Studio — model: qwen/qwen3-coder-next)
```

The proxy target and LLM endpoint are configurable:
- Frontend proxy → `VITE_BACKEND_URL` (default `http://localhost:8001`), see `vite.config.ts`.
- Backend LLM/DB → `../collaborator-backend/.config.yaml` (gitignored local override).

## One-time backend setup (already done on this machine)

```powershell
cd E:\Tools\Apps
git clone <backend-remote> collaborator-backend
cd collaborator-backend
py -m venv venv
.\venv\Scripts\python.exe -m pip install -r backend\requirements.txt pyyaml requests
```

> Note: `pyyaml` and `requests` are imported by the backend but missing from its
> `requirements.txt`, so they're installed explicitly above.

The local override `collaborator-backend\.config.yaml` (gitignored) sets:
- `inference.endpoint_url: http://<inference-host>:1234/v1`
- `memory.db_path: E:/Tools/Apps/collaborator-backend/backend/data/conversations.db`
- `server.backend_port: 8001`

## Running it (two terminals)

**Terminal 1 — backend:**
```powershell
.\scripts\start-backend.ps1
```

**Terminal 2 — frontend:**
```powershell
npm install   # first time only
npm run dev
```

Then open <http://localhost:3000>. In the Claude Code session you can also launch
either with the `!` prefix, e.g. `! ./scripts/start-backend.ps1`.

## Smoke tests

```bash
curl http://127.0.0.1:8001/api/health                 # backend direct
curl http://localhost:3000/api/health                 # through the Vite proxy
curl -X POST http://localhost:3000/api/messages \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","commit":false}'             # full loop (commit:false = no DB write)
```

## Known backend ↔ spec discrepancies (found while wiring this up)

These are real differences between `api-spec/API-SPEC.md` and the **as-built**
backend. The frontend already tolerates them; flagged here so they don't bite
later (and are worth fixing in the backend/spec to stop the drift):

1. **`GET /api/messages` returns `content`, not `message`/`response`.** Each turn
   has one `content` field; the role determines whether it's the prompt or reply.
2. **Errors use `{ "detail": ... }` (FastAPI), not `{ "error": ... }`.**
3. **`committed` comes back as `0/1`**, not a JSON boolean.
4. **`created_at` is `"YYYY-MM-DD HH:MM:SS"` UTC**, not ISO-8601 with `Z`. The UI
   normalizes this to UTC before display (`parseApiDate` in `src/lib/utils.ts`).
5. **`GET /api/messages` only returns committed turns** — discarded turns vanish
   from history on reload (they remain in the DB).

## Troubleshooting

- **`POST /api/messages` returns 500** → the backend can't reach the LLM. Confirm
  `curl http://<inference-host>:1234/v1/models` works, or update `endpoint_url` in
  `.config.yaml`.
- **Frontend health shows "offline"** → backend isn't running on `:8001`.
- **Port 8001 in use** → another backend instance is running; stop it first.
