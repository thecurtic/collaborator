# Frontend Update: Notes Index (vault read/search/backlinks)

**Commit:** `0688821`
**Date:** July 6, 2026

## Summary

The vault is now readable through the API: list, fetch (with backlinks), search
(semantic + keyword), and reconcile. Enough to build a notes browser / graph view.
The index is a **rebuildable cache** — files stay the source of truth, and edits made
directly in Obsidian are picked up by reindex.

## Endpoints

```
POST /api/notes/reindex                      reconcile index against the vault
GET  /api/notes?tag=decision                 list notes (metadata + link edges)
GET  /api/notes/search?q=…&mode=semantic|keyword&limit=10
GET  /api/notes/{title}                      one note: body + backlinks (404 if unknown)
```

Note shape (list/search; `get` adds `body` + `backlinks`):
```json
{ "filename": "SQLite fits single-user local persistence.md",
  "title": "SQLite fits single-user local persistence",
  "created": "2026-07-06", "tags": ["databases", "decision"],
  "source_turns": [42, 47],
  "links": ["Postgres JSON support"],
  "content_hash": "…", "mtime": 1751… }
```

- `links` = outgoing `[[wikilink]]` targets parsed from the body (alias/heading parts
  stripped). `backlinks` = notes whose bodies link to this title. Together they're
  the graph edges for a graph/metro view of the vault.
- `{title}` lookup is case-insensitive; URL-encode spaces. Literal routes
  (`/api/notes/drafts`, `/search`, `/reindex`, `/synthesize`) are matched first.
- **Approving a draft indexes it immediately** — no manual reindex needed for
  app-created notes. Call `POST /api/notes/reindex` after external (Obsidian) edits;
  it returns `{added, updated, removed, total}`.
- Semantic search uses the same local embedder as recall; `mode=keyword` needs no
  embeddings.

## Design guarantee (relevant to future features)

Everything graph-relevant (titles, link edges, tags) is derived from note content
alone — never stored only in the index. Dropping the index and rebuilding from files
yields the identical graph (enforced by test). This keeps the planned Nostr kind-1
export reconstructable from relays later.

## Deploy

Code + auto-migrating table, no deps. `git pull` + `./restart.sh`. Optionally
`POST /api/notes/reindex` once if notes already exist in the vault.

## Related files

| File | Change |
|------|--------|
| `backend/notes_index.py` | new: parse/reconcile/search/backlinks |
| `backend/db.py` | `notes_index` table |
| `backend/main.py` | four endpoints + index-on-approve hook |
| `API-SPEC.md`, `NOTES-FORMAT.md` | docs + the rebuildability invariant |
</content>
