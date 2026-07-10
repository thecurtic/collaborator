# Edit drafts: the LLM can now propose changes to existing notes (3275100)

New tool `propose_edit`: the model proposes edits to an existing vault note
(title, body, tags — any subset). Same curation gate as `propose_note` — every
proposal is a PENDING draft; nothing touches the vault until the user approves.
You asked for all note proposals in one inbox: that's exactly how it lands.

## Draft objects — three new fields (all kinds)

```json
{ "id": 9,
  "kind": "edit",                          // "new" (default) | "edit"
  "target_title": "Transit is freedom",    // the existing note being changed
  "reason": "sharper claim; add cities tag", // model's one-line why (may be null)
  "title": "Good transit is freedom",      // proposed title (may equal target)
  "body": "…full proposed body…",
  "tags": ["transit", "cities"],
  "status": "pending", ... }
```

- **Snapshot semantics:** for edit drafts, `title`/`body`/`tags` hold the FULL
  proposed state — fields the model didn't change were filled from the note's
  current values at proposal time. So the natural review UI is a diff:
  fetch the current note (`GET /api/notes/{target_title}`) vs the draft.
- Existing drafts read as `kind: "new"`; render those exactly as before.
- `reason` is review context — show it on the card.

## Flow changes

- `drafts_proposed` SSE event entries now carry `kind` (and `target_title` for
  edits): `{"id":8,"title":"…","run_id":"…","kind":"edit","target_title":"…"}`.
- `POST /api/notes/drafts/{id}/approve` on an edit draft applies the change
  through the same machinery as the user's own PATCH (renames rewrite inbound
  wikilinks vault-wide, reindex included) and additionally returns
  `"renamed": bool` and `"links_rewritten": [titles]`.
  New `409` case: the target note was deleted/renamed since the proposal —
  `detail` explains; offer reject (or the user re-asks the model).
- Reject and PATCH-during-review work on edit drafts exactly as on new ones.
- Bulk: the model creates one draft per note ("retag my transit notes" → N
  drafts in one turn). A bulk-approve affordance is purely frontend — the
  per-draft endpoints are the API.

## Also in this commit

Note titles are now constrained to 3–7 words (wikilink handles) at every
prompt layer — new synthesis output and proposals should stop producing the
verbose sentence-titles you've been seeing.
