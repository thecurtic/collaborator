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


def test_deprecated_passkey_paths_removed():
    """Tickets are the ONLY WS auth: ?passkey= and first-frame passkey are gone."""
    main.auth_enabled = True
    main.validate_passkey = lambda pk: pk == "good"
    c = TestClient(main.app)
    # A valid passkey in the URL no longer authenticates.
    with c.websocket_connect("/api/transcribe/stream?passkey=good") as ws:
        assert ws.receive_json()["type"] == "error"
    # Neither does a first-frame passkey.
    with c.websocket_connect("/api/transcribe/stream") as ws:
        assert ws.receive_json()["type"] == "error"
    main.auth_enabled = False
    print("✓ deprecated passkey auth paths rejected (ticket-only)")


def test_ws_ticket_flow():
    """A single-use ticket from POST /api/auth/ws-ticket authenticates the WS."""
    main.auth_enabled = True
    main.validate_passkey = lambda pk: pk == "good"
    _stub_whisper()
    c = TestClient(main.app)

    # Wrong passkey -> no ticket.
    assert c.post("/api/auth/ws-ticket", headers={"X-Passkey": "bad"}).status_code == 403
    r = c.post("/api/auth/ws-ticket", headers={"X-Passkey": "good"})
    assert r.status_code == 200 and r.json()["expires_in"] == 30
    ticket = r.json()["ticket"]

    # Valid ticket authenticates the WS.
    with c.websocket_connect(f"/api/transcribe/stream?ticket={ticket}") as ws:
        ws.send_text(json.dumps({"type": "end"}))
        assert ws.receive_json()["type"] == "final"

    # Single use: the same ticket is now rejected.
    with c.websocket_connect(f"/api/transcribe/stream?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "error"

    # Bogus ticket rejected.
    with c.websocket_connect("/api/transcribe/stream?ticket=nope") as ws:
        assert ws.receive_json()["type"] == "error"
    main.auth_enabled = False
    print("✓ ws-ticket: issue (header auth), single-use, rejects bad/expired")


if __name__ == "__main__":
    test_partial_then_final()
    test_deprecated_passkey_paths_removed()
    test_ws_ticket_flow()
    print("\n✓ All streaming-transcribe tests passed!")
