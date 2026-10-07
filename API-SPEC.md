# Collaborator Backend API Specification

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
  it; returns `{ "turn_id", "name" }`; `404` if the turn doesn't exist).
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

> **Upgrade triggers are the frontend's call.** Typical choices: a conscious user
> "upgrade" action, or automatically when a seed chat is branched from. The backend
> just provides this endpoint — call it whenever your UX decides a seed has become a
> real conversation.

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
  tags?: string | null;
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
  passkeys_db_path: "/home/chat/collaborator/backend/data/authentication/passkeys.db"
  users_dir: "/home/chat/collaborator/backend/data/users"

inference:
  endpoint_url: "http://localhost:1234/v1"
  model_id: "qwen/qwen3-coder-next"
  temperature: 0.7
  max_tokens: 2048
  thinking_mode: false
  streaming: true

memory:
  default_context_window: 5
  db_path: "/home/chat/collaborator/backend/data/conversations.db"

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
  passkeys_db_path: "/home/chat/collaborator/backend/data/authentication/passkeys.db"
  users_dir: "/home/chat/collaborator/backend/data/users"
```

3. Restart backend and test with passkey header

---

## Development Tips

1. **Turn off auth during local dev** - Set `authentication.enabled: false`
2. **Check CORS settings** - Ensure frontend domain is in `cors_origins`
3. **Database paths** - User databases go to `/backend/data/users/{hash}/conversations.db`
4. **Clear localStorage** - Reset passkey when switching environments
5. **Dev vs Prod** - Use different passkeys for dev and production environments
