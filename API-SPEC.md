# Collaborator Backend API Specification

> **Status (2026-10-12):** hand-maintained and partial: it covers roughly 26
> of the backend's 43 routes. The authoritative reference for the REST routes
> is the OpenAPI schema the running backend serves at `/docs` (interactive)
> and `/openapi.json`, generated from the code and therefore never stale. Use
> this file for what OpenAPI cannot express: the SSE event stream of
> `POST /api/messages`, the WebSocket protocols for voice and streaming
> transcription, and the passkey/session auth flow.

## Overview
Self-hosted personal chat interface backed by local LLM inference. This document defines the REST API endpoints for backend development.

## Authentication (Passkey System)

### Overview
Collaborator uses a passkey system for user database isolation. Each passkey maps to a unique user conversation database.

### Passkey Management (CLI)
Admin generates and manages passkeys via CLI:
```bash
# Generate new passkey
python -m backend.data.passkey generate

# List all passkeys
python -m backend.data.passkey list

# Revoke a passkey
python -m backend.data.passkey revoke <passkey_hash>
```

### Passkey Header
All API requests require the `X-Passkey` header (when authentication is enabled):
```
X-Passkey: <your-passkey-here>
```

### Response (403 Forbidden) - Missing/Invalid Passkey
```json
{
  "detail": "Passkey required"
}
```

### Lockout (429)
Failed passkey attempts back off exponentially **per client address**
(`authentication.lockout_*`): after the threshold, new passkey auth from that
client gets `429` with `Retry-After`; established sessions are never affected,
and other clients are untouched. Behind reverse proxies, list them in
`authentication.trusted_proxies`; only requests from those may name the real
client via `CF-Connecting-IP` or `X-Forwarded-For`. Every passkey-accepting
endpoint, `POST /api/transcribe` included, applies the same check and also
accepts a session.

---

## Base URL
- Development: `http://localhost:8001`
- Production: Configured via `config.yaml`

---

## Endpoints

### 1. Health Check
```
GET /api/health
```

**Response (200 OK)**
```json
{
  "status": "healthy",
  "version": "0.1.0"
}
```

---

### 2. Send Message (Streaming)
```
POST /api/messages
Content-Type: application/json
X-Passkey: <your-passkey>
```

**Request Body**
```json
{
  "message": "string",
  "parent_turn_id": 42,
  "context_turns": 5,
  "commit": true,
  "user_id": "optional-string",
  "mode": "voice"
}
```

**Fields:**
- `message` (required): User's input text
- `state` (optional, new root only): conversation stage for a brand-new chat —
  `"seed"` (default) or `"tree"`. New chats start as **seeds** (they live in the
  new-chats list); promote them to `"tree"` later. Ignored on continuations/branches,
  which **inherit** the parent's state.
- `parent_turn_id` (optional): **The active leaf to continue from.** Context is built
  from this turn's ancestor chain and the new turns chain off it — this is how the
  backend knows which branch is active. **Omit it only to start a fresh root
  conversation** (no prior context). Returns `404` if the id doesn't exist.
- `context_turns` (optional): Prior committed turns to include. **Omitted/null** =
  the configured default window (`memory.default_context_window`). **`0`** = fresh
  context, no history injected (the model gets a clean slate) while the turn is still
  stored and linked in the tree.
- `commit` (optional, default: true): Whether to commit this turn to database
- `user_id` (optional): User identifier
- `mode` (optional): Turn source. `"voice"` = came from call mode (spoken); absent or
  `"text"` = normal chat. On `"voice"` turns the backend augments the system prompt
  with a spoken-style instruction (no markdown/symbols, short sentences) so the reply
  reads well via TTS. Configurable via `system_prompt.voice_text`.
- `recall` (optional): Offer **tools** to the model for this turn (recall is a set of
  tools). `true`/`false` overrides the server default (`tools.enabled`). When on, the
  model may call retrieval/synthesis tools mid-turn (see the tool events below). (Also
  accepted on `POST /api/branches/{id}`.)
- `attachment_ids` (optional, max 10): uploads from `POST /api/attachments` that
  this message carries (also on `POST /api/branches/{id}`); `404` for an unknown
  id. See §22. While the backend waits for an attachment's text it streams
  `{"type":"status","tool":"read_attachment","label":"Reading plan.pdf",...}`
  and then an `"outcome":"ok"` event, before any tokens.

**Tool SSE events** (when tools are on and the model uses them; interleaved before the
final answer tokens):
```
data: {"type":"status","tool":"web_search","label":"Searching the web for “…”…","query":"boe governor 2026"}
data: {"type":"tool_result","tool":"web_search","result":"{...}"}                     // only if tools.show_step_results
data: {"type":"status","tool":"web_search","outcome":"ok","count":5,"label":"Web search returned 5 results."}
data: {"type":"token","content":"We chose "}                                          // final answer
data: {"type":"done", ...}
```
- `status` (start) — a short "what it's doing" note per tool call (`tools.status_notes`).
  Carries structured fields when available: `query` (search tools), `url` (fetch_url),
  `title` (get_note) — render these instead of parsing `label`.
- `status` (outcome) — a follow-up per tool call reporting what it produced, marked by
  the `outcome` field: `"ok"` (with `count` for web_search), `"empty"` (searched,
  genuinely nothing), or `"error"` (with `error` text — e.g. all search engines down).
  Lets the UI distinguish "found nothing" from "search failed" from "never searched".
- `tool_result` — the raw tool output, only when `tools.show_step_results` is on.
- If the model calls the `synthesize` tool, its output is persisted as the turn's
  recall block (see `node.recall` in `GET /api/tree`).
- The old single `recall` event is **removed** — recall is now tool-driven.

**Available tools** (each gated in `tools.available`): `recall_semantic`,
`recall_keyword` (turn history), `synthesize`, `search_notes`, `get_note` (the notes
vault — read-only; `get_note` includes backlinks for graph traversal),
`propose_note` — which **only ever creates a pending draft** in the review inbox
(never the vault; the user approves/rejects as usual; near-duplicates of existing
notes are flagged in the result and on the draft) — `propose_edit`, which proposes
changes to an **existing** note (title/body/tags) as a pending draft of
`kind: "edit"` in the same inbox (see §11; the vault is never edited directly) —
`web_search`, which queries
the private SearXNG instance (`tools.web_search.url`; the tool is offered to the
model only when that URL is configured, and SearXNG must have the `json` format
enabled in its settings.yml) — and `fetch_url`, which reads a specific web page
(pasted links; readable text extraction, `tools.fetch_url.max_chars` cap;
private/tailnet addresses refused unless `tools.fetch_url.allow_private`).

**`drafts_proposed` SSE event** — emitted after the answer streams when the model
called `propose_note` or `propose_edit` during the turn:
```
data: {"type":"drafts_proposed","drafts":[
  {"id":7,"title":"…","run_id":"chat-a1b2c3d4","kind":"new"},
  {"id":8,"title":"…","run_id":"chat-a1b2c3d4","kind":"edit","target_title":"…"}]}
```
Use it to surface a "review drafts" affordance; fetch details via
`GET /api/notes/drafts?run_id=chat-…`. Chat-proposed drafts (both kinds) are
stamped server-side with `source_turns = [<assistant turn id>]` and
`tree_root_id` once the turn persists — no client-side pairing with the `done`
event is needed.

**`unfollowed_links` SSE event** — emitted after the answer when the model wanted to
fetch more pages than the per-turn budget allowed (`tools.fetch_url.max_per_turn`):
```
data: {"type":"unfollowed_links","links":["https://…","https://…"]}
```
The model also lists these in its prose and asks whether to continue. Use the event
to render one-tap follow-ups (a new message = a fresh fetch budget).

