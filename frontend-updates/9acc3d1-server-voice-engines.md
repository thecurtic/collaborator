# Frontend Update: Server Voice Engines (streaming STT sessions, phrase detection, streaming TTS)

**Commit:** `9acc3d1`
**Date:** July 26, 2026

## Summary

The server voice tier is live: continuous streaming STT sessions with in-stream
phrase detection (end / interrupt), streaming TTS, and capability advertisement
so you can feature-detect all of it in one probe. Your on-device stack stays as
the fallback tier — compose **per engine**, not per mode: use the server engine
where the capability is advertised, on-device otherwise. The TF.js keyword
spotter should be fully retired whenever `stt_stream` is available (phrases ride
the ASR transcript now); it survives only in the all-on-device tier.

## 1. Capability advertisement

`GET /api/health` (still unauthenticated, still cheap — probe once at app load):

```json
{
  "status": "healthy",
  "version": "0.4.0",
  "capabilities": {"stt_stream": true, "tts_stream": true, "phrases": true}
}
```

- `stt_stream` — the WS session protocol below is served.
- `tts_stream` — `POST /api/tts` will synthesize (piper installed + ≥1 voice on disk).
- `phrases` — always equals `stt_stream` (it's pure code on the transcript);
  advertised separately as agreed so your logic stays dumb.

Hide/disable any server engine option whose capability is `false` — those
endpoints return 503 (TTS) or an error-then-close (WS) when unconfigured.

## 2. Streaming STT — WS /api/transcribe/stream

**Superset of the old protocol.** Your current client (stream PCM, send
`{"type":"end"}`, read `partial`/`final`) works unchanged. New: open the socket
**once per listening session**, not per utterance.

Unchanged: ticket auth (`?ticket=` from `POST /api/auth/ws-ticket`), binary
frames of **raw PCM16 mono 16 kHz LE**, `?language=` query param.

### Client → server

```json
{"type": "config", "phrases": [
  {"kind": "end",       "text": "that is all"},
  {"kind": "interrupt", "text": "hold on"}
], "language": "en"}
```
Send right after open (any subset: either kind, both, or none = plain
dictation). May be re-sent mid-session to change phrases. `language` optional.

```json
{"type": "end"}
```
Manual finalize (Done button) — unchanged.

Binary frames: stream continuously for the whole session, including silence.
**Do not gate sending on client-side VAD** — the server's phrase confirmation
needs the quiet audio, and there is deliberately no server VAD endpointing or
idle timeout: thinking pauses never end the turn.

### Server → client

```json
{"type": "partial", "text": "running transcript"}
{"type": "phrase",  "kind": "end"}
{"type": "phrase",  "kind": "interrupt"}
{"type": "final",   "text": "full transcript, end phrase stripped"}
{"type": "error",   "detail": "..."}
```

- `partial`: ~every 400 ms of new audio (decode-time bound, so cadence stays
  flat even in long sessions — old text is committed and never re-decoded).
- `phrase` kind `end`: fired, then `final` follows automatically and the socket
  closes. The end phrase (and a dangling connector comma/dash before it) is
  stripped from `final.text`; sentence punctuation is kept.
- `phrase` kind `interrupt`: fired, **session keeps running** — stop TTS
  playback and keep streaming mic audio. Re-arms only after new speech, so one
  utterance can't double-fire.
- `final` after manual `end`: also strips a trailing end-phrase match if present.

### Phrase detection semantics (what shipped)

**The silence-gated version** (the preferred variant from the ask, not the
fallback): a phrase fires when the **tail** of the running transcript matches it
(normalized: lowercase, punctuation stripped; per-word edit distance ≤ 1 for
words longer than 3 chars, exact for short words) **and** the trailing ~350 ms
of audio is quiet. Quiet is an adaptive RMS check on the raw PCM (relative to
the session's noise floor and speech level) — an energy gate, not a VAD model,
and it only ever *confirms* a matched phrase. Saying the phrase mid-sentence
does not fire (speech continues → no quiet tail → next partial outgrows the
match).

Practical latency: phrase-spoken → `phrase` event ≈ silence gate (350 ms) +
up to one partial cadence. Budget ~0.5–1 s from last word to `final`.

### Accuracy model

Partials use a fast model; the `final` is a fresh pass with a bigger model over
the whole session audio (sessions ≤ 90 s; longer sessions final-decode the tail
and reuse the committed prefix). Expect `final.text` to occasionally differ
from the last partial — always use `final` as the message text.

## 3. Streaming TTS — POST /api/tts

```
POST /api/tts        (X-Passkey auth, like the REST endpoints)
{"text": "...", "voice": "en_US-lessac-medium", "format": "wav"}
```

- `voice` optional → server default. `format`: `"wav"` (default; streaming WAV
  header + PCM16) or `"pcm"` (bare PCM16 LE — feed an AudioWorklet directly).
- Response streams **chunked, sentence by sentence, as it synthesizes** — play
  as it arrives (MediaSource / AudioWorklet), never buffer the full body.
  First audio is typically well under 500 ms warm.
- Headers: `X-Sample-Rate` (per voice, typically 22050), `X-Voice`.
- Errors: 503 not configured, 404 unknown voice, 422 empty text/bad format.

Voice picker:

```
GET /api/tts/voices
→ {"voices": ["en_US-lessac-medium", ...], "default": "en_US-lessac-medium", "enabled": true}
```

## 4. Interrupt + echo caveat

If the mic streams while server TTS plays, the ASR may hear the assistant's own
voice. Keep `echoCancellation: true` on `getUserMedia`. If interrupt phrases
still false-fire from playback bleed in practice, tell us — the server knows the
text it's synthesizing and can suppress matches against it.

## Deploy (backend)

```bash
git pull
.venv/bin/pip install -r requirements.txt    # adds piper-tts
./restart.sh
```

Server config (see `config.yaml.example`): `voice.stt.{partial_model,final_model,preload}`,
`voice.tts.{voices_dir,default_voice,preload}`. With no `voice:` section the
capabilities degrade gracefully (STT streams lazily with default models; TTS is
absent). The old `.config.yaml` `voice.voice_end_phrase` key is dead — phrases
are session config from you now.

## Related files

| File | Change |
|------|--------|
| `backend/voice.py` | New: model registry (locks), StreamSession, phrase matching, RMS gate, Piper adapter, capabilities |
| `backend/main.py` | WS session protocol, `POST /api/tts`, `GET /api/tts/voices`, health capabilities, preload hook |
| `backend/config.py` | `voice:` defaults |
| `backend/test_voice.py` | Session/phrase/TTS/capability tests |
| `config.yaml.example` | `voice:` section |
