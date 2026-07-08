# Frontend Update: Prompt Visibility (read-only)

**Commit:** `016eb0c`
**Date:** July 8, 2026

## Summary

New read-only endpoints exposing **every prompt building block as the runtime
resolves it** — for a "prompts" viewer screen. Editing is deliberately not part of
this (shelved; the API is view-only by design, so don't build edit affordances yet).

## Endpoints

```
GET /api/prompts            -> { "prompts": [ ... ], "count": N }
GET /api/prompts/{name}     -> { "prompt": { ... } }    (404 if unknown)
```

Entry shape:
```json
{ "name": "tools-guidance",
  "description": "When/how to reach for tools (incl. untrusted-web + citation rules)",
  "applies": "turns with tools enabled",
  "source": "file",                // file | config | default
  "file": "tools-guidance.md",     // null unless source=file
  "content": "…the exact text the model receives…",
  "note": "optional caveat" }
```

Current names (don't hardcode — render whatever the list returns; synthesis kinds
follow server config, so new ones appear automatically):
`system`, `paragraph-style`, `voice-style`, `tools-guidance`, `tools-spec`,
`synthesis-memory`, `synthesis-web`, `synthesis-notes`.

## Rendering suggestions

- `content` is markdown — render it as such.
- Show `source` as a badge (file / config / built-in default) and `applies` as a
  subtitle; surface `note` when present (e.g. the system prompt's "cached until
  restart" caveat — genuinely useful for the user to see).
- This is a live view: the same request after a server-side file edit shows the new
  text (except `system`, per its note).

## Deploy

Code only, no deps, no schema change. `git pull` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | inventory + two endpoints |
| `backend/inference.py` | loader reports provenance (shared resolution path) |
| `API-SPEC.md`, `INTENTS.md` | docs; editability status |
</content>
