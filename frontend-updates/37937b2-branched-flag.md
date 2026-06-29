# Frontend Update: `branched` flag on tree nodes

**Commit:** `37937b2`
**Date:** June 29, 2026

## Summary

`GET /api/tree` nodes now include a per-node boolean `branched`:

```json
{ "...": "...", "branched": true }   // true ONLY for turns created via POST /api/branches
```

- `true` → the turn was created by an explicit fork (`POST /api/branches/{id}`).
- `false` → a normal continuation (`POST /api/messages`), an assistant turn, or any
  pre-existing turn.

## Why

A *with-context* branch from a leaf is otherwise structurally identical to a normal
continuation (same `parent_turn_id`, no `paragraph_index`, no `context_boundary`), so
the tree couldn't distinguish them. With `branched` you can render the fork switcher +
an empty "continue here" slot even when a turn has a single branched child.

## Notes

- Only the **user turn** that starts the branch is marked; its assistant reply is a
  continuation (`branched: false`).
- Additive and read-tolerant: absent = false. No behavior change otherwise.
- Backed by a new `turns.branched` column (auto-migrates; existing turns = false).

## Deploy

Code + schema migration only, no deps. `git pull` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/db.py` | `branched` column + migration; `create_turn(branched=)` |
| `backend/main.py` | branch endpoint sets `branched=True`; tree node exposes bool |
| `API-SPEC.md` | documented `branched` |
</content>
