# Frontend Update: model load-state in the picker + token-aware context

**Commits:** `bca1dad` (token budget), `f7e235b` (model load state)
**Date:** July 30, 2026

## 1. Model picker: show what's loaded (frontend work requested)

`GET /api/models` is enriched. Same `current` and `available` as before
(nothing breaks), plus:

```json
{
  "current": "minimax-m2.5",
  "available": ["minimax-m2.5", "minimax-m2.5-reap-29-mlx", "qwen/qwen3-32b", ...],
  "models": [
    {"id": "minimax-m2.5-reap-29-mlx", "type": "llm", "state": "loaded",
     "quantization": "4bit", "max_context_length": 196608,
     "loaded_context_length": 196608},
    {"id": "minimax-m2.5", "type": "llm", "state": "not-loaded",
     "quantization": "4bit", "max_context_length": 196608,
     "loaded_context_length": null},
    ...
  ],
  "loaded": ["minimax-m2.5-reap-29-mlx"],
  "current_loaded": false
}
```

What we'd like the picker to do:

- Keep listing **all** models (it already does), but mark the ones in
  `loaded` — a "● loaded" badge / green dot.
- When `current_loaded` is **false**, surface a visible warning near the
  picker: the selected model is NOT resident, so the next message will make
  LM Studio load it — slow, and memory-heavy if another large model is
  already up. (This exact situation caused near-crashes: config selected
  `minimax-m2.5` while `minimax-m2.5-reap-29-mlx` was the loaded one.)
- Optional nice-to-haves from `models[]`: show `quantization` and context
  length in the row; `type` lets you filter out non-chat entries (whisper
  etc.) if you list from `models` instead of `available`.

Notes: load state comes from LM Studio's `/api/v0/models`; on other
OpenAI-compatible endpoints `models`/`loaded` are empty and `current_loaded`
is absent — make no load claims in that case. Selection semantics are
unchanged: `PUT /api/model` remains the way to switch, and it stays entirely
user-driven (we deliberately did NOT auto-follow LM Studio).

## 2. Token-aware context (`bca1dad`, FYI — no frontend work)

Context assembly now trims by **tokens**, not just turns: after the
turns-based window is selected, the oldest turns are dropped until the
estimated prompt fits the active model's real context (read live from LM
Studio, `loaded_context_length` aware, config-overridable via
`memory.context_budget_tokens`). This fixes the crash where a few very long
turns blew past the model's context while still counting as "N turns".

Turn semantics you rely on are untouched: `context_turns` still selects the
window, `context_turns: 0` still means fresh-context (and remains the
context-reset boundary in the tree). Trims are logged server-side; nothing
new in the SSE stream.

## Deploy

Parent `./deploy.sh` on the web-server (pulls + restarts). No config changes
required; `memory.context_budget_tokens` exists as an override for
non-LM-Studio endpoints.
