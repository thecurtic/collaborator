# Frontend Update: fetch_url Tool (pasted links)

**Commit:** `4544ac6`
**Date:** July 6, 2026

## Summary

The chat model can now **read web pages the user pastes into chat** (and open
promising `web_search` results in full). Same streaming contract — one new `status`
label to render:

```json
{"type":"status","tool":"fetch_url","label":"Reading https://en.wikipedia.org/wiki/Zettelkasten…"}
```

No new SSE event types, no API changes. `tool_result` events appear as usual when
`tools.show_step_results` is on.

## Behavior notes (for UX expectations)

- The model is instructed to **always fetch a pasted URL before discussing it** —
  expect a "Reading …" status whenever a message contains a link (tools must be on).
- Readable text is extracted server-side (scripts/styles stripped) and capped at
  ~8000 chars; **JS-rendered SPAs may come back mostly empty** — the model is told to
  say so rather than guess. PDFs and binary types are refused with a clear error.
- **Private/tailnet/LAN addresses are refused by default** (SSRF hygiene). If the
  user pastes internal links they want readable, the backend can set
  `tools.fetch_url.allow_private: true`.

## Deploy

Code only, no deps, no schema change. `git pull` + `./restart.sh`. Enabled by
default wherever tools are on (`tools.available.fetch_url` to disable).

## Related files

| File | Change |
|------|--------|
| `backend/inference.py` | `fetch_url` + stdlib HTML→text extractor + private-host guard |
| `backend/main.py` | schema + executor |
| `tools-spec.md` / `tools-guidance.md` / `API-SPEC.md` | docs |
</content>
