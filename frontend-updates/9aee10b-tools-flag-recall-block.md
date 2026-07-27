# Frontend Update: `tools` flag (decoupled from recall) + recall block on semantic fires

**Commit:** `9aee10b`
**Date:** July 27, 2026

## Why

The `recall: true` request flag has been gating the ENTIRE tool loop since
`c5c3b5b` — web search, notes, fetch, everything — under a name that suggests
it only controls memory lookup. That mislabel caused a full tool outage (the
flag stopped being sent; every tool silently died). This update names things
what they are.

## 1. `tools` request flag (BREAKING-ish: migrate when convenient)

`POST /api/messages` and `POST /api/branches/{id}` now accept:

```json
{"message": "...", "tools": true}
```

- `tools: true|false` — offer the model its tools this turn (all of them).
- `recall` still works as a **deprecated alias**, honored only when `tools` is
  omitted. Precedence: `tools` > `recall` > server default (`tools.enabled`).
- Migrate the UI toggle to send `tools`, and **label it as tool-calling**
  ("Tools" / "Agent mode"), not "Recall" — it switches the whole agent.
- Note: an explicit `false` always wins over the server config. If the toggle
  should mean "use the server default", send nothing instead of `false`.

The server default is now `tools.enabled: true` in prod config, so omitting the
flag entirely also works.

## 2. `recall_block` SSE event — show it when debug tools are on

Whenever a turn ends up with a recall block, the message stream now includes
(after tool activity, before `done`):

```json
{"type": "recall_block",
 "content": "Recalled 3 related turn(s) by semantic similarity (cosine over embeddings):\n- (user, score 0.82) ...",
 "sources": [{"turn_id": 12, "role": "user", "score": 0.82, "preview": "...", ...}]}
```

Two flavors, same shape:
- Model called `synthesize` → `content` is the synthesized first-person memory.
- Model ran `recall_semantic` but skipped `synthesize` → `content` is a
  rendered list of the raw matches (no extra LLM cost). **Every semantic fire
  now produces a block** — display it when the settings' debug tools are
  toggled on (display gating is yours; the backend always sends it).

Persistence unchanged in shape: `node.recall = {content, sources}` on the
triggering user turn in `GET /api/tree`, and `GET /api/recall/current` is
**alive again** (it had returned `null` since the tool-loop migration — if you
dropped it, `node.recall` remains the canonical per-branch source).

## 3. Tool naming the model sees (FYI, no frontend work)

`recall_semantic` and `recall_keyword` are now explicitly described to the
model as two distinct methods: cosine similarity over embeddings (by meaning)
vs literal term match (by wording). If you label tool activity in the UI,
"Semantic recall" / "Keyword recall" match the semantics.

## Deploy

`git pull && ./restart.sh` on the backend. Config: ensure `tools.enabled: true`
(added to prod config during the outage diagnosis).
