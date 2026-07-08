# Search/tool status events now carry structured fields + outcomes (0720fd7)

One-pager for the frontend. Everything here is **additive** — existing rendering of
`status` events keeps working unchanged.

## What changed

During a tool-using turn, the SSE stream now tells you what each tool call was AND
how it went. Two shapes of `status` event per tool call:

**1. Start (existed before; new structured fields):**
```json
{"type":"status","tool":"web_search","label":"Searching the web for “boe governor 2026”…","query":"boe governor 2026"}
{"type":"status","tool":"fetch_url","label":"Reading https://example.com/page…","url":"https://example.com/page"}
{"type":"status","tool":"get_note","label":"Reading note “…”…","title":"My note title"}
```
- `query` — full untruncated query (search-type tools: `web_search`,
  `recall_semantic`, `recall_keyword`, `search_notes`).
- `url` — full URL (`fetch_url`).
- `title` — note title (`get_note`).
- Prefer these fields over parsing `label` (label truncates the query/url).

**2. Outcome (new; distinguished by the `outcome` field):**
```json
{"type":"status","tool":"web_search","outcome":"ok","count":5,"label":"Web search returned 5 results."}
{"type":"status","tool":"web_search","outcome":"empty","count":0,"label":"Web search returned no results."}
{"type":"status","tool":"web_search","outcome":"error","error":"web search failed — no engines responded (brave: too many requests; …)","label":"web_search failed: …"}
{"type":"status","tool":"fetch_url","outcome":"ok","label":"Read page: “Page Title”."}
```
- `outcome`: `"ok"` | `"empty"` | `"error"`.
- `count`: number of results (web_search only).
- `error`: short failure reason (truncated to 200 chars).
- Emitted for `web_search` and `fetch_url` (and for ANY tool whose result is an
  error). Other tools may not emit an outcome event — don't wait for one.

## Suggested UI

Render each tool call as a chip/row: start event creates it (show the query/url),
outcome event resolves it (✓ 5 results / ∅ no results / ✕ failed + reason). This
directly addresses "did it actually search?" — a failed search now looks failed
instead of the model claiming "no results".

## Also in this commit (no frontend action)

- Search queries are date-grounded (no more training-era "2024" in queries).
- Tool calls the model emits as raw JSON/XML text are executed instead of being
  streamed into the chat as a garbage reply — you should stop seeing assistant
  messages that consist of one JSON/`<tool_call>` blob.

## How to distinguish start vs outcome

`"outcome" in event` — outcome events always carry it, start events never do.
Discriminate on that, not on label text.
