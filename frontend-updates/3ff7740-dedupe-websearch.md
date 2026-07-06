# Frontend Update: Draft Dedupe Flags + web_search Tool

**Commit:** `3ff7740`
**Date:** July 6, 2026

## 1. `duplicate_of` on note drafts (render in the review UI)

Drafts (from tree synthesis **and** from the chat model's `propose_note`) now carry:

```json
"duplicate_of": [ { "title": "SQLite fits this project", "score": 0.91 } ]
```

- Present on every draft (empty list = no near-duplicates). Populated when a
  candidate is semantically close (≥ 0.85 by default) to an **existing vault note**.
- Candidates are **flagged, never dropped** — the user decides. Suggested UI: a
  "possible duplicate of ⟶ [title]" warning on the draft card, ideally linking to
  the existing note (`GET /api/notes/{title}`) so the user can compare, then reject
  or merge-by-editing.
- Upstream, the synthesis model is also shown existing notes and told to link
  instead of duplicating — so expect more `[[wikilinks]]` to existing notes in
  bodies, and fewer dupes overall.

## 2. `web_search` tool (SearXNG)

The chat model can now search the web through the private SearXNG instance. Same
streaming contract — you'll see:

```json
{"type":"status","tool":"web_search","label":"Searching the web for “vancouver transit”…"}
```

plus `tool_result` events when `tools.show_step_results` is on. Results given to the
model: up to 5 items of `{title, url, snippet, engine}` + any direct `answers` /
`infobox`. The model is instructed to cite sources by domain; a `synthesize` call
with `kind: "web"` may follow for clean summaries.

- The tool is **self-gating**: it's only offered to the model when
  `tools.web_search.url` is configured server-side. No frontend toggle needed.
- No new SSE event types.

## Deploy / ops (backend)

1. `git pull` + `./restart.sh` (auto-migrates the `duplicate_of` column; no deps).
2. Set in config (`config.yaml` or `.config.yaml`):
   ```yaml
   tools:
     web_search:
       url: "http://<search-vm-ip>"
   ```
3. **On the SearXNG box**: enable the JSON API — in `settings.yml`:
   ```yaml
   search:
     formats:
       - html
       - json
   ```
   then `sudo systemctl restart uwsgi`. (Verified: the instance is reachable from
   the backend, but `format=json` currently returns 403 until this is enabled.)

## Related files

| File | Change |
|------|--------|
| `backend/db.py` | `duplicate_of` column on drafts (+ migration) |
| `backend/main.py` | dedupe helpers; synthesis + propose_note wiring; web_search registry/executor |
| `backend/inference.py` | existing-notes context in synthesis; `web_search_searxng` |
| `synthesis-web.md` | web-results synthesis prompt (kind: "web") |
| `tools-spec.md` / `tools-guidance.md` / `API-SPEC.md` | docs |
</content>
