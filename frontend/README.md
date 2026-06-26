# Collaborator — Frontend

Web UI for **Collaborator**, a self-hosted personal chat interface backed by
local LLM inference. See `api-spec/INTENTS.md` for the product philosophy
(visible, editable, first-class memory) and `api-spec/API-SPEC.md` for the REST
contract this app codes against.

> Repo rules live in [`AGENTS.md`](./AGENTS.md): code is pushed to the frontend
> repo only; the backend repo is read-only and used solely to vendor the design
> docs in `api-spec/`.

## Stack

- Vite + React 19 + TypeScript
- Tailwind CSS v4 + shadcn/ui-style components
- Thin typed API layer with a swappable service seam

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000 (proxies /api -> backend :8001)
```

Make sure the backend is running on `http://localhost:8001` (or set
`VITE_BACKEND_URL`). Copy `.env.example` to `.env.local` to override.

```bash
npm run build        # type-check + production build
npm run typecheck    # types only
```

## Architecture

```
src/
  api/        wire types, HTTP client, and the CollaboratorApi service seam
  domain/     canonical app models + adapters from the wire format
  features/   chat (history, composer, bubbles) and health indicator
  components/ shadcn-style UI primitives
  lib/        utilities (cn)
```

**Design intent — built against the API as-built, without blocking the vision.**
The canonical model mirrors the implemented endpoints (health, send/list/discard
messages). The recall, tagging, and settings endpoints described under "API
Extensions Needed" in `INTENTS.md` are **not yet served** — calling code depends
on the `CollaboratorApi` interface (`src/api/collaborator.ts`), so they can be
added there (real or mocked) as the backend ships them, with no UI rewrite.

## Current scope (Phase 1)

- Send a message and see the model response
- Load conversation history
- Discard a turn (drops it from model context; stays in the DB)
- Backend health indicator

## Roadmap (from INTENTS.md, pending backend)

- Editable recall block above responses (visible memory synthesis)
- Per-turn free-form tagging with recall boosts
- Context-assembly preview (recall → recent window → current)
