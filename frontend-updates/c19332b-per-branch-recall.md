# Frontend Update: Per-Branch Recall

**Commit:** `c19332b`
**Date:** June 30, 2026

## Summary

The recall block is now **persisted per turn** (on the user turn that triggered it)
and exposed on `GET /api/tree` nodes, so each branch keeps its own recall block —
switch away and back, and the branch's recall is still there. Previously recall was
only a single ephemeral "current" block.

## What to use

`GET /api/tree` nodes now include `recall` **only on turns that triggered recall**:

```json
{
  "id": 50, "role": "user", "...": "...",
  "recall": {
    "content": "Based on earlier conversations, you decided…",
    "sources": [ {"turn_id":15,"role":"assistant","tags":["decision"],
                  "branch_root_id":1,"similarity":0.87,"score":1.305,"preview":"…"} ]
  }
}
```

- It's attached to the **user turn** that triggered recall. Turns without recall have
  no `recall` key (read tolerantly).
- On load, render each branch's recall from its turn's `node.recall` — independent of
  the latest global one.

## Still available (unchanged)

- The live **`recall` SSE event** during a send (the block as it's generated).
- **`GET /api/recall/current`** — the most recent run's block (global "current").

So: use the SSE event live, and `node.recall` from the tree for showing a branch's
recall when viewing/switching to it.

## Lifecycle

- Stored on the turn row (`recall_content` / `recall_sources`), so it's **deleted with
  the turn** automatically (single or subtree delete) — no orphaned recall.
- Auto-migrates (new columns). No deps.

## Deploy

`git pull` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/db.py` | `recall_content`/`recall_sources` columns + migration; `set_turn_recall`; tree attaches `node.recall` |
| `backend/main.py` | persist the recall block on the triggering user turn |
| `API-SPEC.md` | documented `node.recall` |
</content>
