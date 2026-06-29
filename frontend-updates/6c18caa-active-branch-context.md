# Frontend Update: Active-Branch Context + Context-Window Fields

**Commit:** `6c18caa`
**Date:** June 29, 2026

## Summary

Three branching-context changes:
1. **`POST /api/messages` now takes `parent_turn_id`** — the backend builds context
   from the active branch instead of guessing.
2. Confirmed **`context_turns: 0` = fresh context** (turn still stored/linked).
3. **`GET /api/tree` now exposes the context window** (top-level `context_turns` +
   per-node `context_boundary`).

## 1. Active branch — IMPORTANT (behavior change)

Previously `POST /api/messages` assumed the head was the most-recently-created turn
(`MAX(id)`), so continuing after a branch switch used the **wrong** branch's context.
Now context is driven by the active leaf you pass:

```json
POST /api/messages
{ "message": "...", "parent_turn_id": <active leaf turn id>, "context_turns": 5 }
```

- **Always send `parent_turn_id`** = the leaf turn of the branch currently in view.
  Context = that turn's ancestor chain; the new turns chain off it.
- **Omit `parent_turn_id` only for a brand-new conversation** (fresh root, no
  context). ⚠️ If you omit it while a conversation exists, you'll start a *new
  disconnected root*, not continue — so wire the leaf id through.
- Unknown `parent_turn_id` → `404`.
- The `done` event echoes `parent_turn_id` and `context_turns_used`.

Forking from a mid-turn or a paragraph still uses `POST /api/branches/{id}` (that
already inherits context up to the fork point).

## 2. `context_turns` semantics (confirmed)

- **omitted / null** → configured default window (`memory.default_context_window`).
- **`0`** → fresh context: the model gets no prior history, but the turn is still
  stored and linked, and shows in `GET /api/tree` normally. ("branch without context")
- **N** → last N committed turns of the active path.

## 3. Context window in `GET /api/tree`

```json
{ "roots": [...], "count": 12, "context_turns": 5 }
```
- Top-level **`context_turns`** = default window size (matches the `done` event's
  `context_turns_used`). Shade the last `context_turns` of the active path.
- Each node now also has its stored **`context_turns`** and a **`context_boundary`**
  boolean (`true` when generated with `context_turns: 0`). For correct shading on a
  "without context" branch, walk back from the active leaf and **stop at the most
  recent `context_boundary`**.

## Deploy

Code only, no deps, no schema change. `git pull` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | `parent_turn_id` on `/api/messages`; tree `context_turns` + `context_boundary`; default-window resolution |
| `API-SPEC.md` | Documented the above |
</content>
