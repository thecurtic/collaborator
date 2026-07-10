# Your batch, items 1–4 — all landed (3275100)

## 1. Draft provenance ✅ — delete the localStorage pairing store

Chat-proposed drafts (`propose_note` AND the new `propose_edit`) are stamped
server-side once the turn persists: `source_turns = [<assistant turn id>]` and
`tree_root_id = <root of that conversation>`. No API shape change — the fields
were already on the draft object; they're just populated now. The stamp happens
in the same request that streams the turn, so any later
`GET /api/notes/drafts` read sees it.

## 2. Persisted tool activity ✅ — "Sources" from any device

Assistant nodes on `GET /api/tree` now carry `tools` when the turn used tools:

```json
"tools": [
  { "tool": "web_search", "query": "…", "outcome": "ok", "count": 5,
    "urls": ["https://…", "https://…"] },
  { "tool": "fetch_url", "url": "https://…", "outcome": "ok" },
  { "tool": "search_notes", "query": "…" }
]
```

- Same fields as the live status start/outcome events (0720fd7) — one renderer
  serves both the live stream and the persisted view.
- **Bonus included:** `web_search` outcome records — and the live
  `outcome: "ok"` SSE event — now carry `urls` (the result URLs), so page-level
  sources exist for searches too, not just fetches.
- Records mirror emitted status events, so they exist only when
  `tools.status_notes` is on (it's the default). Entries without `outcome` are
  tools that don't report one (recall/notes reads) — render them as plain
  activity rows.

## 3. Auto-generated titles ✅ — seeds included

- Root turns gain `title` (string) on `GET /api/tree` — LLM-generated, all
  states, so the seeds list gets real labels. Render `name ?? title ?? preview`;
  the user-set `name` is untouched and always wins.
- Generated after each exchange's `done` event (never delays the reply), lazily
  regenerated once the tree grows by 6 turns (`titles.regenerate_after_turns`).
  Because it runs post-done, a list refresh immediately after a seed's first
  exchange may briefly show no title — it appears on the next fetch.
- Survives seed→tree promotion automatically (same root row).
- On demand: `POST /api/turns/{turn_id}/title` (any turn in the tree; resolves
  to the root) → `{ "root_id", "title" }`; `404` unknown turn, `502` generation
  failed. Good for a "regenerate title" row action.
- Prompt is user-editable at `title-prompt.md` (like the other prompt layers).

## 4. Cleanups ✅

- **WS auth is ticket-only now** — `?passkey=` and first-frame passkey are
  removed and rejected. Drop your fallback whenever convenient; the ticket flow
  you're already on is unchanged.
- `POST /api/transcribe` stays (CLI/bulk use), no frontend obligations.

## 5 (deferred, as you suggested)

`context_length` on GET /api/models and search paging — noted, ask when needed.
