# Frontend Update: Streaming Transcription over WebSocket

**Commit:** `0c9b8e4`
**Date:** June 29, 2026

## Summary

New `WS /api/transcribe/stream` — stream mic audio in, get partial transcripts back
live, and a final transcript the moment the user ends the turn. The one-shot
`POST /api/transcribe` is unchanged for tap-to-record.

## Endpoint

```
WS /api/transcribe/stream?passkey=<passkey>&language=en
```
(`language` optional, defaults to `en`.)

### Chosen audio format

**Raw PCM16, mono, 16 kHz, little-endian** — exactly what you proposed. Capture/
resample via your AudioWorklet and send as binary frames, any frame size. It's fed
straight to Whisper, so no transcode overhead. (If you ever need Opus/WebM instead,
say so — but PCM is the fast path, keep it.)

### Auth

Browsers can't set WebSocket headers, so:
- `?passkey=...` query param, **or**
- first **text** frame `{"passkey":"..."}` before sending audio.

Invalid/missing → `{"type":"error","detail":"Invalid or missing passkey"}` then close.

### Messages

Client → server:
- **binary frames**: PCM16 audio as captured
- **text**: `{"type":"end"}` when the turn ends (your on-device "go" keyword or the
  Done button)

Server → client (text):
```json
{"type":"partial","text":"running transcript so far"}
{"type":"final","text":"final transcript"}
{"type":"error","detail":"..."}
```
- `partial` is emitted roughly every ~2s of received audio (running transcript).
- `final` is sent after `{"type":"end"}`, then the server closes.

### Suggested client flow

1. Open the socket (with `?passkey=`), start the AudioWorklet.
2. Stream PCM16 binary frames; render each `partial.text` as the live transcript.
3. On end-of-turn, send `{"type":"end"}`; use `final.text` as the message, then
   `POST /api/messages` (or `/api/branches/{id}`) with it — pass `mode:"voice"`.

## Notes / limits

- Segmenting is internal (re-transcribes the buffer each interval). Fine for
  call-mode-length turns; we can add an explicit `{"type":"BREAK"}` marker or smarter
  silence-based segmenting later if you want lower latency on long turns.
- This endpoint only transcribes — it does not persist turns or call the LLM. Send
  the final text through the normal message/branch endpoints.

## Deploy

New deps: `numpy`, `websockets` (uvicorn needs `websockets` to serve WS). On prod:
```bash
git pull
.venv/bin/pip install -r requirements.txt   # adds numpy + websockets
./restart.sh
```

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | `WS /api/transcribe/stream`, cached Whisper model, PCM16 transcribe |
| `backend/requirements.txt` | `numpy`, `websockets` |
| `backend/test_stream_transcribe.py` | partial/final + auth tests |
| `API-SPEC.md` | Documented the WS endpoint |
</content>
