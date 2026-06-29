# Frontend Update: Hard Delete + Branch Delete

**Commit:** `998de36`
**Date:** June 29, 2026

## Summary

`DELETE /api/messages/{id}` now **hard-deletes** the row (previously a soft
`committed=0`). Two modes: delete a single turn (children reparent up) or delete a
whole branch (subtree).

## Behavior

### Single delete (default)
```
DELETE /api/messages/45
```
- Removes turn `45` from the DB.
- Its **direct children are reparented to 45's parent** — an orphaned child rises one
  level and sits alongside its former siblings (it does **not** detach to a root).
- Ids are not reused, so ordering is still derivable from id (just with a gap at 45).

### Branch delete (subtree)
```
DELETE /api/messages/45?subtree=true
```
- Removes turn `45` **and all its descendants** (the whole branch).
- This is the metro-map "select a branch → delete" action.

### Response
```json
{
  "id": 45,
  "deleted": true,
  "removed_turn_ids": [45],
  "removed_count": 1,
  "reparented_children": [46, 47],
  "reparented_to": 44
}
```
- `removed_turn_ids` / `removed_count`: every turn actually removed (for a subtree
  delete this is the whole branch). Use `removed_count` for "this removed N turns".
- `reparented_children` / `reparented_to`: which children moved and where (single
  delete only; empty for subtree).
- `404` if the turn doesn't exist.

## Frontend impact (breaking)

- The old response `{ "id", "committed": false }` is gone — read `deleted` /
  `removed_turn_ids` instead.
- Deletes are now **permanent** (no row remains, no un-delete). If you want a
  confirm step, you already know the subtree from the tree view; `removed_count` in
  the response confirms after the fact.
- After a single delete, update child nodes' `parent_turn_id` to `reparented_to` (or
  just refetch `GET /api/tree`).

## Notes

- Soft "discard before commit" is unchanged and separate: send with `commit:false`
  to keep a turn out of memory/context without ever persisting it as committed.
- Code only, no schema change. Deploy: `git pull` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/db.py` | `delete_turn(subtree=)` — hard delete, reparent, cascade |
| `backend/main.py` | `DELETE /api/messages/{id}?subtree=`, new response model |
| `backend/test_api.py`, `backend/test_branching.py` | delete tests |
| `API-SPEC.md` | Documented delete semantics |
</content>
