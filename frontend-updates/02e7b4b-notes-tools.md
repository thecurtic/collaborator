# Frontend Update: Notes Tools on the Tool Loop

**Commit:** `02e7b4b`
**Date:** July 6, 2026

## Summary

The chat model can now use the notes vault during a turn: **search notes, read a note
(with backlinks), and propose a new note** — where "propose" only ever creates a
**pending draft** in the existing review inbox, never a vault file. One new SSE event
to render; everything else rides the existing `status`/`tool_result` contract.

## What changed in the stream

Nothing breaking. Tool activity still arrives as `status` events, e.g.:

```
{"type":"status","tool":"search_notes","label":"Searching notes for “databases”…"}
{"type":"status","tool":"get_note","label":"Reading note “SQLite fits…”…"}
{"type":"status","tool":"propose_note","label":"Proposing note “…” (draft for your review)…"}
```

**New event — `drafts_proposed`** (after the answer tokens, only when the model
called `propose_note` this turn):

```json
{"type":"drafts_proposed","drafts":[{"id":7,"title":"An idea worth keeping","run_id":"chat-a1b2c3d4"}]}
```

Suggested UI: a "review proposed note(s)" affordance that deep-links into the drafts
inbox filtered by that `run_id` (`GET /api/notes/drafts?run_id=chat-…`). The drafts
are ordinary pending drafts — same edit/approve/reject flow as synthesis output.

## Guarantees (for trust messaging in the UI)

- `search_notes` / `get_note` are **read-only**.
- `propose_note` **cannot** write to the vault, publish, or auto-approve — it only
  inserts a `pending` draft. The user's approval gate is structural.
- Every tool is individually toggleable server-side (`tools.available` in config),
  so the set of `status` labels you may see can vary with config.

## Verified live

Against the real model: asked "check my notes — what did I decide about databases?",
it searched the vault, read the matching note, **followed the note's `[[wikilink]]`
to attempt the linked note**, and correctly reported the unresolved link as a note
that doesn't exist yet. Graph traversal works end-to-end.

## Deploy

Code + prompt/spec file updates, no deps, no schema change. `git pull` +
`./restart.sh`. Tools must be enabled (`tools.enabled` or per-request `recall: true`).

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | three tool schemas + executors; `drafts_proposed` event |
| `backend/inference.py` | status labels |
| `tools-spec.md` / `tools-guidance.md` | model-facing docs (editable) |
| `API-SPEC.md` | tool list + `drafts_proposed` contract |
</content>
