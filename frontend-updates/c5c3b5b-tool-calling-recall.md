# Frontend Update: Recall is now Tool-Calling (streaming contract change)

**Commit:** `c5c3b5b`
**Date:** July 1, 2026

## Summary

Recall is no longer an automatic pre-turn step — the model now **decides** what to
retrieve by calling tools (semantic search, keyword search, synthesize), and tells the
user what it's doing as it goes. This changes the `/api/messages` (and `/api/branches`)
SSE stream: the old single `recall` event is **gone**, replaced by `status` and
`tool_result` events.

## New SSE events

When tools are on and the model uses them, these interleave before the answer tokens:

```json
{"type":"status","tool":"recall_semantic","label":"Searching memory (semantic)…"}
{"type":"tool_result","tool":"recall_semantic","result":"[{...matches...}]"}   // only if enabled
{"type":"token","content":"We chose "}                                          // final answer
{"type":"done", ...}
```

- **`status`** — a short "what it's doing" note per tool call. Render it as a live
  activity line (like other assistants' "Searching…/Thinking…"). Present when
  `tools.status_notes` is on (default).
- **`tool_result`** — the raw result of a tool, **only** emitted when
  `tools.show_step_results` is on (default off). Use it if you want an expandable
  "show steps" view.
- **`token`** — the final answer, streamed as before.
- **`done`** — unchanged.

⚠️ **Removed:** the old `{"type":"recall", ...}` event. If you rendered that, switch to
`status` (for the activity line) and `node.recall` from the tree (for the persisted
block).

## Enabling it

Same flag as before: send `"recall": true` on `POST /api/messages` / `/api/branches`
to offer tools for that turn (it now means "let the model use its tools"). Server
default is `tools.enabled` (off until configured). When off, it's plain streaming with
no tool events — unchanged behavior.

## Persisted recall (unchanged shape)

If the model calls the `synthesize` tool, its output is stored as the turn's recall
block and still appears as `node.recall = { content, sources }` in `GET /api/tree`
(per-branch). Note synthesis is optional — the model may answer directly from search
results without synthesizing, in which case there's no `node.recall` for that turn.

## What the model can call (stage 1)

- `recall_semantic` — meaning-based search over past turns (needs embeddings).
- `recall_keyword` — literal keyword search (no embeddings needed).
- `synthesize(kind, items)` — turn snippets into a memory block (kind → its own prompt).

`web_search` and notes tools will slot into the same events later. Each tool is
enable/disable-able server-side in the `tools.available` config.

## Deploy / setup (backend)

- Needs a tool-capable chat model in LM Studio — `qwen3-coder-next` works (verified).
- `tools.enabled: true` (or per-request `recall: true`), `tools.temperature: 0.3`
  (lower = more reliable tool calls).
- For semantic recall, `fastembed` + `recall.enabled` as before; keyword works without.
- `git pull` + `pip install -r requirements.txt` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/inference.py` | `generate_with_tools` loop; `synthesize(kind)`; tools guidance layer |
| `backend/db.py` | `search_keyword_turns` (lexical) |
| `backend/main.py` | tool registry/executor; loop wired into send path; status/tool_result events |
| `backend/config.py`, `config.yaml.example` | `tools` config section |
| `tools-guidance.md` | editable tool-usage prompt |
| `API-SPEC.md` | new streaming contract |
</content>