**Voice / call mode:** tools are not gated by `mode` — send `recall: true` on voice
turns too and the model can search the web, read pages, recall, and propose note
drafts mid-call (spoken citations by site name; drafts announced verbally).

> Branch model: every continuation should send `parent_turn_id` = the active branch's
> leaf turn. To fork from a mid-conversation turn or a specific paragraph, use
> `POST /api/branches/{id}` instead. The `done` event echoes `parent_turn_id` and
> `context_turns_used`.

**Response (201 Created) - Server-Sent Events**
```
data: {"type":"token","content":"Hi"}
data: {"type":"token","content":" there"}
data: {"type":"done"}

```

**Response Fields (final completion)**
```json
{
  "id": 42,
  "user_id": null,
  "message": "Hello",
  "response": "Hi there! How can I help?",
  "committed": true,
  "context_turns_used": [
    {
      "id": 1,
      "role": "user",
      "content": "Hello",
      "committed": true
    },
    {
      "id": 2,
      "role": "assistant",
      "content": "Hi there!",
      "committed": true
    }
  ],
  "system_prompt": "# Collaborator System Prompt
...",
  "agents_md_content": "...AGENTS.md content..."
}
```

---

### 3. Get Messages
```
GET /api/messages?limit=10&offset=0
X-Passkey: <your-passkey>
```

**Query Parameters:**
- `limit` (optional, default: 10): Number of turns to return
- `offset` (optional, default: 0): Pagination offset

**Response (200 OK)**
```json
{
  "turns": [
    {
      "id": 1,
      "user_id": null,
      "role": "user",
      "message": "Hello",
      "response": "Hi there!",
      "committed": true,
      "context_turns": 5,
      "created_at": "2024-01-01T00:00:00Z",
      "model_name": "qwen/qwen3-coder-next",
      "token_count": 25,
      "tags": null
    },
    {
      "id": 2,
      "user_id": null,
      "role": "assistant",
      "message": "",
      "response": "Hi there! How can I help?",
      "committed": true,
      "context_turns": 5,
      "created_at": "2024-01-01T00:00:01Z",
      "model_name": "qwen/qwen3-coder-next",
      "token_count": 12,
      "tags": null
    }
  ],
  "count": 2
}
```

---

### 4. Delete Turn
```
DELETE /api/messages/{turn_id}
DELETE /api/messages/{turn_id}?subtree=true
X-Passkey: <your-passkey>
```

**Hard delete** — the row is removed from the DB (ids are not reused, so order is
still derivable from id, just with gaps).

**Path Parameters:**
- `turn_id` (required): ID of the turn to delete

**Query Parameters:**
- `subtree` (optional, default `false`):
  - `false` — delete just this turn; its direct children are **reparented to this
    turn's parent** (they rise one level instead of being orphaned).
  - `true` — delete this turn and **all descendants** (a whole branch). This is the
    metro-map "delete branch" action.

**Response (200 OK)**
```json
{
  "id": 45,
  "deleted": true,
  "removed_turn_ids": [45],
  "removed_count": 1,
  "reparented_children": [46, 47],
  "reparented_to": 44
}
```
For a subtree delete, `removed_turn_ids` lists every removed turn and
`reparented_children` is empty. Returns `404` if the turn doesn't exist.

---

### 5. Create Branch (Streaming)
```
POST /api/branches/{parent_turn_id}
Content-Type: application/json
X-Passkey: <your-passkey>
```

Creates a new branch whose fork point is `parent_turn_id` (any user or assistant
turn), then streams the reply as SSE (same event shape as `POST /api/messages`).
The branch inherits context **up to and including** the parent turn (its ancestor
chain), not the global recent history.

**Path Parameters:**
- `parent_turn_id` (required): the turn to branch from (the fork point)

