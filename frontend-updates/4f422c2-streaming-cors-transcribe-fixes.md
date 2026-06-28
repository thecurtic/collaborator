# Frontend Update: Streaming, CORS, and Transcribe Fixes

**Commit:** `4f422c2`
**Date:** June 28, 2026

## Summary

Fixed three production bugs reported from the frontend:

1. **Messages hit the LLM but responses never reached the frontend.**
2. **Audio recording failed with `[Errno 2] No such file or directory: 'whisper'`.**
3. **Call mode could not send audio or stop recording** (downstream of #2).

## Changes

### 1. `/api/messages` now actually returns responses

**Root cause:** the SQLite connection was opened on the request thread but reused
inside the SSE generator, which Starlette runs on a separate worker thread. SQLite
forbids cross-thread use, so the stream crashed **after** emitting tokens but
**before** the `done` event — and before persisting the turn. Nothing was saved and,
behind a buffering proxy, the response could be dropped entirely.

**Fixes:**
- Context is read with a short-lived connection on the request thread; the generator
  opens its **own** connection for persistence on the worker thread.
- **Real token streaming**: tokens are now forwarded as they arrive from the LLM
  (previously the full reply was buffered server-side, then replayed char-by-char).
- Errors mid-stream now emit a proper `error` event instead of silently aborting.

**SSE event shape (unchanged contract, now reliably delivered):**
```
data: {"type":"token","content":"Hello"}
data: {"type":"token","content":", world"}
data: {"type":"done","id":42,"context_turns_used":5}
```

On failure:
```
data: {"type":"error","detail":"<message>"}
```

> Frontend note: render incrementally on `token`, finalize on `done`, and handle
> `error` events. Tokens now arrive incrementally rather than all at once.

### 2. CORS is now enabled

**Root cause:** `CORSMiddleware` was imported but never registered, so browsers on a
different origin than the API were blocked from reading responses.

`CORSMiddleware` is now installed using `server.cors_origins` from `config.yaml`.

> Frontend note: ensure your production origin is listed under `server.cors_origins`
> in `config.yaml` / `.config.yaml`. Default is `http://localhost:3000`.

### 3. `/api/transcribe` fixed

**Root cause:** Whisper was not installed on prod (neither the python module nor the
CLI), and the endpoint fell through to exec a `whisper` binary that did not exist
(`Errno 2`). A latent `NameError` also crashed the happy path when the python module
succeeded.

**Fixes:**
- `openai-whisper` added to `backend/requirements.txt`.
- Control flow rewritten: python module first, CLI fallback, with temp-file cleanup.
- Missing `ffmpeg` or `whisper` now return a clear `500` message instead of a raw
  `Errno 2` / traceback:
  - `"ffmpeg not found on server. Install ffmpeg to enable transcription."`
  - `"Whisper is not installed on the server ... Install 'openai-whisper' ..."`

**Request / response unchanged:**
```http
POST /api/transcribe
X-Passkey: <your-passkey>
Content-Type: multipart/form-data

Form fields: audio (binary, required), language (string, optional)
```
```json
{ "text": "Transcribed text" }
```

### 4. Call mode

Call mode relies on `/api/transcribe` to detect the end phrase
(`voice.voice_end_phrase`, default `"go ahead"`, served via `GET /api/settings`).
With transcribe fixed and CORS enabled, that loop can function. The recording/stop
UI itself lives in the frontend repo — verify there if issues remain.

## Deployment requirement

The audio fixes require both a pip install and a system package on prod:

```bash
cd /home/chat/collaborator
pip install -r backend/requirements.txt   # installs openai-whisper
sudo apt-get install -y ffmpeg            # ffmpeg is a system package, not pip
```

## Testing checklist

- [ ] Send a message → tokens stream incrementally, `done` event arrives, turn persists
- [ ] Cross-origin frontend can read `/api/messages` responses (CORS)
- [ ] `/api/transcribe` returns text for webm/mp4/ogg/wav after deps installed
- [ ] Missing ffmpeg/whisper returns a clear 500 (not a traceback)
- [ ] Call mode detects the end phrase and submits

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | Per-thread DB connections, CORS registration, real streaming, transcribe control flow |
| `backend/inference.py` | New `stream_llm_tokens()` generator for true streaming |
| `backend/requirements.txt` | Added `openai-whisper` |
</content>
