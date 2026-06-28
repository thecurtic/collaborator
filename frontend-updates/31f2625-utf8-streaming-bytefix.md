# Frontend Update: UTF-8 Mojibake in Streaming (real fix)

**Commit:** `31f2625`
**Date:** June 28, 2026

## Summary

Mojibake in streamed replies (`donât` for `don't`, `Ã—` for `×`, `â€”`/`â` for `—`)
is fixed at the source. This supersedes the partial fix in `6b9c2ef`.

## Root cause

The LLM SSE stream was decoded as text via `requests`' `decode_unicode`. Two problems:

1. LM Studio sends `text/event-stream` with **no charset**, so `requests` defaults to
   ISO-8859-1 (caught in `6b9c2ef`).
2. Even forcing UTF-8, a multi-byte character whose bytes **straddle a network chunk
   boundary** could be mangled by the line reader — which is why it was *intermittent*:
   `donât` broke but `don't` later in the same reply was fine, depending on where the
   TCP/HTTP chunk happened to split.

## Fix

Parse the SSE stream at the **byte** level:
- `response.iter_lines()` (bytes) — a newline (`0x0A`) can never appear inside a UTF-8
  multi-byte sequence, so splitting on bytes is always safe.
- `json.loads(<line bytes>)` decodes each complete line as UTF-8 correctly.

Verified with a regression test that splits a multi-byte char (`'` = `E2 80 99`)
across two chunks and asserts the output is intact.

## Frontend impact

None — no API change. Token `content` values are now correct UTF-8 in all cases,
which also stops TTS from mispronouncing mangled characters.

## Deploy

Code-only. On prod: `git pull origin main` and restart the backend.

> Note: rows already stored in the DB from before this fix may still contain mojibake
> in their text; this fixes all newly generated responses.

## Related files

| File | Change |
|------|--------|
| `backend/inference.py` | Byte-level SSE parsing in `stream_llm_tokens` |
| `backend/test_inference.py` | Bytes mocks + split-multibyte regression test |
</content>
