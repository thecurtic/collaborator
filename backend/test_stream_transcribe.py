"""Tests for WS /api/transcribe/stream (Whisper stubbed so no model/numpy needed)."""

import os
import json
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, main
importlib.reload(main)
from starlette.testclient import TestClient

PCM_2S = b"\x00" * (16000 * 2 * 2)  # ~2 seconds of PCM16 mono 16kHz


def _stub_whisper():
    main._get_whisper_model = lambda: object()

    def fake(pcm, language=None):
        secs = len(pcm) // (16000 * 2)
        return f"{secs}s transcript"
    main._transcribe_pcm16 = fake


def test_partial_then_final():
    main.auth_enabled = False
    _stub_whisper()
    c = TestClient(main.app)
    with c.websocket_connect("/api/transcribe/stream") as ws:
        ws.send_bytes(PCM_2S)                       # crosses the partial threshold
        partial = ws.receive_json()
        assert partial["type"] == "partial" and "transcript" in partial["text"]
        ws.send_text(json.dumps({"type": "end"}))
        final = ws.receive_json()
        assert final["type"] == "final"
    print("✓ streams partials and finalizes on end")


def test_auth_rejects_bad_passkey():
    main.auth_enabled = True
    main.validate_passkey = lambda pk: pk == "good"
    c = TestClient(main.app)
    with c.websocket_connect("/api/transcribe/stream?passkey=bad") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "error"
    main.auth_enabled = False
    print("✓ rejects bad passkey")


def test_auth_via_first_message():
    main.auth_enabled = True
    main.validate_passkey = lambda pk: pk == "good"
    _stub_whisper()
    c = TestClient(main.app)
    with c.websocket_connect("/api/transcribe/stream") as ws:
        ws.send_text(json.dumps({"passkey": "good"}))   # auth as first text frame
        ws.send_bytes(PCM_2S)
        assert ws.receive_json()["type"] == "partial"
        ws.send_text(json.dumps({"type": "end"}))
        assert ws.receive_json()["type"] == "final"
    main.auth_enabled = False
    print("✓ accepts passkey via first text frame")


if __name__ == "__main__":
    test_partial_then_final()
    test_auth_rejects_bad_passkey()
    test_auth_via_first_message()
    print("\n✓ All streaming-transcribe tests passed!")
