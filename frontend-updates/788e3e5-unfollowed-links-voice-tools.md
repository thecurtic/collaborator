# Frontend Update: unfollowed_links Event + Tools in Call Mode

**Commit:** `788e3e5`
**Date:** July 7, 2026

## 1. New SSE event: `unfollowed_links`

When the model hits the per-turn fetch budget with links it still wanted to read,
you'll get (after the answer tokens, before `done`):

```json
{"type":"unfollowed_links","links":["https://example.org/a","https://example.org/b"]}
```

- The model also lists these links in its prose and asks whether to continue — the
  event exists so you can render **one-tap follow-ups** (e.g. buttons per link, or a
  "continue reading" action that sends a message like "yes, follow those links").
- A new user message starts a **fresh fetch budget**, so approval is just a reply —
  no new endpoint.
- Absent when the budget wasn't exceeded. Read tolerantly.

## 2. Call mode: enable tools

Tools were never gated by `mode` — but call mode only gets web search, page
fetching, recall, and note proposals if the voice turn **sends `recall: true`** on
`POST /api/messages` (same flag as text). Action: include it in call-mode requests
(or rely on the server default `tools.enabled` once flipped on).

Voice-specific behavior is handled server-side via the voice prompt layer: spoken
citations by site name (no URL read-outs), proposed drafts announced verbally
("a draft note is waiting in your inbox"), unfollowed links mentioned in speech.
`status` / `drafts_proposed` / `unfollowed_links` events still arrive on voice turns
— render or ignore as fits the call UI.

## 3. Citations (no action, expectation-setting)

The model is now instructed to always attribute web-derived facts inline (domain or
URL in text; site name in voice). If answers cite sources more visibly, that's
intended.

## Deploy

Code + prompt files only, no deps, no schema change. `git pull` + `./restart.sh`.

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | denied-fetch tracking + `unfollowed_links` event |
| `tools-guidance.md` / `voice-style.md` | citations mandate; voice tool behavior |
| `API-SPEC.md` | event + call-mode contract |
</content>
