# Frontend Update: Conversation Tree Export

**Commit:** `b04184e`
**Date:** July 6, 2026

## Summary

New endpoint that exports a conversation as one nested JSON tree, shaped for the
upcoming notes-synthesis pipeline. It's the **user-initiated preprocessing step**:
the user picks a tree (or branch) to export; no LLM is involved in this stage.

## Endpoint

```
GET /api/tree/{turn_id}/export
X-Passkey: <passkey>
-> 200 { "tree": { ...nested node... } }
```

- Pass a **root** turn id → the whole conversation.
- Pass any committed **mid-tree** turn id → just that subtree (a single branch).
- `404` if the turn doesn't exist or is uncommitted.

## Node shape

```json
{
  "id": 1, "parent_turn_id": null,
  "role": "user", "content": "…",
  "created_at": "2026-07-06T10:00:00Z",
  "committed": true, "context_turns": 20,
  "branched": false, "paragraph_index": null,
  "model_name": null, "name": "Database planning", "state": "tree",
  "tags": ["decision"],
  "sibling_index": 0, "sibling_count": 1,
  "children": [ /* nested nodes, same shape */ ]
}
```

Every committed turn is its own node (no content merging). Link metadata
(`parent_turn_id`, `paragraph_index`, `branched`, sibling info) is included so a
future synthesis stage can turn branch relationships into note links.

## Rules

- **Uncommitted turns are pruned**; their committed descendants reattach to the
  nearest committed ancestor. Each node's `parent_turn_id` is the *effective*
  (post-prune) parent.
- **Recall blocks and embeddings are excluded** — primary content only.
- Timestamps are ISO-8601 UTC (`…T…Z`).
- Orphaned turns (broken parent links; only possible via manual DB edits — API
  deletes reparent at delete time) are skipped with their subtrees.

## Suggested UI

A "synthesize notes" / "export" action on a tree in the metro map (or on a branch)
that calls this endpoint with the chosen root. Nothing else changes — this is
additive; no existing contract touched.

## CLI (offline / bulk)

```
python backend/export_tree.py --db backend/data/conversations.db [--tree-id N] [-o out.json]
```
Without `--tree-id` it exports **all** trees as a JSON list.

## Deploy

Code only, no deps, no schema change. `git pull` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/export_tree.py` | new: reshaping module + CLI |
| `backend/main.py` | `GET /api/tree/{turn_id}/export` |
| `backend/test_export.py` | structure/prune/orphan/endpoint/CLI tests |
| `API-SPEC.md` | documented the export |
</content>
