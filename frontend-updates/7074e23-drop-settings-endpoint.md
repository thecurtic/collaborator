# Frontend Update: Removed /api/settings (voice_end_phrase)

**Commit:** `7074e23`
**Date:** June 28, 2026

## Summary

The frontend moved end-of-turn / "stop" keyword detection on-device (TF.js
speech-commands), so the end phrase is now a client-side setting. The backend no
longer needs to store or serve it.

## Changes (BREAKING for any client still calling settings)

**Removed:**
- `GET /api/settings`
- `PATCH /api/settings`
- `SettingsResponse` model and the `voice_end_phrase` config / `voice:` section handling

These endpoints are gone — calls will now return **404**. The frontend already stopped
calling them, so no frontend change is required.

## Retained

- `POST /api/messages` still reads the optional `"mode": "voice"` field and branches
  the system prompt to spoken style on voice turns. **This is unchanged and still
  important** for clean, TTS-friendly output. (See `6b9c2ef`.)

## Note on the mojibake heads-up

The UTF-8 mojibake (`Ã—` for `×`, `â€”` for `—`) was already fixed in `6b9c2ef`:
LM Studio streams `text/event-stream` with no charset, so `requests` decoded it as
ISO-8859-1. The stream is now forced to UTF-8. If it still appears, prod just needs to
pull the latest `main`.

## Current endpoint surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check |
| POST | `/api/messages` | Send message (SSE stream); supports `mode: "voice"` |
| GET | `/api/messages` | History |
| DELETE | `/api/messages/{turn_id}` | Discard a turn |
| POST | `/api/transcribe` | Audio → text |

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | Removed settings endpoints, model, and voice-phrase helpers |
</content>
