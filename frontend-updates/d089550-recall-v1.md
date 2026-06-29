# Frontend Update: Recall (Memory) v1

**Commit:** `d089550`
**Date:** June 29, 2026

## Summary

Recall runs **inside the send**: when enabled, the backend embeds the message,
searches the whole turns DB, synthesizes a first-person memory block, **streams it as
a `recall` SSE event**, and injects it into the model context. Both embeddings and
synthesis go through LM Studio (no new ML deps).

## How to use (frontend)

Send the recall toggle per request (the toggle lives client-side now):

```json
POST /api/messages
{ "message": "...", "parent_turn_id": <leaf>, "recall": true }
```
- `recall: true|false` overrides the server default (`recall.enabled`). Omit to use
  the default. Also accepted on `POST /api/branches/{id}`.

**New SSE event** (arrives before `token` events, only when recall finds matches):
```json
{"type":"recall","content":"<first-person memory block>","sources":[
  {"turn_id":15,"role":"assistant","tags":["decision"],"branch_root_id":1,
   "similarity":0.87,"score":1.305,"preview":"we chose SQLite ..."}
]}
```
Render `content` as the recall block above the response; `sources` gives the matched
turns (with similarity/score/tags and `branch_root_id` so you can show which branch a
memory came from). The block is also injected into the model's context automatically.

## Endpoints

- **`GET /api/recall/current`** → the current (ephemeral) recall block, or `null`.
  It's overwritten on each recall run (so it's the latest one).
  ```json
  { "recall": { "content": "...", "sources": [...], "query": "...", "created_at": "..." } }
  ```
- **`PATCH /api/turns/{turn_id}/tags`** → tag turns to boost them in recall:
  ```json
  { "add_tags": ["decision","concept"], "remove_tags": ["emotion"] }   // -> { "turn_id", "tags": [...] }
  ```
- **`POST /api/recall/reindex`** → backfill embeddings for existing turns (run once
  after enabling recall): `{ "indexed": N, "remaining": M }`.

## Behavior notes

- **Ephemeral**: the recall block is not stored per-turn; only the latest "current"
  block is kept and overwritten each run. Use the `recall` event (live) or
  `GET /api/recall/current`.
- **Context order**: recall → recent window → current message.
- **Best-effort**: if embeddings/synthesis fail (e.g. no embedding model loaded), the
  turn proceeds normally with no recall block — nothing breaks.
- Tag boosts and search depth come from the `recall` config section.

## Deploy / setup

Adds a schema migration (an `embedding` BLOB + a `recall_blocks` table; auto-migrates)
and one Python dep, **`fastembed`** (ONNX, no PyTorch) for local embeddings. To use
recall:
1. `git pull` + `.venv/bin/pip install -r requirements.txt` (adds `fastembed`) +
   `./restart.sh`.
2. Set `recall.enabled: true` (or pass `recall: true` per request).
3. `POST /api/recall/reindex` once to index prior history (now **batched** — fast).

**Embeddings run locally on the backend by default** (`fastembed`,
`BAAI/bge-small-en-v1.5`, downloads ~130MB once). No embedding model needs to be
loaded in LM Studio. To route embeddings through LM Studio instead, set
`recall.embedding_backend: lmstudio` and `recall.embedding_model`. Synthesis always
uses the LM Studio chat model.

## Deferred (phase 2)

Edit-the-recall-block flow (interrupt/restart vs continue-and-replace) and per-turn
recall auditing from `INTENTS.md` are not in v1 — ask if you want them next.

## Related files

| File | Change |
|------|--------|
| `backend/inference.py` | `get_embedding`, `synthesize_recall`, recall in context |
| `backend/db.py` | embeddings (BLOB), cosine search + boosts, tags, recall_blocks |
| `backend/main.py` | recall in send flow + `recall` event; tags/current/reindex endpoints |
| `backend/config.py`, `config.yaml.example` | `recall` config section |
| `API-SPEC.md`, `INTENTS.md` | docs |
</content>
