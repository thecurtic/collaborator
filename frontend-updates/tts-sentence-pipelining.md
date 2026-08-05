# Frontend Spec: sentence-pipelined TTS (speak while the reply streams)

**Date:** August 5, 2026 (no backend change — `POST /api/tts` already supports this)

## The problem

In call mode, TTS currently starts after most/all of the reply has streamed.
Perceived silence = model generation time + synthesis. Target: **first audio
within ~1–2s of the first tokens**, then gapless speech that stays ahead of
generation.

## The algorithm

Maintain per-reply state: `textBuffer`, `sentenceQueue`, `audioQueue`,
`scheduledUntil` (AudioContext clock time).

1. **Accumulate** `token` events into `textBuffer` (voice turns only).
2. **Flush a sentence** whenever the buffer contains a boundary:
   - regex like `/([.!?…]+["')\]]?)(\s|$)/` — split after the match;
   - OR a blank line (the paragraph-style prompt makes replies arrive in
     clean blocks);
   - guard: don't flush fragments < ~15 chars — glue them to the next flush.
3. **Fast first chunk (the key trick):** for chunk #1 only, don't wait for a
   full sentence — flush at the first comma/clause break past ~8 words, or
   after ~1.2s with no boundary. Getting *any* voice out early transforms
   perceived latency; later chunks use real sentence boundaries.
4. **Synthesize sequentially:** for each flushed chunk,
   `POST /api/tts {"text": chunk, "voice": ..., "format": "pcm"}` → decode
   int16 PCM at the `X-Sample-Rate` (24000) into an AudioBuffer. Keep **one
   request in flight, prefetch the next while the current plays** — order is
   guaranteed, and Kokoro synthesizes ~4× faster than speech plays, so the
   pipeline stays ahead permanently after chunk #1.
5. **Schedule gaplessly:** `source.start(max(ctx.currentTime, scheduledUntil))`;
   `scheduledUntil += buffer.duration`. Insert ~80ms of scheduled silence
   between chunks that ended with sentence punctuation (natural pacing).
6. **On `done`:** flush whatever remains in the buffer as the last chunk.
7. **Teardown (must be instant):** on user barge-in, the `phrase{interrupt}`
   event, send-of-next-message, or leaving the call: stop the current source,
   clear both queues, `AbortController.abort()` any in-flight /api/tts fetch.
8. **Errors:** a failed synthesis chunk is skipped (log it) — never stall the
   queue; if /api/tts 503s (capability off), fall back to the on-device TTS
   for the remainder of the reply.

## Numbers to expect

- Kokoro warm first-chunk: ~200–300ms after POST.
- First clause available: ~8–15 tokens ≈ 0.5–1.5s of generation.
- **Total time-to-first-audio: ~1–2s after generation starts**, vs. full
  generation time today.
- Skip `synthesize`-style buffering entirely — never wait for `done` except
  for the final partial chunk.

## Notes

- `format: "pcm"` avoids per-chunk WAV header parsing; one AudioContext at
  24 kHz (or resample) for the whole session.
- Don't send markdown symbols to TTS — voice-mode replies are already
  plain-prose (voice-style prompt layer), but strip any stray `*`/`#` as a
  belt-and-braces filter.
- Chunk text ≠ display text: keep rendering tokens to the transcript as they
  arrive, independent of the audio pipeline.
- Backend serializes TTS per voice internally, so overlapping requests are
  safe but pointless — the one-in-flight + prefetch pattern is optimal.