**Request Body**
```json
{
  "message": "what about X instead?",
  "paragraph_index": 1,
  "context_turns": 5,
  "commit": true,
  "user_id": "optional-string",
  "mode": "voice"
}
```
- `message` (required): the first message of the new branch
- `paragraph_index` (optional): which paragraph of the parent turn this branch was
  taken from (0-based, indexes into the parent's `paragraphs[]`). Validated against
  the parent's paragraph count.
- other fields: same as `POST /api/messages`

**SSE events:** `token`, then `done`, e.g.
```
data: {"type":"token","content":"Sure"}
data: {"type":"done","id":51,"user_turn_id":50,"parent_turn_id":42,"paragraph_index":1,"context_turns_used":5}
```

**Errors:** `404` if `parent_turn_id` doesn't exist; `422` if `paragraph_index` is
out of range.

---

### 6. Get Conversation Tree
```
GET /api/tree
X-Passkey: <your-passkey>
```

Returns the full conversation as a nested tree (roots → children) for the
metro-map view.

**Response (200 OK)**
```json
{
  "roots": [
    {
      "id": 1, "role": "user", "content": "Hello", "preview": "Hello",
      "parent_turn_id": null, "paragraph_index": null, "created_at": "...",
      "children": [
        {
          "id": 2, "role": "assistant", "content": "First idea.\n\nSecond idea.",
          "preview": "First idea. Second idea.",
          "paragraphs": ["First idea.", "Second idea."],
          "parent_turn_id": 1, "paragraph_index": null, "children": [ ... ]
        }
      ]
    }
  ],
  "count": 12,
  "context_turns": 5
}
```
Only committed turns are included. Each assistant node carries a derived
`paragraphs[]` array; `paragraph_index` on a node records which paragraph of its
parent it branched from. `preview` is a single-line label.

- Top-level `context_turns` is the default window size (how many recent turns feed
  the next message) — use it to shade the in-context window on the active path.
- Each node also carries its own stored `context_turns` and a `context_boundary`
  boolean (`true` when that turn was generated with `context_turns: 0`, i.e. a
  "branch without context" start). When shading back from the active leaf, stop at
  the most recent `context_boundary` so without-context branches shade correctly.
- `branched` (boolean) is `true` only for turns created via `POST /api/branches` (an
  explicit fork), `false` for `POST /api/messages` continuations. Use it to render the
  fork switcher even when a with-context branch shares the parent of a continuation
  (otherwise the two are structurally identical).
- `state` (string): conversation stage — `"seed"` (a new provisional chat, shown in
  the new-chats list) or `"tree"` (a promoted full conversation, shown in the map).
  Filter the tree by stage with `GET /api/tree?state=seed` (new-chats list) or
  `GET /api/tree?state=tree` (main map). Promote with `PATCH /api/turns/{id}/state`
  (below). All turns in a conversation share the same state (inherited on
  continuation/branch; set across the subtree on promote).
- `name` (string | null): a user-set display name for the turn (used to name a
  conversation/branch by naming its root turn). `null` = unnamed. Set via
  `PATCH /api/turns/{turn_id}/name` with `{ "name": "..." }` (empty/whitespace clears
  it; returns `{ "turn_id", "name", "promoted" }`; `404` if the turn doesn't exist).
  A non-empty name promotes a seed chat (see §9).
- `chat_tags` (string[], present only on ROOT turns that have any): the **chat's
  tags** — see §9a. Distinct from `tags`, the per-turn recall tags.
- `title` (string, present only on ROOT turns that have one): the **auto-generated
  conversation title** — LLM-generated from the conversation after each exchange
  (lazily: regenerated once the tree grows by `titles.regenerate_after_turns`, default
  6). Applies to seeds and trees alike, and survives seed→tree promotion (same root
  row). It is separate from the user-set `name` — render `name ?? title ?? preview`
  so manual renames always win. Force a refresh with
  `POST /api/turns/{turn_id}/title` (any turn id in the tree; resolves to the root;
  returns `{ "root_id", "title" }`; `502` if generation fails). Titles are generated
  *after* the `done` event (never delaying the reply), so a list refresh right after
  a first exchange may briefly show no title. The prompt is editable in
  `title-prompt.md`; disable via `titles.enabled: false`.
- `tools` (array, present only on assistant turns that used tools): the turn's
  persisted tool activity — the same records the `status` start/outcome SSE events
  carried live (0720fd7), so "Sources" works from any device without localStorage:
  ```json
  "tools": [
    { "tool": "web_search", "query": "…", "outcome": "ok", "count": 5,
      "urls": ["https://…", "…"] },
    { "tool": "fetch_url", "url": "https://…", "outcome": "ok" },
    { "tool": "search_notes", "query": "…" }
  ]
  ```
  Fields per record: `tool`, plus `query`/`url`/`title` (what it acted on) and
  `outcome`/`count`/`error`/`urls` (how it went) when the tool reports an outcome.
  `urls` on `web_search` records (and on the live `outcome: "ok"` SSE event) lists
  the result URLs. Records mirror emitted status events, so they exist only when
  `tools.status_notes` is on (default).
- `recall` (object, present only on turns that triggered recall): the recall block
  used for that turn — `{ "content": "...", "sources": [...] }`. This is **per-turn /
  per-branch**, so each branch shows its own recall on load, independent of the latest
  global one. It's stored on the user turn that triggered recall (and removed with the
  turn on delete). The live `recall` SSE event and `GET /api/recall/current` still
  reflect the most recent run.

---

### 7. Streaming Transcription (WebSocket)
```
WS /api/transcribe/stream?ticket=<one-time-ticket>&language=en
```

Stream mic audio in and receive incremental transcripts. (The one-shot multipart
`POST /api/transcribe` still exists for CLI/bulk use; the frontend uses this WS.)

**Auth (preferred): one-time ticket.** Browsers can't set WebSocket headers, so
exchange the passkey for a short-lived single-use ticket over a normal request, then
put the *ticket* (not the secret) in the WS URL:
```
POST /api/auth/ws-ticket        (X-Passkey header)
-> 200 { "ticket": "<random>", "expires_in": 30 }
WS /api/transcribe/stream?ticket=<ticket>
```
The ticket is single-use, expires in ~30s, and only the WS endpoint accepts it — so
the long-lived passkey never lands in a WS URL or proxy logs.

**Tickets are the ONLY auth path.** The deprecated fallbacks (`?passkey=<secret>`
and a first-text-frame `{"passkey":"..."}`) were **removed** — the passkey never
rides a WS URL. Invalid/missing ticket → `{"type":"error"}` then close (1008).
(`POST /api/transcribe` remains available for CLI/bulk transcription.)

**Audio in (binary frames):** raw **PCM16, mono, 16 kHz, little-endian** — sent as
captured (any frame size). This is fed straight to Whisper (no transcode).

**Control in (text frames):**
```json
{"type":"end"}     // user's turn ended (e.g. on-device keyword / Done button)
```

**Server → client (text frames):**
```json
{"type":"partial","text":"running transcript so far"}   // emitted as audio arrives
{"type":"final","text":"final transcript"}              // after {"type":"end"}
{"type":"error","detail":"..."}
```
The server emits a `partial` roughly every ~2s of received audio (re-transcribing the
buffer), sends `final` on `end`, then closes. Segmenting is internal and may change.
A session is capped at `voice.stt.max_session_minutes` (default 120) of audio:
past that it finalizes and closes exactly as if `end` had been sent.

---

### 8. Recall (Memory)

Recall runs **inside the send** when enabled: the message is embedded (locally via
`fastembed` by default; LM Studio `/v1/embeddings` optional), the whole turns DB is
cosine-searched with per-tag boosts, the top matches are synthesized into a
first-person memory block (LM Studio chat, small token budget), streamed as a `recall`
event, and injected into context (recall → window → current). The block is
**ephemeral** — stored as the single "current" recall, overwritten each run.

**`GET /api/recall/current`** → the current block (or null):
```json
{ "recall": { "content": "...", "sources": [ ... ], "query": "...", "created_at": "..." } }
```

**`POST /api/recall/reindex`** → backfill embeddings for committed turns missing them
(run once after enabling recall so prior history is searchable):
```json
{ "indexed": 42, "remaining": 0 }
```

**`PATCH /api/turns/{turn_id}/tags`** → add/remove free-form tags (used for recall
boosts):
```json
// request
{ "add_tags": ["decision", "concept"], "remove_tags": ["emotion"] }
// response
{ "turn_id": 15, "tags": ["concept", "decision"] }
```
`404` if the turn doesn't exist.

---

### 9. Promote a Chat (seed → tree)
```
PATCH /api/turns/{turn_id}/state
{ "state": "tree" }
-> 200 { "turn_id": 12, "state": "tree", "updated_turn_ids": [12,13,14, ...] }
```
Sets the conversation stage for the turn and its **entire subtree**, so promoting a
seed's root promotes the whole conversation. `404` if the turn doesn't exist.

New chats are created as **`seed`** (see `state` on `POST /api/messages`); promote them
to **`tree`** when they become real conversations. Filter the tree by stage with
`GET /api/tree?state=seed` (new-chats list) / `GET /api/tree?state=tree` (main map).

**Promotion is derived from deliberate acts** (UX doc, 2026-10-12): the backend
promotes a seed chat itself when it is **named** (`PATCH /api/turns/{id}/name`,
non-empty), **tagged** (`PUT /api/chats/{id}/tags`, non-empty), **branched**
(`POST /api/branches/{id}`; the new branch is born `tree`), or **synthesized**
(`POST /api/notes/synthesize/{id}`). The state flag is the cache those acts set.
This endpoint remains for explicit changes (including demotion).

---

### 9a. Chats: tags and the card

Chat-level state lives on the chat's ROOT turn; every endpoint here takes any
turn id in the chat and resolves it to the root. Chat tags organize (the chat
list, the card, project membership); they do **not** feed recall.

**`GET /api/chats/{turn_id}`** → the three-dots card:
```json
{ "root_id": 12, "tags": ["project", "garden"],
  "summary": { "text": "Planning raised beds; layout settled.",
               "proposed_tags": ["soil-mix"], "turns": 8,
               "generated_at": "2026-10-12T21:40:00+00:00", "stale": false } }
```
`summary` is `null` until one is generated; `stale` is `true` once the chat has
more committed turns than when it was generated. `404` for an unknown turn.

**`PUT /api/chats/{turn_id}/tags`** `{ "tags": ["Project", "garden"] }` →
replaces the chat's tags (full list; `[]` clears) and returns the card plus
`"promoted"`. Tags are normalized like note tags (lowercase-hyphenated, deduped,
order kept); at most 12. `422` for a type tag (`event`, `social-graph`,
`user-profile` — note types, never chat tags) or too many tags.

**`POST /api/chats/{turn_id}/summary`** → generates (or regenerates) the summary
from the branch through `turn_id` to its most recent leaf (pass the active leaf
inside a chat; from a list, the root gives the branch last worked on) with
`inference.utility_model`, caches it on the root and returns the card. It also
proposes up to 4 tags, steered toward tags already used on notes and chats so a
project's name isn't forked; proposals exclude tags the chat already wears and
type tags, and are **never applied** — the client offers them. Generation is on
demand only, never per turn. `502` when generation fails or returns nothing
(nothing is stored). Prompt: `chat-summary-prompt.md`; config: `chat_summary`.

A root deleted on its own (`DELETE /api/messages/{id}`, no subtree) hands its
chat tags to the children that become roots.

---

### 10. Export a Conversation Tree (notes-pipeline preprocessing)
```
GET /api/tree/{turn_id}/export
X-Passkey: <your-passkey>
```

Exports a conversation as one nested JSON tree, shaped for downstream LLM synthesis
into atomic notes (pure data reshaping — no LLM call). Pass a **root** turn id for a
whole conversation, or any committed turn id for just that **subtree** (e.g. one
branch). This is the user-initiated preprocessing step: export only the trees you
choose.

**Response (200 OK)**
```json
{
  "tree": {
    "id": 1, "parent_turn_id": null,
    "role": "user", "content": "…",
    "created_at": "2026-07-06T10:00:00Z",
    "committed": true, "context_turns": 20,
    "branched": false, "paragraph_index": null,
    "model_name": null, "name": "Database planning", "state": "tree",
    "tags": ["decision"],
    "sibling_index": 0, "sibling_count": 1,
    "children": [ { "…": "nested nodes, same shape" } ]
  }
}
```

Rules:
- **Uncommitted turns are pruned**; their committed descendants are reattached to the
  nearest committed ancestor (`parent_turn_id` on each node is the *effective*,
  post-prune parent).
- **Recall blocks and embeddings are excluded** (derivative content).
- Orphaned turns (broken parent links — only possible via manual DB edits) are
  skipped along with their subtrees.
- `404` if the turn doesn't exist or is uncommitted.

A CLI equivalent exists for offline/bulk use:
`python backend/export_tree.py --db <conversations.db> [--tree-id N] [-o out.json]`
(exports **all** trees as a JSON list when `--tree-id` is omitted).

---

### 11. Note Drafts (curation gate for atomic notes)

Atomic-note drafts (see `NOTES-FORMAT.md`) live in the DB until the user approves
them — **the vault only ever contains approved notes**. Approval validates the title,
stamps frontmatter (`created`, `tags`, `source_turns`), and writes
`<Title>.md` into the vault.

**Synthesize drafts from a conversation tree** (the pipeline bridge):
```
POST /api/notes/synthesize/{tree_id}
-> 200 { "run_id": "run-abc123", "drafts": [ ...pending drafts... ], "count": 2 }
```
User-initiated on a chosen tree: exports the subtree rooted at `tree_id` (a root id =
the whole conversation; any committed turn id = one branch), runs one LLM pass with
the editable `synthesis-notes.md` prompt (structured JSON output), and stores each
resulting note as a **pending draft** grouped under `run_id`. Zero drafts is a valid
outcome. Nothing touches the vault. `404` unknown/uncommitted turn; `502` if the
model call fails. Synchronous — big trees can take a while on local inference
(`notes.synthesis_timeout`, default 300s).

**Dedupe-against-vault** (automatic): the model is shown up to
`notes.dedupe_context_notes` relevant existing notes ("link, don't duplicate"), and
each resulting candidate is checked against the index — near-duplicates (cosine ≥
`notes.dedupe_threshold`, default 0.85) get a `duplicate_of` field on the draft:
```json
"duplicate_of": [ { "title": "SQLite fits this project", "score": 0.91 } ]
```
Candidates are **flagged, never dropped** — surface `duplicate_of` in the review UI
so the user can reject/merge. Empty list = no near-duplicates. The same check runs
when the chat model calls `propose_note`.

**Create a draft** (synthesis output or hand-written):
```
POST /api/notes/drafts
{ "title": "SQLite fits single-user local persistence",
  "body": "distilled prose with [[wikilinks]]…",
  "tags": ["databases", "decision"], "links": [],
  "source_turns": [42, 47], "tree_root_id": 1, "run_id": "run-abc" }
-> 200 { "draft": { "id": 1, "status": "pending", ... } }
```

**Edit drafts (kind: "edit")** — the model can also propose changes to an EXISTING
vault note via the `propose_edit` tool (title/body/tags, any subset). Those arrive in
the **same inbox** as new-note drafts, distinguished by three fields:
```json
{ "id": 9, "kind": "edit", "target_title": "Transit is freedom",
  "title": "Good transit is freedom",        // proposed title (may equal target)
  "body": "…full proposed body…",            // proposed body (snapshot-filled)
  "tags": ["transit", "cities"],             // proposed tags
  "reason": "sharper claim; add cities tag", // model's one-line why
  "status": "pending", ... }
```
- `kind` is `"new"` (default; everything before this feature) or `"edit"`.
- For edit drafts, `title`/`body`/`tags` hold the **full proposed state** of the note
  (fields the model didn't change were snapshot-filled from the current note), so
  render the review as a diff: `target_title`'s current note vs the draft.
- `reason` may be null. Same PATCH-during-review and reject flow as new drafts.

**List / review:**
```
GET /api/notes/drafts?status=pending&run_id=run-abc
-> 200 { "drafts": [...], "count": N }
```

**Edit during review** (pending drafts only; `409` once decided):
```
PATCH /api/notes/drafts/{id}
{ "title"?: "...", "body"?: "...", "tags"?: [...], "links"?: [...] }
```

**Approve** → applies the draft to the vault, returns the note's location:
```
POST /api/notes/drafts/{id}/approve
-> 200 { "draft": {...status:"approved"...}, "path": "...", "filename": "<Title>.md" }
   (edit drafts additionally return "renamed": bool, "links_rewritten": [titles])
```
- kind "new": writes `<Title>.md` with app-stamped frontmatter (existing behavior).
- kind "edit": applies the proposed state to `target_title`'s note through the same
  machinery as `PATCH /api/notes/{title}` — renames rewrite inbound `[[wikilinks]]`
  across the vault and everything is reindexed. Extra `409` case: the target note
  was deleted/renamed since the proposal (`detail` says so) — reject the draft or
  have the model re-propose.
- `422` if the title is empty/too long or contains `/ \ : * ? " < > | # ^ [ ]`
- `409` if a note with that title already exists (case-insensitive) — the draft stays
  pending; rename via PATCH and re-approve.
- Tags are normalized to lowercase-hyphenated; a duplicate leading `# H1` in the body
  is dropped (the file gets exactly one H1 = the title).

**Reject** (kept in the table for audit; never touches the vault):
```
POST /api/notes/drafts/{id}/reject
-> 200 { "draft": {...status:"rejected"...} }
```

Vault location: vaults are **always per-user** — notes never cross passkeys, same
isolation as the conversation DBs. `notes.vault_dir` relocates where vaults live, it
never merges them: under auth each user's vault is `<vault_dir>/<user-hash>`;
without auth it's the vault itself. It's a machine path — set it in `.config.yaml`
(e.g. `/srv/vaults`, then serve `/srv/vaults/<your-hash>` from Obsidian). Unset →
vaults sit next to each user's DB (`users/{hash}/notes`, else `backend/data/notes`).

---

### 12. Notes Index (vault read/search)

A **rebuildable** SQLite index over the vault. Files are the source of truth;
everything graph-relevant (titles, `[[wikilink]]` edges, tags) is derived from note
content alone — never stored index-only — so the index can always be rebuilt from
files, and the graph survives round-trips through other carriers (future Nostr
kind-1 export). Approving a draft indexes the note immediately.

**Reconcile against the vault** (picks up Obsidian edits/renames/deletes; re-embeds
changed notes):
```
POST /api/notes/reindex
-> 200 { "added": 1, "updated": 0, "removed": 0, "total": 12 }
```

**List** (metadata + link edges; optional `?tag=`):
```
GET /api/notes?tag=decision
-> 200 { "notes": [ { "filename", "title", "created", "tags", "source_turns",
                      "links", "content_hash", "mtime" } ], "count": N }
```

**Get one** (case-insensitive title; body + backlinks):
```
GET /api/notes/{title}
-> 200 { "note": { ..., "body": "…", "backlinks": [ ...notes linking here... ] } }
```
`404` if unknown. (Literal routes like `/api/notes/drafts` are matched first.)

**Search**:
```
GET /api/notes/search?q=…&mode=semantic|keyword&limit=10
-> 200 { "results": [ ...notes with "score"... ], "count": N, "mode": "semantic" }
```
`semantic` uses the local embedder (same as recall); `keyword` is lexical over
title/body/tags.

**Edit a note** (body, tags, and/or rename):
```
PATCH /api/notes/{title}
{ "title"?: "New title", "body"?: "new body…", "tags"?: ["decision"] }
-> 200 { "note": { ...updated, with backlinks... },
         "renamed": true, "links_rewritten": ["Alpha"] }
```
- **Rename rewrites inbound `[[wikilinks]]`** across the vault (including
  `[[Old|alias]]` and `[[Old#heading]]` forms) — `links_rewritten` lists the notes
  that were updated. Obsidian-parity per NOTES-FORMAT.md.
- Unknown frontmatter keys and provenance (`created`, `source_turns`) are preserved;
  tags are normalized to lowercase-hyphenated; the note (and rewritten linkers) are
  reindexed immediately.
- `404` unknown note; `422` invalid new title; `409` title collision.

---

### 13. Prompt Visibility (read-only)

Every prompt building block, **as the runtime resolves it right now** — content plus
provenance. Editing is deliberately not exposed (see INTENTS.md).

```
GET /api/prompts            -> { "prompts": [ ... ], "count": N }
GET /api/prompts/{name}     -> { "prompt": { ... } }   (404 if unknown)
```

Entry shape:
```json
{ "name": "tools-guidance",
  "description": "When/how to reach for tools (incl. untrusted-web + citation rules)",
  "applies": "turns with tools enabled",
  "source": "file",                 // file | config | default
  "file": "tools-guidance.md",      // null unless source=file
  "content": "…the exact text the model receives…",
  "note": "optional caveat (e.g. the system prompt is cached until restart)" }
```

Names: `system`, `paragraph-style`, `voice-style`, `tools-guidance`, `tools-spec`,
`synthesis-memory`, `synthesis-web`, `synthesis-notes` (synthesis kinds follow the
config, so new kinds appear automatically).

---

### 14. Model Selection

```
GET /api/models   -> { "current": "qwen/qwen3-coder-next", "available": ["…", "…"] }
PUT /api/model    { "model_id": "qwen/qwen3-30b-a3b", "force"?: false }
                  -> { "model_id": "…", "persisted": true }
```

- `available` is fetched live from the inference endpoint (LM Studio `/v1/models`).
- The switch **applies immediately** (no restart) and **persists** to the gitignored
  `.config.yaml` (machine overrides — never the tracked `config.yaml`), so it
  survives restarts and never collides with git deploys.
- `422` if `model_id` isn't in `available` (the error includes the list); pass
  `force: true` to set it anyway (e.g. the endpoint was momentarily unreachable).
- ⚠️ The model is **per-install**, not per-user: switching changes it for everyone.

```
GET  /api/vision      -> { "chat_model": "…", "chat_model_sees": true, "setting": "auto",
                           "model": "…", "lmstudio_type"?: "vlm" }
POST /api/vision/test -> the same, plus { "ok": true, "expected": "PELICAN 47", "answer": "…" }
                         or { "ok": false, "error": "…" }
```

- One vision path (`backend/vision.py`): images go to the CHAT model.
  `inference.vision` decides whether it can see: `auto` asks LM Studio
  (`/api/v0/models` type `vlm`), `true`/`false` overrides. `model` is who reads
  images: the chat model when it can, else null (no vision). There is no
  second vision model.
- `/api/vision/test` draws a card with a known word, sends it to `model`, and
  reports what came back: proof the image actually reached the model.

> Setup: embeddings run locally on the backend by default (`fastembed`, downloads a
> small model once). Enable via `recall.enabled` or the per-request `recall` flag.
> Synthesis uses the LM Studio chat model. Set `recall.embedding_backend: lmstudio`
> (+ `recall.embedding_model`) to route embeddings through LM Studio instead. Recall
> is best-effort — if embedding/synthesis fails, the turn proceeds without a block.

### 15. Manual Web Search (search screen)

```
GET /api/search?q=<query>&limit=<1-20>
-> 200 {
     "query": "collaborator chat",
     "results": [{"title": "…", "url": "https://…", "snippet": "…", "engine": "mojeek"}],
     "answers":   ["…"],                       // sometimes (SearXNG direct answers)
     "infoboxes": [{"title": "…", "content": "…"}]   // sometimes
   }
```

User-driven search through the same private SearXNG instance the agent's
`web_search` tool uses (same privacy path — queries leave only via the search VM).
**Independent of the LLM tool loop**: works even when `tools.enabled` is false, and
never touches conversations, recall, or the LLM.

- `q` (required): the search query. `400` when blank.
- `limit` (optional): max results, clamped to 1–20; defaults to the server's
  `tools.web_search.results` (5).
- `503` — search not configured on the server (`tools.web_search.url` unset).
- `502` — the search backend failed; `detail` carries the reason, including
  per-engine failures (e.g. `"web search failed — no engines responded (brave:
  too many requests; …)"`). Show it — a failed search must not render as
  "no results".
- Zero hits with a healthy backend is `200 {"results": []}`.

---

### 16. Video Transcripts

Videos transcribed from their audio (the model's `transcribe_video` tool, or a
YouTube link sent to Scratch). Short ones finish in the turn; long ones run in
the background and surface here.

**`GET /api/transcripts`** → `{ "transcripts": [...], "count": N, "vocabulary": [...] }`,
newest first, metadata only (no text):
```json
{ "id": 7, "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Raised beds", "channel": "Garden Answers", "duration_s": 912,
  "status": "done", "error": null, "chars": 14210, "tags": ["project", "garden"],
  "created_at": "2026-10-12 21:00:00", "finished_at": "2026-10-12 21:04:10" }
```
- `tags`: optional, like everything else; `[]` when none. A transcript tagged
  `project` plus a name belongs to that project.
- `vocabulary`: every tag in use across notes, chats and transcripts, most
  used first (for tag completion and near-miss checks).
- `status`: `processing` | `done` | `error` (then `error` holds the reason).
- `channel`: the video's channel/uploader, captured at transcription time
  (null for transcripts made before 2026-10-12).
- `url` is canonical: every YouTube form of a video (youtu.be, `watch?v=`,
  `&t=`, `si=`, shorts, live, embed, m./music.) maps to
  `https://www.youtube.com/watch?v=<id>` and to one row, so re-sending a video
  in another form reads the stored transcript instead of downloading again.
- Optional filters: `?channel=` (case-insensitive substring), `?q=`
  (keywords, all of which must appear in title, channel, tags or text;
  matching rows add a `snippet`) and `?tag=` (exact tag, normalized).

**`GET /api/transcripts/{id}`** → `{ "transcript": {…, "text": "…"} }` with the
full text when done. `404` if unknown.

**`PUT /api/transcripts/{id}/tags`** `{ "tags": ["project", "garden"] }` →
`{ "transcript": {…metadata, no text} }`. Replaces the full list (`[]`
clears). Tags are normalized like chat tags (lowercase-hyphenated, deduped, at
most 12); type tags (`event`, `social-graph`, `user-profile`) are `422`.
`404` if unknown.

**`DELETE /api/transcripts/{id}`** → `{ "deleted": id }`. `404` if unknown.

The model reads the same table through two tools: `list_transcripts` (this
catalogue, freely browsable, with the same query/channel/tag filters) and `read_transcript(id, chunk?, query?)` (paged
by id, never downloads). `transcribe_video` takes a new URL only.


### 17. Notifications

Which kinds notify is a per-user setting in the app; delivery to the phone is
ntfy (a self-hosted server, `notifications.ntfy` in config) and is dormant until
configured. Every notification is stored either way.

**`GET /api/notifications/settings`** → the settings list:
```json
{ "kinds": [ { "kind": "agent_stops", "label": "Agent team stops",
               "description": "…", "default": true, "enabled": true },
             { "kind": "transcript_ready", "label": "Transcript ready",
               "description": "…", "default": true, "enabled": false } ],
  "delivery": { "ntfy": false } }
```
`delivery.ntfy` is true when the server URL and this user's topic are set.

**`PUT /api/notifications/settings`** `{ "enabled": { "transcript_ready": false } }`
→ same shape. Omitted kinds keep their setting; `422` for an unknown kind.

**`GET /api/notifications?limit=50`** → `{ "notifications": [...], "count": N }`,
newest first: `{ id, kind, title, body, link, created_at, delivered }`.
`delivered` is `"ntfy"`, `"not configured"`, `"ntfy failed (<ErrorClass>)"`, or
null while sending. `link` is an in-app path (e.g. `?open=transcript:12`); with
`notifications.app_url` set, tapping the phone notification opens it in the
browser. With `notifications.open_in: app` the ntfy click link is
`collaborator://open/<link>` instead, which the Android shell handles by
loading `<server URL>/<link>` in its own WebView.

**`POST /api/notifications/test`** → `{ "delivered": "ntfy" | "ntfy failed (…)" }`,
bypassing the kind settings; `409` when no delivery is configured.

Producers today: `transcript_ready` (a background transcription finished or
failed). `agent_stops` is listed and on by default but has no producer until
the agent team exists; stops the user caused (the inference switch) are
dropped in Collaborator, never sent.


### 18. Warm Feed

The front door: one list ordered by **warmth**, the later of "last touched"
and "last changed". Nothing is scored; shape weight only breaks ties
(approval > event > merged > chat > transcript > note). Pinned items sit on
top regardless of warmth.

**`GET /api/feed?limit=50`** →
```json
{ "pinned": [ ... ],
  "items": [ { "key": "chat:12", "type": "chat", "title": "Raised beds",
               "subtitle": "last line of the chat", "warmth": "2026-10-13T09:12:03.512000Z",
               "tags": ["garden"], "pinned": false,
               "ref": { "root_id": 12, "leaf_id": 19, "state": "tree" } } ] }
```
Types, what "changed" means, and `ref`:

| type | changed | ref |
|---|---|---|
| `chat` | its newest turn (touched = opened) | `root_id`, `leaf_id`, `state` |
| `note` | an in-app change: approval, edit, rename, or an Obsidian edit seen by reindex. File mtimes never count. Touched = opened (`GET /api/notes/{title}`) | `title` |
| `event` | an event note starting within 14 days; within 24 h of starting it counts as warm *now* on every load, so close events stay near the top | `title`, `start`, `all_day` |
| `approval` | a pending draft's creation | `draft_id`, `run_id` |
| `transcript` | a finished or failed transcription | `transcript_id`, `status` |
| `merged` | merged agent work (no producer until the agent layer exists) | `merged_id`, `project` |

A note never touched or changed in the app doesn't appear. `warmth` is null
for an upcoming event not yet within a day; such items sort last. Pinned items
don't count against `limit`.

**`POST /api/feed/touch`** `{ "key": "chat:12" }` → record that the user opened
it (chats, transcripts, …; notes are touched server-side when read). `422` for
a malformed key (`chat:<id>`, `note:<title>`, `transcript:<id>`,
`approval:<id>`, `merged:<id>`).

**`POST /api/feed/pin`** `{ "key": "note:raised beds", "pinned": true }` → pin or
unpin.

`POST /api/notes/reindex` also returns `updated_titles`: existing notes whose
content changed on disk (these count as changed in the feed; first-time adds
don't).


### 19. Events and recurrence

Event notes (`event` tag) may carry `repeat` and `exceptions` frontmatter
(NOTES-FORMAT.md, Recurrence), written like any typed field through propose
tools, draft edits or `PATCH /api/notes/{title}` `fields` (validated; `""`
clears).

**Calendar windows expand.** `GET /api/notes/search?tag=event&from=&to=` (and
the model's `list_events`) return each **occurrence** of a recurring event in
the window as its own result: `event_start`/`event_end` for that occurrence,
`occurrence` (its original date), `recurring: true`, `moved` (true when an
exception gave it a new time). Cancelled occurrences and ones replaced by a
one-off note are left out (the one-off lists itself). One-off events carry
`recurring: false`. Occurrences are never stored.

**`POST /api/events`** `{ "title": "Seed swap", "start": "2026-10-24T10:00",
"end": "2026-10-24T12:00", "all_day": false, "location"?, "repeat"?, "body"?,
"tags"? }` → `{ "note": {…} }`. Writes an event note **directly**: the
user's own gesture on the calendar (tap or drag a slot, type a title), so no
draft; the review gate is for the model's proposals. Tagged `event` plus any
`tags`; fields validated as everywhere (`422`); `409` for a title already in
use.

**`POST /api/events/import`** `{ "ics": "<file text>", "filename": "work.ics" }` →
each event becomes a **pending draft** (tag `event`, typed fields incl.
`repeat` from RRULE and cancelled `exceptions` from EXDATE), reviewed in the
drafts inbox like any proposal:
```json
{ "run_id": "ics-1a2b3c4d5e6f", "drafts": [ { "id": 41, "title": "Book club" } ],
  "skipped": [ { "title": "Book club", "reason": "a changed occurrence of a repeating event (…)" } ],
  "notes": [ { "title": "Last Friday drinks", "note": "its repeat rule uses parts this calendar can't hold (…)" } ] }
```
Times convert to this server's local wall-clock (UTC `Z`, `TZID` and
floating times). Events already in the calendar (same title and start) are
skipped, so re-importing a file doesn't duplicate. Overrides (`RECURRENCE-ID`)
and rules the format can't hold are reported, not dropped silently. `413` over
2 MB; `422` if it isn't an iCalendar file. A `.ics` sent to Scratch
(`POST /api/scratch/media`, then the act gesture) does the same, with the
proposals on the Scratch card.

**`GET /api/events.ics`** writes a series as ONE VEVENT with `RRULE`,
cancelled/replaced dates as `EXDATE`, and each moved occurrence as an override
VEVENT with the same UID and `RECURRENCE-ID`.


### 20. Projects

A project is whatever wears `project` plus one name tag, notes and chats alike
(chat tags count). The name is inferred by exclusivity in the client (a name
never appears beside another name; kind tags like `bug` span many). When an
unrelated tag behaves like a name, or a real name is missed, the fix is an
override, never retagging:

**`GET /api/projects/overrides`** → `{ "pinned": ["garden"], "ignored": ["urgent"] }`
— pinned tags are always project names, ignored tags never are.

**`PUT /api/projects/overrides`** `{ "pinned": [...], "ignored": [...] }` → replaces
both lists (normalized like tags). `422` if a tag is in both, or for
`project` itself.


### 21. Wallet (the user's own sends and top-ups)

Collaborator's own Lightning wallet (`tools.wallet`), for the user: top it up
and take money out. The model's caps (`max_sats_per_payment`,
`max_sats_per_day`) restrain the MODEL only: a send from here is recorded in
the same ledger (`source: "user"`) but neither checked against the caps nor
counted toward them. Never paying an invoice twice, the park-before-pay
ledger and recovery of an unconfirmed payment apply to every payment.

**`GET /api/wallet`** → `{ "configured": false }` when this user has no wallet; else
```json
{ "configured": true, "provider": "lnbits", "can_pay": true,
  "balance_sats": 21000, "spent_today_sats": 40, "daily_cap_sats": 500,
  "remaining_today_sats": 460,
  "recent": [{ "created_at": "2026-10-15T01:53:00", "provider": "lnbits",
               "amount_sats": 500, "fees_sats": 1, "reason": "...",
               "status": "paid", "source": "user" }] }
```
`spent_today_sats` is the model's spending only. `recent` lists payments OUT
(newest first, 20); `status` is `paid` | `unconfirmed`. When the wallet can't
be asked, the balance fields are missing and `error` says why. `can_pay` is
false for a receive-only wallet (no `admin_key`).

**`POST /api/wallet/decode`** `{ "invoice": "lnbc…" }` → `{ invoice, amount_sats,
amount_msat, description, payment_hash, expires_at?, expired? }` — what the
user is about to pay. `amount_sats` is null for an amountless invoice (which
`send` refuses). `422` for anything that isn't BOLT11. The signature isn't
checked here; the wallet checks it when it pays.

**`POST /api/wallet/send`** `{ "invoice": "lnbc…" }` →
`{ "status": "paid", amount_sats, fees_sats, already_paid, recovered }`, or
`{ "status": "unconfirmed", "detail": "..." }` when the wallet took the payment
but didn't confirm it in time (sending the SAME invoice again checks before it
pays). `422` with `detail` for a definitive refusal (amountless, no spend key,
insufficient balance, ...).

**`POST /api/wallet/receive`** `{ "amount_sats": 5000, "memo": "optional" }` →
`{ amount_sats, invoice, payment_hash, memo }`: an invoice that pays INTO
Collaborator's wallet (1 – 10,000,000 sats; else `422`).

**`GET /api/wallet/invoices/{payment_hash}`** → `{ payment_hash, "paid": true |
false | null }` — `null` when the wallet couldn't be asked. The client polls
this while an invoice is on screen.


### 22. Attachments

Files handed to a chat (`backend/attachments.py`). Every file is stored on the
server (content-addressed under the user's data directory), so every device
sees it. Its text is extracted ONCE in the background and stored with it:

| kind | how its text is read (`text_via`) |
|---|---|
| `text` | the file, as UTF-8 (`text`) |
| `document` | markitdown: DOCX, PPTX, XLSX, HTML, EPUB, CSV, JSON, … (`markitdown`) |
| `pdf` | pypdfium2's text layer; pages without one (scans) go to the vision model (`pdf-text`, `pdf-text+vision`) |
| `image` | the vision model transcribes the text and describes the rest (`vision`) |
| `audio`, `video` | speech-to-text (`speech-to-text`) |
| `file` | nothing (`text_status: "none"`) |

The vision model is the chat model (§14, `inference.vision`). An image's text is
read once the turn that carried it has been answered (the model reads the image
itself on that turn); when the chat model can't see, it's read at upload instead.

**`POST /api/attachments`** (multipart, field `file`) → `{ "attachment": {...} }`,
at once, with `text_status` `pending` (or `done` when the same bytes were
uploaded before: identical content is one attachment). `413` over
`attachments.max_mb`.

```json
{ "id": 7, "created_at": "2026-10-15T10:02:11", "filename": "plan.pdf",
  "mime": "application/pdf", "size": 48211, "kind": "pdf",
  "text_status": "done", "text_error": null, "text_via": "pdf-text",
  "pages": 3, "chars": 5120, "first_turn_id": 88 }
```
`text_status`: `pending` | `working` | `done` | `failed` (see `text_error`) |
`none` (nothing to read, or an image with no model that reads images).
`first_turn_id` is the user turn that first carried it (null = not sent yet).

**`GET /api/attachments`** `?q=&kind=&limit=` → `{ "items": [...] }`, newest first;
`q` keywords match the filename and the extracted text (matches carry `snippet`).

**`GET /api/attachments/{id}`** → `{ "attachment": {..., "text": "..."} }`.

**`GET /api/attachments/{id}/file`** → the bytes. Images, audio, video, PDF and
plain text render inline; anything else (HTML, SVG, ...) downloads as
`application/octet-stream`, always with `Content-Security-Policy: sandbox`.

**`POST /api/attachments/{id}/extract`** → read it again (after a failure, or once
a model that reads images is loaded); returns at once, poll for the result.

**`DELETE /api/attachments/{id}`** → `{ "deleted": id }` for an upload that was never
sent; `409` once a chat carries it.

**In a turn.** The user turn stores the user's own words plus a snapshot list,
`attachments: [{id, filename, mime, kind, size}]` (on `/api/tree` nodes). At send
time each attachment joins the message the model sees: an image AS AN IMAGE when
the chat model reads images, everything else as a header line
`[Attachment #7: plan.pdf — pdf, 47.1 KB, 3 pages]` plus its text up to
`attachments.inline_chars`. In later turns' history they are always text, up to
`attachments.history_chars`. The tools `list_attachments` and `read_attachment`
(paged) reach any attachment from any chat.

### 23. Scratch

Notes to self, in their own table: no conversation-agent surface can read it.
Capture is inert; only the act (hold-send) gesture shows an item to a model.

**`POST /api/scratch`** `{ "content": "…" }` → `{ "item": ScratchItem }` (kind
`text` or `url`). **`POST /api/scratch/media`** multipart `file` + optional
`content` (caption) → `{ "item" }` (kind `image` | `audio` | `video` | `file`).

**`GET /api/scratch?limit=50&before=<id>&q=<text>&type=<filters>`** → the
stream, newest first, unpinned items only: `{ "items": [...], "count": N,
"pinned": [...] }`. `pinned` (every pinned item, most recently pinned first)
comes only on the first page (no `before`) and obeys the same `q` and `type`.
`type` is a derived filter, comma-separated: `links` (url), `photos` (image,
video), `documents` (file), `text`, `voice` (audio); `422` for anything else.
A transcription event whose transcript finished leaves the list unless it is
pinned; a failed one stays.

**`PATCH /api/scratch/{id}`** `{ "llm_readable"?: bool, "pinned"?: bool }` →
`{ "item" }`; `422` when neither is given.

**`GET /api/scratch/{id}/media`** → the file (passive types inline, everything
else as a download). **`GET /api/scratch/{id}/preview/icon`** and
**`/preview/image`** → a link item's stored favicon or YouTube thumbnail
(`404` when there is none). **`DELETE /api/scratch/{id}`** → `{ "deleted": id }`.
**`POST /api/scratch/{id}/act`** → `{ "item" }` after the one-shot action.

ScratchItem: `{ id, created_at, kind, content, media_path, media_mime,
media_size, media_hash, transcript, status, llm_readable, action_result,
draft_id, transcript_id, pinned, pinned_at, media_name, draft_status,
transcript_status, transcript_title, transcript_channel, preview_status,
preview_title, preview_site, preview_icon, preview_image }`. `media_name` is
the uploaded file's own name. The `preview_*` fields are a link's preview
(null when there is none): `preview_status` `pending` | `done` | `failed`;
`preview_title` the page title (og:title first) or the video title,
`preview_site` the site name or the video's channel, `preview_icon` /
`preview_image` whether a favicon / thumbnail is stored. Previews are fetched
once per URL in the background on capture (or when an older link is first
listed), through the same exit and guards as `fetch_url`;
`scratch.link_previews: false` turns them off. `transcript` is text read from the
item (speech-to-text, or a photo/PDF/document read on hold-send);
`transcript_status` is the linked transcription job's state (`processing`,
`done`, `failed`).

### 24. Inference switch (the gate)

The top-bar switch flips the inference gate on the Mac (`gate/`, its own
contract in `gate/docs/CONTROL_API.md`) between serving Collaborator only
(paused: the agents' requests are held) and serving all requests.
Collaborator keeps calling LM Studio directly; the backend holds the gate's
token (`inference.gate.token`) and never sends it to the browser.

**`GET /api/gate`** → `{ "configured": false }` when `inference.gate.url` is
unset (no switch shown); otherwise `{ configured: true, online: true, paused,
paused_since, queued, in_flight, api_version, warning? }`, or `{ configured:
true, online: false, error }` when the gate can't be reached or refuses the
token. Never an error status: a gate failure must not block anything.

**`PUT /api/gate`** `{ "paused": bool }` → the same object after the flip;
`409` with no gate configured, `502` when it can't be reached. Install-wide.

### 25. Unified search

One search over the user's own world: chats, notes (events included),
Scratch, transcripts and attachments, grouped by pile. In-screen search bars
use the same search scoped to their pile. **The user's search, not the
model's:** it includes Scratch, so it is never offered as a tool or used for
recall. Keyword matching, no model involved.

**`GET /api/find?q=<words>&scope=<piles>&limit=5`** → `{ q, groups: [{ scope,
total, items }] }`, piles in the order chats, notes, scratch, transcripts,
attachments, empty ones left out. `scope` (comma-separated) narrows it;
`limit` (1–100) is per pile; `422` for an unknown pile.

An item: `{ type: "chat"|"note"|"scratch"|"transcript"|"attachment", id, title,
snippet, when, tags? }`. A chat is one result per conversation (`id` the root,
`turn_id` its best-matching turn, `matches` how many turns matched; its name
and chat tags match too). A note's `id` is its title. Scratch matches every
word against the text, what was read from it, the file name and a link's page
title (the Scratch list's own `?q=` works the same way). Attachments carry
`kind`, `mime` and `size`.

## Data Models

### Turn
```typescript
interface Turn {
  id: number;
  user_id?: string | null;
  role: 'user' | 'assistant';
  message: string;        // For user: input text, for assistant: empty
  response: string;       // For user: empty, for assistant: model output
  committed: boolean;
  context_turns: number;
  created_at: string;     // ISO 8601 format
  model_name?: string | null;
  token_count?: number | null;
  tags?: string | null;             // per-turn recall tags
  chat_tags?: string[];             // tree roots only: the chat's tags (§9a)
  parent_turn_id?: number | null;   // fork point (null = root); chains form the tree
  paragraph_index?: number | null;  // which paragraph of the parent this branched from
  paragraphs?: string[];            // assistant turns only: content split on blank lines
}
```

---

## Error Handling

All errors return JSON with appropriate HTTP status code:

```json
{
  "detail": "Error message describing what went wrong"
}
```

| Status Code | Description |
|-------------|-------------|
| 200 | Success (GET) / OK (DELETE) |
| 201 | Created (POST) |
| 403 | Forbidden - Missing or invalid passkey |
| 404 | Not Found - Resource doesn't exist |
| 500 | Internal Server Error |

---

## Request Flow

1. **Client sends message** → POST `/api/messages` with `X-Passkey` header
2. **Backend validates passkey** (if auth enabled)
3. **Backend processes:**
   - Retrieves recent committed turns for context
   - Calls LLM with prompt + context
   - Saves user turn to database
   - Saves assistant response to database
4. **Returns response** → JSON with new turn ID and response text

---

## Configuration (config.yaml)

```yaml
# Enable passkey authentication
authentication:
  enabled: false
  passkeys_db_path: "/path/to/collaborator/backend/data/authentication/passkeys.db"
  users_dir: "/path/to/collaborator/backend/data/users"

inference:
  endpoint_url: "http://localhost:1234/v1"
  model_id: "qwen/qwen3-coder-next"
  temperature: 0.7
  max_tokens: 2048
  thinking_mode: false
  streaming: true

memory:
  default_context_window: 5
  db_path: "/path/to/collaborator/backend/data/conversations.db"

server:
  backend_host: "0.0.0.0"
  backend_port: 8001
  cors_origins:
    - "http://localhost:3000"
    - "https://your-domain.com"

system_prompt:
  text: "You are Collaborator, a helpful assistant."
```

---

## Notes for Frontend Developers

1. **Passkey Requirement**: All endpoints require `X-Passkey` header when authentication is enabled
2. **Database Isolation**: Each passkey has its own conversation database - no cross-user visibility
3. **Initial Setup**:
   - Admin generates passkey via CLI: `python -m backend.data.passkey generate`
   - Share passkey with user via secure channel
4. **Error Handling**:
   - 403 Forbidden = missing or invalid passkey
   - Always include `X-Passkey` header on all requests
5. ** revocation**: Admin can revoke passkeys via CLI, invalidating all devices using that key

---

## Frontend Integration Guide

### 1. Storing Passkeys
- Store passkey in browser localStorage or session storage
- Consider encrypting if storing long-term

### 2. Passing Passkey on Requests
```typescript
// Example: API client setup
const PASSKEY = localStorage.getItem('collaborator_passkey');

async function apiRequest(endpoint: string, options?: RequestInit) {
  const headers = new Headers(options?.headers);
  if (PASSKEY) {
    headers.set('X-Passkey', PASSKEY);
  }
  
  const response = await fetch(`http://localhost:8001${endpoint}`, {
    ...options,
    headers
  });
  
  if (response.status === 403) {
    // Passkey invalid - prompt user to re-authenticate
    handlePasskeyError();
  }
  
  return response;
}
```

### 3. Authentication Flow

**When auth is DISABLED (default):**
- Passkey header can be omitted
- All users share same database

**When auth is ENABLED:**
- Passkey required on ALL endpoints
- Missing/invalid passkey = 403 Forbidden
- Show clear error: "Invalid or expired passkey. Please contact admin."

### 4. Passkey Input UI

```tsx
interface PasskeyModalProps {
  onVerify: (passkey: string) => Promise<boolean>;
}

