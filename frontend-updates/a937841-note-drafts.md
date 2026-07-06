# Frontend Update: Note Drafts (curation gate)

**Commit:** `a937841`
**Date:** July 6, 2026

## Summary

New drafts layer for the atomic-notes pipeline (`NOTES-FORMAT.md`). LLM-synthesized
notes land as **pending drafts** in the DB; the user reviews/edits and explicitly
**approves** each one, which writes the markdown file into the vault with app-stamped
frontmatter. **The vault only ever contains approved notes** — this is what needs a
review UI.

## Endpoints

```
POST  /api/notes/drafts                 create a pending draft
GET   /api/notes/drafts?status=&run_id= list (status: pending|approved|rejected)
PATCH /api/notes/drafts/{id}            edit title/body/tags/links (pending only; 409 after decision)
POST  /api/notes/drafts/{id}/approve    validate + write vault file + mark approved
POST  /api/notes/drafts/{id}/reject     mark rejected (kept for audit; vault untouched)
```

Draft shape:
```json
{ "id": 1, "run_id": "run-abc", "tree_root_id": 12,
  "title": "SQLite fits single-user local persistence",
  "body": "distilled prose with [[wikilinks]]…",
  "tags": ["databases", "decision"], "links": [],
  "source_turns": [42, 47],
  "status": "pending", "created_at": "…", "decided_at": null }
```

## Approve semantics (drive the UI around these)

- **`422`** — title invalid: empty, >180 chars, or contains `/ \ : * ? " < > | # ^ [ ]`
  (the title becomes the filename and must be wikilink-safe). Surface the message and
  let the user edit.
- **`409`** — a note with that title already exists (case-insensitive). The draft
  **stays pending**; rename via PATCH and re-approve.
- On success: `{ draft, path, filename }`. Tags get normalized to
  lowercase-hyphenated; if the body starts with a duplicate `# H1`, it's dropped (the
  file gets exactly one H1 = the title).

## Suggested review UI

A "drafts inbox": list pending drafts (grouped by `run_id` — one synthesis pass over
one tree), inline-edit title/body/tags, approve/reject per draft. `tree_root_id` +
`source_turns` let you link back to the source conversation.

## Notes

- `POST /api/notes/drafts` also lets a user hand-write a note through the same gate.
- Vault location: `notes.vault_dir` (default `backend/data/notes`); per-user
  `users/{hash}/notes` when auth is enabled. Vaults are gitignored.
- The synthesis stage (tree-export JSON → drafts) is next; it will populate this
  inbox via the same table.
- Schema migration is automatic (new `note_drafts` table). No deps.

## Deploy

`git pull` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/db.py` | `note_drafts` table + CRUD |
| `backend/main.py` | drafts endpoints, title validation, vault write w/ frontmatter |
| `NOTES-FORMAT.md` | synthesis principles (user-voice, weighting, quotes) |
| `API-SPEC.md` | section 11: note drafts |
</content>
