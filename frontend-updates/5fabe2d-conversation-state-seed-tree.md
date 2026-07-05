# Frontend Update: Conversation Stage (`seed` / `tree`)

**Commit:** `5fabe2d`
**Date:** July 5, 2026

## Summary

Conversations now have a persisted **`state`**: `"seed"` (a new provisional chat) or
`"tree"` (a promoted full conversation). New chats start as **seeds** so they can live
in a separate "new chats" section and be upgraded to full trees later. Persisted
server-side, so it survives reload and syncs across devices.

## Behavior

- **New root chat** (`POST /api/messages` with no `parent_turn_id`) → `state: "seed"` by
  default. Pass `"state": "tree"` on the body to create a full tree directly.
- **Continuations & branches** → **inherit** the parent's state (a conversation shares
  one stage; you never set it per-turn).
- **Existing conversations** → `"tree"` (they're already established).

## Reading it

`GET /api/tree` nodes now include `state`. And you can filter roots by stage:

```
GET /api/tree?state=seed   -> the new-chats list
GET /api/tree?state=tree   -> the main conversation map
GET /api/tree              -> everything (each root has .state)
```

## Promoting (seed → tree)

```
PATCH /api/turns/{turn_id}/state
{ "state": "tree" }
-> 200 { "turn_id": 12, "state": "tree", "updated_turn_ids": [12,13,14,...] }
```
Sets the stage across the turn's **entire subtree**, so call it on the conversation's
**root** to promote the whole thing. `404` if the turn doesn't exist.

**When to promote is your call.** Two natural triggers (either or both):
- A conscious user "upgrade" action.
- Automatically when a seed chat is branched from (call the endpoint on the branch).

The backend just exposes the mechanism; wire the trigger however the UX wants.

## Suggested screen wiring

- **Search / new-chats screen:** list = `GET /api/tree?state=seed`; the search bar
  fires `POST /api/messages` (no parent) → a new seed appears in the list.
- **Main map:** `GET /api/tree?state=tree`.
- **Upgrade:** `PATCH /api/turns/{root}/state {"state":"tree"}` → the chat moves from
  the seed list into the map.

## Notes

- Recall/search still spans **all** turns regardless of state, so seed chats are
  recallable (and future note-summaries) even before promotion.
- No deps. Dev data will be reset, so no migration concerns.

## Related files

| File | Change |
|------|--------|
| `backend/db.py` | `state` column; `create_turn(state=)`; `update_subtree_state` |
| `backend/main.py` | `state` on new roots + inheritance; `?state=` tree filter; `PATCH /api/turns/{id}/state` |
| `API-SPEC.md` | documented state + promote endpoint |
</content>
