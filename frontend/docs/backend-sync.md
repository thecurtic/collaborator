# Backend Sync Ledger

A lightweight coordination log for backend `frontend-updates/` one-pagers — **not**
a knowledge store. Durable state lives in `api-spec/API-SPEC.md` and
`api-spec/INTENTS.md` (re-pulled from the backend); this only tracks which
one-pagers have been processed so we know what's new on a pull, and so the
backend dev knows which ones are safe to delete from the inbox.

Workflow: pull backend → read new one-pagers in `frontend-updates/` → implement
(or no-op) → add a row here → backend dev deletes the applied one-pager.

| Backend commit | Date applied | Frontend action | FE commit |
|----------------|--------------|-----------------|-----------|
| `3bfc183` system-prompt-added | 2026-06-27 | No change needed — backend-only config (system prompt moved to `system-prompt.md`); no API/data-model/UI impact. | — |
