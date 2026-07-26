"""Tests for voice.py (streaming sessions, phrase detection, TTS endpoints).

Model-free: decode functions and the Piper engine are stubbed at the module
boundary, matching how test_stream_transcribe.py stubs the WS endpoint.
"""

import json
import os
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, main, voice
importlib.reload(main)
from starlette.testclient import TestClient

BPS = voice.BYTES_PER_SEC
LOUD_1S = b"\x10\x27" * 16000            # int16 LE 0x2710 = 10000 amplitude, 1s
SILENCE = b"\x00\x00" * 16000            # 1s of zeros


# --- phrase matching -----------------------------------------------------------

def test_tail_match_and_fuzz():
    words = voice.normalize_words("Okay, let's wrap up — That is all.")
    assert voice.tail_matches_phrase(words, "that is all")
    # Whisper decoration/small errors on longer words are tolerated...
    assert voice.tail_matches_phrase(voice.normalize_words("please rap it up"),
                                     "please wrap it up")
    # ...but short words must match exactly ("all" != "tall").
    assert not voice.tail_matches_phrase(voice.normalize_words("that is tall"),
                                         "that is all")
    # Mid-sentence phrase (words continue past it) never matches the tail.
    assert not voice.tail_matches_phrase(
        voice.normalize_words("that is all I wanted to say about it"),
        "that is all")
    print("✓ tail matching: exact, fuzzy long words, strict short words, tail-only")


def test_strip_phrase_tail():
    assert voice.strip_phrase_tail("Okay, let's do it. That is all.",
                                   "that is all") == "Okay, let's do it."
    # No trailing match -> untouched.
    text = "That is all I wanted to say about it"
    assert voice.strip_phrase_tail(text, "that is all") == text
    print("✓ end phrase stripped from finals (only when trailing)")


# --- RMS silence gate ----------------------------------------------------------

