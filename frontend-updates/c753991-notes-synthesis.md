# Frontend Update: Notes Synthesis (tree → drafts)

**Commit:** `c753991`
**Date:** July 6, 2026

## Summary

The notes pipeline is now end-to-end. One new endpoint turns a chosen conversation
tree into **pending note drafts** that land in the drafts inbox (`a937841`); the
existing review/approve flow is unchanged.

## Endpoint

```
POST /api/notes/synthesize/{tree_id}
X-Passkey: <passkey>
-> 200 { "run_id": "run-abc123", "drafts": [ ...pending drafts... ], "count": 2 }
```

- `tree_id` = a root turn id (whole conversation) **or** any committed turn id
  (synthesize just that branch).
- One LLM pass on the backend (editable `synthesis-notes.md` prompt, structured JSON
  output). Results are stored as **pending** drafts grouped by `run_id` — review them
  via `GET /api/notes/drafts?run_id=...` and approve/reject as before.
- **Zero drafts is a valid outcome** (nothing in the tree passed the idea gates) —
  handle `count: 0` gracefully.
- `404` — unknown or uncommitted turn. `502` — model call failed (surface and offer
  retry).
- **Synchronous and potentially slow** (local inference; default timeout 300s). Show
  a progress state; a big tree can take a minute or more.

## Suggested wiring

"Synthesize notes" action on a tree (metro map) or branch → call this endpoint →
navigate to the drafts inbox filtered by the returned `run_id`.

## What the drafts look like (verified live)

The model produces first-person, claim-titled notes with tags, cross-`links` within
the batch, and `source_turns` citing which turns each note came from — e.g.
"SQLite fits single-user local persistence" (decision) cross-linked with
"Is deep JSON querying in SQLite worth the tradeoff?" (open-question). Bodies are
self-contained prose in the user's voice; expect the occasional slip the user will
fix during review — that's what the gate is for.

## Deploy

Code + prompt file only, no deps, no schema change. `git pull` + `./restart.sh`.
Tunables in `config.yaml` under `notes:` (`synthesis_max_tokens`, `_temperature`,
`_timeout`, `synthesis_prompt_file`).

## Related files

| File | Change |
|------|--------|
| `synthesis-notes.md` | the synthesis prompt (editable/auditable) |
| `backend/inference.py` | `synthesize_notes` (structured output + fallback parse) |
| `backend/main.py` | `POST /api/notes/synthesize/{tree_id}` |
| `API-SPEC.md`, `INTENTS.md` | docs |
</content>
