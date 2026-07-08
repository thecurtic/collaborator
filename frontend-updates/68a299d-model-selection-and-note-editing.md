# Frontend Update: Model Selection + Note Editing

**Commits:** `68a299d` (model), `aa86110` (notes)
**Date:** July 8, 2026

Two new user-editable surfaces, both requested for in-app control.

## 1. Model selection

```
GET /api/models  -> { "current": "qwen/qwen3-coder-next", "available": ["…", "…"] }
PUT /api/model   { "model_id": "qwen/qwen3-30b-a3b", "force"?: false }
                 -> { "model_id": "…", "persisted": true }
```

- Build a picker from `available` (fetched live from LM Studio; may briefly fail if
  the inference box is down — handle a 500 on GET gracefully).
- `PUT` **applies immediately** — the very next message uses the new model — and
  persists across restarts. No restart step to expose in the UI.
- `422` = model not in the available list (detail includes the list). Offer
  `force: true` only as an advanced action.
- ⚠️ Worth a hint in the UI: the model is **per-install** — switching changes it for
  every user/passkey, not just the current one.

## 2. Editing approved notes

```
PATCH /api/notes/{title}
{ "title"?: "New title", "body"?: "new body…", "tags"?: ["decision", "databases"] }
-> 200 { "note": { ...updated note incl. backlinks... },
         "renamed": true, "links_rewritten": ["Alpha"] }
```

- All fields optional — send only what changed. `GET /api/notes/{title}` already
  returns `body`, so a full edit UI is: GET → edit → PATCH.
- **Rename is safe**: the backend rewrites inbound `[[wikilinks]]` across the whole
  vault (including `[[Old|alias]]` forms) and reports which notes it touched in
  `links_rewritten` — nice to surface ("also updated 3 linking notes").
- Tags are normalized server-side (lowercase-hyphenated); frontmatter provenance
  and any unknown keys survive edits.
- Errors: `404` unknown note, `422` invalid title characters, `409` title collision
  (surface the message; the user picks a different title).
- Everything is reindexed immediately — search/backlinks/graph views are current on
  the next fetch.

## Deploy

Code only, no deps, no schema change. `git pull` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | `GET /api/models`, `PUT /api/model`, `PATCH /api/notes/{title}` |
| `backend/notes_index.py` | frontmatter-preserving compose + wikilink rewriting |
| `API-SPEC.md` | sections for both |
</content>
