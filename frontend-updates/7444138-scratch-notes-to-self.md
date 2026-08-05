# Frontend Update: Scratch (notes-to-self) — backend live, UI is yours

**Commit:** `7444138`
**Date:** August 5, 2026

Your original instinct won: scratch is a **separate resource**, fully outside
the graph and invisible to the conversation agent by construction. The pipe is
inert by default; the LLM touches an item only on the explicit hold-send
gesture. Everything below is live.

## Endpoints

```
POST   /api/scratch                {"content": "text or URL"}        → {item}
POST   /api/scratch/media          multipart: file, content?         → {item}
GET    /api/scratch?limit&before&q                                   → {items}
GET    /api/scratch/{id}/media     (authenticated media serving)
PATCH  /api/scratch/{id}           {"llm_readable": bool}            → {item}
DELETE /api/scratch/{id}
POST   /api/scratch/{id}/act       (the hold-send gesture)           → {item}
```

Item shape:

```json
{"id": 12, "created_at": "...", "kind": "text|url|image|audio|video|file",
 "content": "...", "media_path": "...", "media_mime": "...", "media_size": 123,
 "media_hash": "sha256…", "transcript": null,
 "status": "inert|pending|committed|done|refused",
 "llm_readable": false, "action_result": null, "draft_id": null,
 "transcript_id": null}
```

- `?q=` searches content **and** stored transcripts. `?before=<id>` pages older.
- Media is content-addressed (sha256): duplicate captures share one file;
  `media_hash` is stable — cache thumbnails by it.

## The gestures (per the agreed spec)

- **Tap send** → `POST /api/scratch` (or `/media`). Inert forever. Zero model
  contact — a Bitcoin address must be able to pass through untouched.
- **Hold send** → capture first, then `POST /api/scratch/{id}/act`. Show a
  processing state on the card; the response's `action_result` decides the
  card variant (below). Text/URL actions are synchronous (a few seconds);
  long YouTube videos return `status: processing` inside a `transcript`
  result — same background-jobs pattern as `/api/transcripts`.
- **Mic gestures** are frontend-side per the spec: tap-mic = live
  transcription into the compose field (existing WS session, no phrases
  config); swipe-mic = record raw audio → tap-send posts audio via `/media`,
  hold-send posts then `/act` (backend transcribes server-side, then acts).

## Card variants by `action_result.kind`

| kind | card |
|---|---|
| `proposed` | **Pending card** — render `draft_title`, `note`, and the draft's typed fields (fetch `GET /api/notes/drafts?run_id=scratch-{id}` or by `draft_id`). **Approve button → the NORMAL `POST /api/notes/drafts/{id}/approve`**; reject → `.../reject`. After either, re-fetch the item: `status` becomes `committed` (or back to `inert`) automatically — state derives from the draft, no extra call. |
| `transcript` | Link card + "transcript ready / transcribing…" via `transcript_id` → `GET /api/transcripts/{id}` |
| `chat_suggestion` | Card with the model's `note` + a **"Start chat" button** → navigate to the new-chat area with the item's content prefilled as the first message |
| `flagged` | Quiet card: the model's one-line `note` ("left as a note"). `status: refused` |
| `secret` | Same, but from the hard guard — the value is never echoed in the note |
| `unsupported` | Media actions (images/video) aren't wired yet — honest note |
| `error` | Show `note`; item stays inert, retry allowed |

Pending is a **permanent valid resting state** — no expiry, no nagging.

## Two integration obligations

1. **Drafts inbox filter:** scratch-born drafts have `run_id` starting
   `scratch-` — **exclude them from the drafts inbox**; they render on their
   card only. One `startsWith` check.
2. **`llm_readable` badge + toggle:** show which items the LLM has seen
   (actions set it true automatically); the PATCH endpoint lets the user
   toggle it. v1 it's transparency bookkeeping; it becomes a retrieval gate
   for future features, so wire the toggle now.

## Guarantees you can build UX copy on

- Inert items: zero model invocations, ever (tested: the embedder is
  poisoned in tests and capture still works).
- Secrets (BTC/ETH/SSH/PGP/API-key/JWT formats): hold-send refuses before
  any model contact and never echoes the value.
- The conversation agent cannot see the scratch stream (separate table — its
  retrieval queries physically can't reach it).
- Approval is the same machinery as the notes inbox: validation, typed
  fields, dedupe warnings, wikilink rewriting all apply.

## Deploy

Parent `./deploy.sh`. New table + media dir create themselves. Config knobs:
`scratch.max_media_mb` (50), `scratch.action_prompt_file`
(`scratch-action-prompt.md`, hot-editable).
