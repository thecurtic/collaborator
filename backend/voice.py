"""Server-side voice engines: streaming STT sessions, phrase detection, TTS.

This module is the server tier of the two-tier voice architecture. The frontend
keeps a fully on-device stack (Whisper-tiny worker, keyword spotter, Piper WASM)
and composes per engine: server where GET /api/health advertises the capability,
on-device otherwise. Everything here must therefore be cleanly absent when not
configured — capabilities() is the single source of that truth.

Design rules carried over from the first voice stack's failures:
- Turn-ending is LEXICAL, decided inside the ASR stream (tail-match on the
  running transcript), never by a separate acoustic classifier.
- No VAD endpointing: a session ends only on an end-phrase match or an explicit
  client "end". The RMS check below only *gates phrase confirmation* (so saying
  the phrase mid-sentence doesn't fire); it can never end a turn by itself.
- Per-partial compute is bounded: text older than the rolling window is
  committed and never re-decoded, so partial latency is flat no matter how long
  the user talks.

All model access goes through a registry that pairs every model with a lock —
faster-whisper and Piper instances are not safe for concurrent use.
"""

import os
import re
import struct
import threading
from collections import deque
from typing import Dict, List, Optional, Tuple

from config import get_config, resolve_path

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE


def _voice_config() -> Dict:
    return get_config().get("voice", {}) or {}


def stt_config() -> Dict:
    return _voice_config().get("stt", {}) or {}


def phrases_config() -> Dict:
    return _voice_config().get("phrases", {}) or {}


def tts_config() -> Dict:
    return _voice_config().get("tts", {}) or {}


# --- STT model registry (every model paired with a lock) -----------------------

_stt_models: Dict[tuple, tuple] = {}
_stt_registry_lock = threading.Lock()


def _model_key(which: str) -> tuple:
    """(name, device, compute) for the 'partial' or 'final' model. The legacy
    `transcription:` section still supplies device/compute fallbacks so older
    configs keep working; model names come from voice.stt."""
    cfg = stt_config()
    legacy = get_config().get("transcription", {}) or {}
    name = cfg.get(f"{which}_model") or legacy.get("model", "base")
    device = cfg.get("device") or legacy.get("device", "cpu")
    compute = cfg.get("compute_type") or legacy.get("compute_type", "int8")
    return (name, device, compute)


def _get_stt_model(name: str, device: str, compute: str):
    """Load-once model access. Returns (model, lock)."""
    key = (name, device, compute)
    with _stt_registry_lock:
        entry = _stt_models.get(key)
        if entry is None:
            from faster_whisper import WhisperModel
            model = WhisperModel(name, device=device, compute_type=compute)
            entry = (model, threading.Lock())
            _stt_models[key] = entry
    return entry


def ensure_stt_loaded() -> None:
    """Load both session models (blocking; call off the event loop)."""
    _get_stt_model(*_model_key("partial"))
    _get_stt_model(*_model_key("final"))


def _decode(pcm: bytes, language: Optional[str], which: str):
    """PCM16 mono 16k -> (text, [(start_s, end_s, text)]) under the model lock."""
    if not pcm:
        return "", []
    import numpy as np
    audio = np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768.0
    model, lock = _get_stt_model(*_model_key(which))
    with lock:
        segments, _info = model.transcribe(audio, language=language or "en")
        segs = [(s.start, s.end, s.text) for s in segments]  # consume under lock
    return "".join(t for _, _, t in segs).strip(), segs


def decode_partial_pcm(pcm: bytes, language: Optional[str] = None):
    return _decode(pcm, language, "partial")


def decode_final_pcm(pcm: bytes, language: Optional[str] = None) -> str:
    return _decode(pcm, language, "final")[0]


def transcribe_batch(audio, language: Optional[str] = None) -> str:
    """One-shot transcription (file path or float32 array) with the final model.
    Used by POST /api/transcribe."""
    model, lock = _get_stt_model(*_model_key("final"))
    with lock:
        segments, _info = model.transcribe(audio, language=language or "en")
        return "".join(s.text for s in segments).strip()


# --- Phrase matching (lexical, on the running transcript) ----------------------

_WORD_RE = re.compile(r"[a-z0-9']+")


def normalize_words(text: str) -> List[str]:
    """Lowercase word tokens; punctuation and symbols dropped (Whisper decorates)."""
    return _WORD_RE.findall((text or "").lower())


