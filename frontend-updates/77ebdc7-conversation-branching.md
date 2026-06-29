# Frontend Update: Conversation Branching

**Commit:** `77ebdc7`
**Date:** June 29, 2026

## Summary

Backend support for the branching feature: branch from any turn (or any paragraph
of an agent turn), inherit context up to the fork point, and read the whole
conversation as a tree for the metro-map view.

## New / changed API

### `POST /api/branches/{parent_turn_id}` (new)

Create a branch from a fork point and stream the reply (same SSE shape as
`/api/messages`).

```json
POST /api/branches/42
{
  "message": "what about X instead?",
  "paragraph_index": 1,        // optional: 0-based index into the parent's paragraphs[]
  "context_turns": 5,
  "commit": true,
  "mode": "voice"              // optional, same as /api/messages
}
```

- The branch inherits context **up to and including** turn `42` (its ancestor
  chain) — not the global recent history.
- `done` event carries the new ids and the fork info:
  ```
  data: {"type":"done","id":51,"user_turn_id":50,"parent_turn_id":42,"paragraph_index":1,"context_turns_used":5}
  ```
- Errors: `404` if the parent turn doesn't exist, `422` if `paragraph_index` is out
  of range for that parent.

> **Case 1 (branch from a turn):** call with no `paragraph_index`.
> **Case 2 (branch from a paragraph):** pass the paragraph's index.
> **Voice ("branch from your second point"):** resolve the phrase to an index on the
> frontend, then pass `paragraph_index`.

### `GET /api/tree` (new)

Full conversation as a nested tree for the metro map (committed turns only):

```json
{
  "roots": [
    { "id": 1, "role": "user", "content": "Hello", "preview": "Hello",
      "parent_turn_id": null, "paragraph_index": null, "created_at": "...",
      "children": [
        { "id": 2, "role": "assistant",
          "content": "First idea.\n\nSecond idea.",
          "preview": "First idea. Second idea.",
          "paragraphs": ["First idea.", "Second idea."],
          "parent_turn_id": 1, "children": [ ... ] }
      ] }
  ],
  "count": 12
}
```

- Root(s) at top, children below — maps directly to a vertical metro map.
- `preview` is a single-line label; `paragraphs[]` (assistant nodes) gives the
  per-paragraph branch affordances; `paragraph_index` on a node says which paragraph
  of its parent it forked from. Colour-coding is yours to derive from the structure.

### Turn shape (additions)

Turns from `GET /api/messages` and `/api/tree` now include:
- `parent_turn_id` (number | null) — fork point; null = root
- `paragraph_index` (number | null) — which paragraph of the parent this branched from
- `paragraphs` (string[]) — assistant turns only; content split on blank lines

### `POST /api/messages` (behavior note)

Now continues from the current head and chains `parent_turn_id` accordingly, so the
main thread is a proper path in the tree. To continue from a *specific* earlier
point, use `/api/branches/{id}`.

## Paragraph model

Agent responses are split into paragraphs on **blank lines**, derived on read
(no stored structure). The system prompt now nudges the model to put distinct ideas
in their own paragraphs so the indices are meaningful. Override via
`system_prompt.paragraph_text` in config.

## Migration / deploy

- Adds `parent_turn_id` + `paragraph_index` columns; migration runs automatically on
  startup for the default DB and on access for each per-user DB.
- Existing history is backfilled into a single linear chain (oldest = root), so prior
  conversations show up as one branch.
- Code + schema only. On prod: `git pull` and **restart the backend** (uvicorn) —
  verify with `GET /api/health` → `{"version":"0.2.0"}` (or higher).

## Testing checklist

- [ ] Branch from a turn (no paragraph_index) → reply streams, node appears in tree
- [ ] Branch from a paragraph → `paragraph_index` round-trips on the new turn
- [ ] Out-of-range paragraph → 422; unknown parent → 404
- [ ] `GET /api/tree` renders as a vertical root→children map
- [ ] Branch context includes ancestors up to the fork point only (not sibling branches)

## Related files

| File | Change |
|------|--------|
| `backend/db.py` | Schema + migration, ancestor chain, tree builder, branching columns |
| `backend/main.py` | `/api/branches/{id}`, `/api/tree`, paragraphs, shared helpers |
| `backend/auth.py` | Per-user DBs use the shared (migrating) schema |
| `backend/inference.py` | One-idea-per-paragraph system-prompt nudge |
| `backend/test_branching.py` | Migration / chain / tree / endpoint tests |
| `API-SPEC.md`, `config.yaml.example` | Documented branching + `paragraph_text` |
</content>
