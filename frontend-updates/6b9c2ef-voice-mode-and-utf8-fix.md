# Frontend Update: Voice Mode System Prompt + UTF-8 Fix

**Commit:** `6b9c2ef`
**Date:** June 28, 2026

## Summary

1. `POST /api/messages` now accepts an optional `mode` field. On `mode: "voice"`
   the backend augments the system prompt for spoken-style output (TTS-friendly).
2. Fixed UTF-8 mojibake in streamed responses (`—` was arriving as `â€”`, `×` as `Ã—`).

## 1. Voice mode (`mode` field)

`POST /api/messages` request body now supports:

```json
{ "message": "...", "mode": "voice" }
```

- `"voice"` = turn came from call mode (spoken). Absent or `"text"` = normal chat.
- On voice turns, the backend appends a spoken-style instruction to the system prompt:
  plain prose, no markdown / headings / bullets / code / symbols, short sentences.
- It is **per-turn**, so the prompt branches on exactly the voice turns.
- Backward compatible: the field is optional and unknown values fall back to text behavior.

This matches the frontend contract (call mode sends `"mode": "voice"`; text chat sends
nothing or `"text"`).

**Configurable:** the spoken-style text can be overridden in `config.yaml`:

```yaml
system_prompt:
  voice_text: "Speak in plain conversational prose with no markdown or symbols."
```

If unset, a sensible default is used.

## 2. UTF-8 mojibake fix

**Root cause:** LM Studio streams `text/event-stream` with no `charset`, so the
`requests` library decoded the body as ISO-8859-1 (the RFC default). UTF-8 byte
sequences were mangled — e.g. `—` (em dash) → `â€”`, `×` → `Ã—`.

**Fix:** the streaming reader now forces `response.encoding = "utf-8"` before decoding,
and the system-prompt file is read with `encoding="utf-8"`. Streamed tokens now contain
correct characters. (The non-streaming JSON paths were already correct.)

> Frontend note: no change required. Token `content` values are now correct UTF-8;
> this also fixes TTS mispronouncing mangled characters.

## Testing checklist

- [ ] `mode: "voice"` → reply is plain spoken prose (no markdown/symbols)
- [ ] `mode: "text"` / omitted → unchanged behavior
- [ ] Streamed replies containing `—`, `×`, em dashes, accents render correctly
- [ ] (optional) `system_prompt.voice_text` override is respected

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | `UserMessage.mode` field, pass `mode` to streaming, UTF-8 file reads |
| `backend/inference.py` | Voice-style system prompt branch, force UTF-8 on the stream |
| `backend/config.py` | Read system-prompt file as UTF-8 |
| `API-SPEC.md` | Documented the `mode` field |
| `config.yaml.example` | Documented `system_prompt.voice_text` |
</content>