def _edit_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if la == 0 or lb == 0:
        return max(la, lb)
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        for j in range(1, lb + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1,
                         prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[lb]


def tail_matches_phrase(words: List[str], phrase: str,
                        max_word_distance: int = 1) -> bool:
    """True when the last len(phrase) words fuzzy-match the phrase word-by-word.

    Words of <= 3 characters must match exactly (edit distance 1 on "all" would
    accept "tall"); longer words tolerate max_word_distance edits each.
    """
    pw = normalize_words(phrase)
    if not pw or len(words) < len(pw):
        return False
    for w, p in zip(words[-len(pw):], pw):
        allowed = 0 if len(p) <= 3 else max_word_distance
        if _edit_distance(w, p) > allowed:
            return False
    return True


def strip_phrase_tail(text: str, phrase: str, max_word_distance: int = 1) -> str:
    """Remove a trailing phrase match (plus dangling punctuation) from raw text."""
    lower = (text or "").lower()
    spans = [(m.start(), m.end()) for m in _WORD_RE.finditer(lower)]
    words = [lower[s:e] for s, e in spans]
    pw = normalize_words(phrase)
    if not pw or len(words) < len(pw):
        return text
    if not tail_matches_phrase(words, phrase, max_word_distance):
        return text
    cut = spans[-len(pw)][0]
    # Drop dangling connector punctuation ("Okay, that is all" -> "Okay") but
    # keep sentence-final ./!/? from the preceding sentence.
    return text[:cut].rstrip(" \t\n\r").rstrip(",;:—–-").rstrip()


# --- RMS tracking (gates phrase confirmation; never ends a turn) ---------------

FRAME_MS = 100
FRAME_BYTES = BYTES_PER_SEC * FRAME_MS // 1000


class RmsTracker:
    """Per-100ms RMS over the incoming PCM, with an adaptive noise floor.

    The floor is the 10th percentile of recent frame RMS (roughly "this room's
    quiet"), so the silence threshold adapts to mic gain and ambient noise.
    """

    def __init__(self, history_frames: int = 600):
        self._carry = b""
        self.frames: deque = deque(maxlen=history_frames)

    def feed(self, data: bytes) -> None:
        import numpy as np
        buf = self._carry + data
        n = len(buf) // FRAME_BYTES
        for i in range(n):
            frame = np.frombuffer(
                buf[i * FRAME_BYTES:(i + 1) * FRAME_BYTES], dtype="<i2"
            ).astype("float32")
            self.frames.append(float(np.sqrt(np.mean(frame * frame))))
        self._carry = buf[n * FRAME_BYTES:]

    def tail_silent(self, ms: int, abs_floor: float = 100.0,
                    floor_multiplier: float = 2.5) -> bool:
        """True when every frame in the trailing `ms` is quiet.

        Quiet = at/below BOTH bounds (each floored by abs_floor):
        - floor_multiplier x the adaptive noise floor (10th pct of frame RMS), and
        - 0.35 x the session's speech level (90th pct) — so early in a session,
          before any real quiet has been observed, speech-level audio can never
          count as silence.
        """
        n = max(1, int(ms) // FRAME_MS)
        if len(self.frames) < max(n, 10):
            return False
        import numpy as np
        history = list(self.frames)
        quiet_floor, speech_level = np.percentile(history, [10, 90])
        threshold = min(max(abs_floor, floor_multiplier * float(quiet_floor)),
                        max(abs_floor, 0.35 * float(speech_level)))
        return all(r <= threshold for r in history[-n:])


# --- Streaming STT session ------------------------------------------------------

class StreamSession:
    """One continuous listening session over WS /api/transcribe/stream.

    Holds the full session audio (32 KB/s — minutes are cheap), a committed
    transcript prefix, and the uncommitted rolling window that partial decodes
    operate on. Decode functions are looked up on the module at call time so
    tests can stub them.
    """

    def __init__(self, language: Optional[str] = None):
        cfg = stt_config()
        pcfg = phrases_config()
        self.language = language
        self.audio = bytearray()          # full session PCM (kept for the final pass)
        self.committed_bytes = 0          # audio offset covered by committed_text
        self.committed_text = ""
        self.tail_text = ""               # latest decode of the uncommitted window
        self.last_decoded_len = 0
        self.phrases: List[dict] = []
        self.candidate: Optional[dict] = None   # tail-matched phrase awaiting silence
        self.last_interrupt_at = -1             # word position of the last interrupt fire
        self.rms = RmsTracker()

        self.partial_interval_bytes = int(
            BYTES_PER_SEC * cfg.get("partial_interval_ms", 400) / 1000)
        self.window_bytes = int(BYTES_PER_SEC * cfg.get("window_seconds", 15))
        self.keep_tail_bytes = int(BYTES_PER_SEC * cfg.get("commit_keep_seconds", 6))
        self.final_full_pass_bytes = int(
            BYTES_PER_SEC * cfg.get("final_full_pass_seconds", 90))
        self.silence_ms = pcfg.get("silence_ms", 350)
        self.max_word_distance = pcfg.get("max_word_distance", 1)
        self.abs_floor = pcfg.get("silence_rms_floor", 100.0)
        self.floor_multiplier = pcfg.get("silence_floor_multiplier", 2.5)

    # -- config / audio intake --

    def set_phrases(self, phrases) -> List[dict]:
        clean = []
        for p in phrases or []:
            kind = (p or {}).get("kind")
            text = ((p or {}).get("text") or "").strip()
            if kind in ("end", "interrupt") and text:
                clean.append({"kind": kind, "text": text})
        self.phrases = clean
        return clean

    def feed(self, data: bytes) -> None:
        self.audio += data
        self.rms.feed(data)

    def need_decode(self) -> bool:
        return len(self.audio) - self.last_decoded_len >= self.partial_interval_bytes

    # -- partial decoding with committed prefix --

    @property
    def transcript(self) -> str:
        return f"{self.committed_text} {self.tail_text}".strip()

    def decode_partial(self) -> str:
        """Blocking: decode the uncommitted window, commit overflow, return the
        running transcript. Call from a worker thread."""
        self.last_decoded_len = len(self.audio)
        pcm = bytes(self.audio[self.committed_bytes:])
        text, segs = decode_partial_pcm(pcm, self.language)
        self.tail_text = text

        # Freeze segments that have scrolled past the window so per-partial
        # decode cost stays bounded on long sessions.
        if len(pcm) > self.window_bytes and segs:
            cutoff_s = (len(pcm) - self.keep_tail_bytes) / BYTES_PER_SEC
            commit_upto = 0
            commit_end_s = 0.0
            for i, (_s0, s1, _t) in enumerate(segs):
                if s1 is not None and s1 <= cutoff_s:
                    commit_upto = i + 1
                    commit_end_s = s1
                else:
                    break
            if commit_upto:
                frozen = "".join(t for _, _, t in segs[:commit_upto]).strip()
                self.committed_text = f"{self.committed_text} {frozen}".strip()
                # Keep the offset sample-aligned.
                advance = int(commit_end_s * BYTES_PER_SEC)
                self.committed_bytes += advance - (advance % BYTES_PER_SAMPLE)
                self.tail_text = "".join(t for _, _, t in segs[commit_upto:]).strip()
        return self.transcript

    # -- phrase detection --

    def evaluate_phrases(self) -> None:
        """After a decode: set/clear the pending candidate from the tail match."""
        if not self.phrases:
            return
        words = normalize_words(self.transcript)
        match = None
        for p in self.phrases:
            if tail_matches_phrase(words, p["text"], self.max_word_distance):
                match = {"kind": p["kind"], "text": p["text"], "at": len(words)}
                break
        if match and match["kind"] == "interrupt" and match["at"] <= self.last_interrupt_at:
            match = None  # already fired at this position; wait for new speech
        self.candidate = match

    def pending_event(self) -> Optional[dict]:
        """A phrase event ready to fire NOW: candidate + trailing silence.
        Cheap (no decode) — call on every received audio chunk."""
        if not self.candidate:
            return None
        if not self.rms.tail_silent(self.silence_ms, self.abs_floor,
                                    self.floor_multiplier):
            return None
        event = dict(self.candidate)
        if event["kind"] == "interrupt":
            self.last_interrupt_at = event["at"]
            self.candidate = None
        return event

    # -- finalization --

    def finalize(self) -> str:
        """Blocking: the definitive transcript, end phrases stripped from the tail.

        Sessions up to final_full_pass_seconds get a full re-decode with the
        (better) final model; longer ones reuse the committed prefix and
        final-decode only the uncommitted tail, keeping finalization latency flat.
        """
        if len(self.audio) <= self.final_full_pass_bytes:
            text = decode_final_pcm(bytes(self.audio), self.language)
        else:
            tail = decode_final_pcm(bytes(self.audio[self.committed_bytes:]),
                                    self.language)
            text = f"{self.committed_text} {tail}".strip()
        for p in self.phrases:
            if p["kind"] == "end":
                text = strip_phrase_tail(text, p["text"], self.max_word_distance)
        return text.strip()


# --- TTS (Piper) ----------------------------------------------------------------

_tts_voices: Dict[str, tuple] = {}
_tts_registry_lock = threading.Lock()


def _voices_dir() -> Optional[str]:
    d = tts_config().get("voices_dir")
    if not d:
        return None
    return d if os.path.isabs(d) else resolve_path(d)


def list_tts_voices() -> List[str]:
    """Voice names = <name>.onnx files in voices_dir (each with its .onnx.json)."""
    d = _voices_dir()
    if not d or not os.path.isdir(d):
        return []
    return sorted(os.path.splitext(f)[0] for f in os.listdir(d)
                  if f.endswith(".onnx") and not f.startswith("."))


def default_tts_voice() -> Optional[str]:
    voices = list_tts_voices()
    configured = tts_config().get("default_voice")
    if configured in voices:
        return configured
    return voices[0] if voices else None


def _import_piper_voice():
    try:
        from piper import PiperVoice          # piper1-gpl (>= 1.3)
    except ImportError:
        from piper.voice import PiperVoice    # legacy piper-tts 1.2
    return PiperVoice


def _load_tts_voice(name: str):
    """Load-once voice access. Returns (voice, lock)."""
    with _tts_registry_lock:
        entry = _tts_voices.get(name)
        if entry is None:
            PiperVoice = _import_piper_voice()
            path = os.path.join(_voices_dir() or "", f"{name}.onnx")
            voice = PiperVoice.load(path)
            entry = (voice, threading.Lock())
            _tts_voices[name] = entry
    return entry


def tts_sample_rate(name: str) -> Optional[int]:
    try:
        voice, _lock = _load_tts_voice(name)
        return int(voice.config.sample_rate)
    except Exception:
        return None


def synth_stream(text: str, voice_name: str):
    """Yield (sample_rate, pcm16le_bytes) chunks, sentence-by-sentence.

    Holds the voice's lock for the whole generation — TTS requests serialize
    rather than corrupting shared ONNX state.
    """
    voice, lock = _load_tts_voice(voice_name)
    with lock:
        if hasattr(voice, "synthesize_stream_raw"):      # legacy 1.2 API
            rate = int(voice.config.sample_rate)
            for chunk in voice.synthesize_stream_raw(text):
                if chunk:
                    yield rate, chunk
        else:                                            # piper1-gpl API
            for chunk in voice.synthesize(text):
                data = chunk.audio_int16_bytes
                if data:
                    yield int(chunk.sample_rate), data


def wav_header(sample_rate: int, channels: int = 1, bits: int = 16) -> bytes:
    """Streaming WAV header (unknown length: max RIFF/data sizes)."""
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    return (b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVE"
            + b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate,
                                    byte_rate, block_align, bits)
            + b"data" + struct.pack("<I", 0xFFFFFFFF - 44))


# --- Capabilities + preload -----------------------------------------------------

_caps_cache: Optional[dict] = None


def _importable(module: str) -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec(module) is not None
    except Exception:
        return False


def capabilities(refresh: bool = False) -> dict:
    """What this instance's voice tier supports — the frontend's one cheap probe.

    Computed once and cached (health must stay free). stt_stream needs the
    dependency present and not explicitly disabled; tts_stream additionally
    needs at least one voice on disk; phrases ride the STT stream (pure code).
    """
    global _caps_cache
    if _caps_cache is None or refresh:
        stt = bool(stt_config().get("enabled", True)) and _importable("faster_whisper")
        tts = (bool(tts_config().get("enabled", True)) and _importable("piper")
               and bool(list_tts_voices()))
        _caps_cache = {"stt_stream": stt, "tts_stream": tts, "phrases": stt}
    return _caps_cache


def preload_in_background() -> None:
    """Warm-load configured engines at startup (fire-and-forget thread), so the
    first call of the day never pays a model load. Opt-in via voice.*.preload."""
    want_stt = stt_config().get("preload") and capabilities().get("stt_stream")
    want_tts = tts_config().get("preload") and capabilities().get("tts_stream")
    if not (want_stt or want_tts):
        return

    def _load():
        try:
            if want_stt:
                ensure_stt_loaded()
                print("Voice: STT models preloaded "
                      f"({_model_key('partial')[0]} + {_model_key('final')[0]})")
            if want_tts:
                name = default_tts_voice()
                if name:
                    _load_tts_voice(name)
                    print(f"Voice: TTS voice preloaded ({name})")
        except Exception as e:
            print(f"Warning: voice preload failed: {e}")

    threading.Thread(target=_load, daemon=True, name="voice-preload").start()
