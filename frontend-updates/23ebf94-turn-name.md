# Frontend Update: Per-Turn Name (conversation/branch naming)

**Commit:** `23ebf94`
**Date:** July 1, 2026

## Summary

Turns can now carry a user-set **name**, so you can persist conversation/branch names
server-side (instead of localStorage). Name a conversation by naming its root turn;
name a branch by naming the branch's root turn.

## API

**Set / clear a name:**
```
PATCH /api/turns/{turn_id}/name
{ "name": "Database planning" }        // empty string or whitespace clears it
-> 200 { "turn_id": 12, "name": "Database planning" }   // trimmed; null when cleared
```
`404` if the turn doesn't exist.

**Read it:** `GET /api/tree` nodes now include `name`:
```json
{ "id": 12, "role": "user", "name": "Database planning", "...": "..." }
```
`null` = unnamed.

## Notes

- It's a generic per-turn field; you decide which turns to name (root / branch-root).
- Backed by a `turns.name` column (auto-migrates; existing turns = null). Deleted with
  the turn. No deps.

## Deploy

`git pull` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/db.py` | `name` column + migration; `update_turn_name` |
| `backend/main.py` | `PATCH /api/turns/{id}/name`; `node.name` via tree |
| `API-SPEC.md` | documented `name` + endpoint |
</content>
