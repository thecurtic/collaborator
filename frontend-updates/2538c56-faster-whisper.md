# Frontend Update: faster-whisper (transcription latency)

**Commit:** `2538c56`
**Date:** June 29, 2026

## Summary

Transcription now runs on **faster-whisper (CTranslate2)** instead of openai-whisper.
~4x faster on CPU at the same accuracy, GPU-ready, and it drops the PyTorch
dependency. This targets the felt delay in the streaming **final pass**.

## Frontend impact

**None — no API change.** Same endpoints, same message shapes:
- `POST /api/transcribe` (tap-to-record)
- `WS /api/transcribe/stream` (PCM16/mono/16k, `partial`/`final`/`end`)

You should just feel the final transcript arrive faster after `{"type":"end"}`, and
the running `partial` updates a bit more often (~1.5s).

## What changed (backend)

- Both transcription paths share one cached faster-whisper model.
- The full-utterance final pass is preserved (accuracy unchanged) — it's simply ~4x
  faster, so it no longer feels like a stall.
- Partial interval tightened ~2s → ~1.5s now that each pass is cheap, so the running
  transcript is closer to final by the time the user stops.

## Deploy (dependency change)

This swaps the inference engine, so reinstall deps and restart:
```bash
cd /srv/collaborator
git pull
.venv/bin/pip install -r requirements.txt   # adds faster-whisper, removes need for openai-whisper/torch
./restart.sh
```
- First transcription downloads the CTranslate2 'base' model (one-time, needs network).
- `ffmpeg` is still required for the one-shot upload path; the streaming WS path
  takes PCM directly (no ffmpeg).
- Optional: to use a GPU later, set in `config.yaml`:
  ```yaml
  transcription:
    device: cuda
    compute_type: float16
  ```

## Further latency options (not done, ask if needed)

If the final still feels slow on your hardware: silence-based segmenting so the final
only transcribes the trailing segment, or a smaller model (`tiny.en`) for partials.
Flagged but not implemented — faster-whisper alone should be a big step.

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | faster-whisper model + transcribe for one-shot & streaming |
| `backend/requirements.txt` | drop openai-whisper, add faster-whisper |
| `config.yaml.example` | optional `transcription` (model/device/compute) |
</content>