def test_rms_gate():
    t = voice.RmsTracker()
    t.feed(LOUD_1S)
    assert not t.tail_silent(350)          # still speaking
    t.feed(SILENCE[:BPS // 2])             # 500ms of quiet
    assert t.tail_silent(350)              # trailing quiet detected
    t.feed(LOUD_1S[:BPS // 4])             # speech resumes
    assert not t.tail_silent(350)
    print("✓ RMS gate: quiet tail fires, speech suppresses")


# --- streaming session: commit + phrases ---------------------------------------

def test_session_commit_bounds_window(monkeypatch):
    segs = [(0.0, 5.0, " one"), (5.0, 10.0, " two"),
            (10.0, 16.0, " three"), (16.0, 20.0, " four")]
    monkeypatch.setattr(voice, "decode_partial_pcm",
                        lambda pcm, language=None: ("one two three four", segs))
    s = voice.StreamSession()
    s.feed(b"\x00\x00" * (BPS // 2) * 20 * 1)     # 20s of audio
    s.feed(b"")  # no-op
    assert s.need_decode()
    text = s.decode_partial()
    # 20s uncommitted > 15s window: segments ending before (20 - 6)=14s freeze.
    assert s.committed_text == "one two"
    assert s.committed_bytes == 10 * BPS
    assert s.tail_text == "three four"
    assert text == "one two three four"
    print("✓ window overflow commits old segments; transcript stays whole")


def test_session_phrase_end_flow(monkeypatch):
    monkeypatch.setattr(voice, "decode_partial_pcm",
                        lambda pcm, language=None: ("Remind me tomorrow. That is all", []))
    s = voice.StreamSession()
    s.set_phrases([{"kind": "end", "text": "that is all"}])
    s.feed(LOUD_1S)
    s.decode_partial()
    s.evaluate_phrases()
    assert s.candidate and s.candidate["kind"] == "end"
    assert s.pending_event() is None          # tail still loud -> not confirmed
    s.feed(SILENCE[:BPS // 2])                # 500ms trailing quiet
    ev = s.pending_event()
    assert ev and ev["kind"] == "end"
    print("✓ end phrase: match + trailing quiet fires; loud tail holds")


def test_session_interrupt_rearm(monkeypatch):
    monkeypatch.setattr(voice, "decode_partial_pcm",
                        lambda pcm, language=None: ("hold on a second", []))
    s = voice.StreamSession()
    s.set_phrases([{"kind": "interrupt", "text": "hold on a second"}])
    s.feed(LOUD_1S)
    s.decode_partial()
    s.evaluate_phrases()
    s.feed(SILENCE[:BPS // 2])
    ev = s.pending_event()
    assert ev and ev["kind"] == "interrupt"
    # Same transcript position never re-fires (silence continues, decode repeats).
    assert s.pending_event() is None
    s.evaluate_phrases()
    assert s.candidate is None
    print("✓ interrupt fires once per utterance position (no repeat-fire)")


def test_session_finalize_strips_end_phrase(monkeypatch):
    monkeypatch.setattr(voice, "decode_final_pcm",
                        lambda pcm, language=None: "Remind me tomorrow. That is all.")
    s = voice.StreamSession()
    s.set_phrases([{"kind": "end", "text": "that is all"}])
    s.feed(SILENCE)
    assert s.finalize() == "Remind me tomorrow."
    print("✓ finalize strips the end phrase from the final transcript")


# --- WS integration: config + phrase + final -----------------------------------

def test_ws_phrase_session(monkeypatch):
    main.auth_enabled = False
    monkeypatch.setattr(voice, "ensure_stt_loaded", lambda: None)
    monkeypatch.setattr(voice, "decode_partial_pcm",
                        lambda pcm, language=None: ("Buy oat milk. That is all", []))
    monkeypatch.setattr(voice, "decode_final_pcm",
                        lambda pcm, language=None: "Buy oat milk. That is all")
    c = TestClient(main.app)
    with c.websocket_connect("/api/transcribe/stream") as ws:
        ws.send_text(json.dumps({"type": "config",
                                 "phrases": [{"kind": "end", "text": "that is all"}]}))
        ws.send_bytes(LOUD_1S)
        partial = ws.receive_json()
        assert partial["type"] == "partial" and "oat milk" in partial["text"]
        ws.send_bytes(SILENCE[:BPS // 2])     # trailing quiet confirms the phrase
        assert ws.receive_json() == {"type": "phrase", "kind": "end"}
        final = ws.receive_json()
        assert final["type"] == "final" and final["text"] == "Buy oat milk."
    print("✓ WS session: config -> partial -> phrase(end) -> stripped final")


# --- TTS endpoints --------------------------------------------------------------

def _stub_tts(monkeypatch, enabled=True):
    monkeypatch.setattr(voice, "capabilities",
                        lambda refresh=False: {"stt_stream": True,
                                               "tts_stream": enabled,
                                               "phrases": True})
    monkeypatch.setattr(voice, "list_tts_voices", lambda: ["test-voice"])
    monkeypatch.setattr(voice, "default_tts_voice", lambda: "test-voice")
    monkeypatch.setattr(voice, "tts_sample_rate", lambda name: 22050)
    monkeypatch.setattr(voice, "synth_stream",
                        lambda text, name: iter([(22050, b"\x01\x02" * 64),
                                                 (22050, b"\x03\x04" * 64)]))


def test_tts_wav_and_pcm(monkeypatch):
    main.auth_enabled = False
    _stub_tts(monkeypatch)
    c = TestClient(main.app)

    r = c.post("/api/tts", json={"text": "hello there"})
    assert r.status_code == 200
    assert r.content.startswith(b"RIFF") and b"\x01\x02" in r.content
    assert r.headers["x-sample-rate"] == "22050"

    r = c.post("/api/tts", json={"text": "hello", "format": "pcm"})
    assert r.status_code == 200 and not r.content.startswith(b"RIFF")
    assert r.content == (b"\x01\x02" * 64) + (b"\x03\x04" * 64)

    assert c.post("/api/tts", json={"text": "  "}).status_code == 422
    assert c.post("/api/tts", json={"text": "x", "voice": "nope"}).status_code == 404
    print("✓ POST /api/tts: streaming WAV, raw PCM, validation")


def test_tts_disabled_and_voices(monkeypatch):
    main.auth_enabled = False
    _stub_tts(monkeypatch, enabled=False)
    c = TestClient(main.app)
    assert c.post("/api/tts", json={"text": "hi"}).status_code == 503
    r = c.get("/api/tts/voices")
    assert r.status_code == 200 and r.json()["voices"] == ["test-voice"]
    assert r.json()["enabled"] is False
    print("✓ TTS absent when unconfigured; voices endpoint reports state")


def test_health_capabilities():
    c = TestClient(main.app)
    caps = c.get("/api/health").json()["capabilities"]
    assert set(caps) == {"stt_stream", "tts_stream", "phrases"}
    assert all(isinstance(v, bool) for v in caps.values())
    print("✓ health advertises capability booleans")


if __name__ == "__main__":
    print("Run with pytest (uses monkeypatch fixtures).")