function PasskeyModal({ onVerify }: PasskeyModalProps) {
  const [passkey, setPasskey] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Store passkey
    localStorage.setItem('collaborator_passkey', passkey);
    
    // Verify with backend
    const isValid = await onVerify(passkey);
    
    if (!isValid) {
      setError('Invalid passkey. Please try again.');
      localStorage.removeItem('collaborator_passkey');
    }
  };

  return (
    <div className="passkey-modal">
      <form onSubmit={handleSubmit}>
        <h2>Enter Passkey</h2>
        <input
          type="password"
          value={passkey}
          onChange={(e) => setPasskey(e.target.value)}
          placeholder="Enter passkey..."
        />
        {error && <p className="error">{error}</p>}
        <button type="submit">Enter</button>
      </form>
    </div>
  );
}
```

### 5. Error Handling

```typescript
// Handle passkey errors globally
async function handleApiError(response: Response) {
  if (response.status === 403) {
    const errorData = await response.json();
    
    if (errorData.detail?.includes('passkey')) {
      // Clear passkey and redirect to auth screen
      localStorage.removeItem('collaborator_passkey');
      window.location.href = '/auth';
    }
  }
  
  throw new Error(`API error: ${response.status}`);
}
```

### 6. Testing Locally (Auth Disabled)

1. Ensure `config.yaml` has:
```yaml
authentication:
  enabled: false
```

2. Requests will work without passkey header

### 7. Testing with Auth Enabled

1. Generate passkey on backend:
```bash
python -m backend.data.passkey generate
```

2. Enable auth in config:
```yaml
authentication:
  enabled: true
  passkeys_db_path: "/path/to/collaborator/backend/data/authentication/passkeys.db"
  users_dir: "/path/to/collaborator/backend/data/users"
```

3. Restart backend and test with passkey header

---

## Development Tips

1. **Turn off auth during local dev** - Set `authentication.enabled: false`
2. **Check CORS settings** - Ensure frontend domain is in `cors_origins`
3. **Database paths** - User databases go to `/backend/data/users/{hash}/conversations.db`
4. **Clear localStorage** - Reset passkey when switching environments
5. **Dev vs Prod** - Use different passkeys for dev and production environments
