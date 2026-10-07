# Known issues and optimization backlog

Carried over from an internal review of the backend and frontend on
2026-09-15. Line numbers were accurate then and drift; search for the symbol.
Most important first.

## Bugs and risks

- **SQLite: no WAL, no `busy_timeout`, no foreign-key pragma.** `db.py` sets no
  PRAGMA anywhere and `main.py` opens a connection per request. Background
  threads (transcription jobs, title generation, voice preload) write
  concurrently, so "database is locked" is a matter of time. Fix: one
  connection helper setting `journal_mode=WAL`, `busy_timeout=5000`,
  `synchronous=NORMAL`, `foreign_keys=ON`.
- **Blocking work on the event loop.** Several `async def` handlers call
  `requests` or run fastembed synchronously: `manual_web_search`,
  `list_models`, `search_vault_notes`, `reindex_notes`, `reindex_embeddings`,
  `approve_draft` and the duplicate finder in `synthesize_tree_notes`. Each
  stalls every other request, including the WebSocket audio stream. Fix: make
  them plain `def` (Starlette runs sync handlers in a threadpool) or use
  `asyncio.to_thread`.
- **Post-reply work delays the visible end of the reply.** In
  `_stream_turn_response` both turns are embedded before the `done` event, and
  the title update runs after `done` but inside the generator, holding the
  response open for up to `titles.timeout`. Move both to a background job.
- **Recall search is O(N) Python with N root walks.** `search_similar_turns`
  computes cosine per row in a Python loop and resolves the branch root for
  every scored row rather than the top-k. Same in `search_keyword_turns`. Fix:
  cache a numpy matrix of embeddings per DB (invalidate on write), one matmul,
  then resolve roots only for the top-k via the recursive CTE already used in
  `count_tree_turns`.
- **Full table scans with per-row JSON parsing** in `get_backlinks`,
  `list_events`, `search_notes_keyword`, `search_notes_semantic`,
  `graph_neighborhood`, `search_transcripts` (loads all transcript text) and
  `get_note_by_title` (`lower(title) = lower(?)`, unindexed). The ambient note
  hints run a vault embedding search on every tools turn.
- **`POST /api/transcribe` ignores sessions.** It checks only `X-Passkey`, so
  cookie-authenticated browser clients get 403. The frontend dictates over the
  WebSocket now, so this is likely dead, but it is broken.
- **SSRF guard TOCTOU.** `_host_is_private` resolves once; the actual
  `requests.get` resolves again and follows redirects unchecked. Low risk on a
  private single-user box. Fix: `allow_redirects=False` plus a per-hop check.
- **Lockout is global.** One remote attacker can block new logins for everyone
  (existing sessions survive, by design). Key it per source IP.
- `_last_seen_cache` in `auth.py` grows unbounded (trivial).
- `StreamSession.audio` in `voice.py` holds the full session PCM, roughly
  115 MB per hour. Fine for calls; note for very long sessions.
- `delete_turn` leaves dangling `recall_sources` and `note_drafts.source_turns`
  references (harmless).
- `transcribe_audio` reads the whole upload into memory and trusts the
  Content-Length header for the size check.
- **Frontend `useHealth`** polls `/api/health` and `/api/models` every 15 s per
  open tab, and `/api/models` makes the backend hit the inference server twice
  each time.
- **Frontend per-token full re-render.** `onToken` calls `setStreaming` per
  chunk and ChatView re-parses the entire growing reply through react-markdown
  on every token.
- **Frontend tree refetch after every mutation.** `api.getTree()` runs after
  every send, branch, confirmed mutation and call close. Cost grows with the
  whole corpus per message.
- **Server TTS awaits the full sentence blob**, so the streaming WAV endpoint
  buys nothing.
- **Deprecation:** `starlette.testclient` with `httpx` warns; the next Starlette
  bump will break the test client unless pinned.
- Lower priority: `PUT /api/model` is per-install and any session can change
  it; `generate_with_tools` executes tool calls sequentially even when the
  model emits several independent ones; `_load_tool_descriptions` re-reads
  `tools-spec.md` and rebuilds the schema dicts every turn (cacheable by
  mtime).

## Optimization plan

Suggested order. Every step is covered by the existing backend test suite.

1. **SQLite pragmas, a connection helper and indexes.** Partial index on
   `turns(committed) WHERE embedding IS NOT NULL`; `transcripts(url)`;
   `note_drafts(status, run_id)`; an expression index or stored lowercase
   column for `notes_index.title`.
2. **Vectorized recall** (matrix cache per user DB, top-k root resolution).
   Same treatment for `search_notes_semantic`.
3. **Off-loop handlers**: `async def` to `def` for every handler that calls
   `requests` or fastembed.
4. **A small background job runner** (thread pool plus a status table)
   replacing the three ad-hoc thread patterns (transcribe worker, voice
   preload, in-generator title and embedding work). Attachment ingestion will
   use it too.
5. **Tools registry refactor**: a `tools/` package, one module per tool.
6. **Parallel tool execution** for independent calls within a round.
7. **`/api/tree` diet**: a `?root=` filter, `If-None-Match`/ETag, omit
   `recall_sources` and `tool_activity` until requested. The frontend reloads
   only the affected root.
8. **Split `main.py`** into routers; move note-field code out.
9. **Frontend:** batch tokens on `requestAnimationFrame`; memoize completed
   paragraphs so only the streaming tail re-parses markdown; poll
   `/api/models` at 60 s or on focus; scope tree refetches; gapless TTS via
   PCM and AudioContext.
