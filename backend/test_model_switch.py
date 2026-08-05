"""Tests for model listing/switching endpoints."""

import os
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, inference
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient
import yaml


def _setup():
    dot = os.path.join(tempfile.mkdtemp(), "app_settings.json")
    main._app_settings_path = lambda: dot
    main.get_available_models = lambda: ["qwen/qwen3-coder-next", "qwen/qwen3-30b-a3b"]
    main.get_models_detail = lambda: []
    return TestClient(main.app), dot


def test_models_detail_actually_imported():
    """Regression: get_models_detail must be a real import in main, not an
    attribute conjured by test monkeypatching — a missing import here reached
    prod as a NameError on GET /api/models while every mocked test passed."""
    import importlib
    importlib.reload(main)
    assert getattr(main, "get_models_detail", None) is inference.get_models_detail
    print("✓ get_models_detail imported for real (not a test-double leftover)")


def test_list_models():
    c, _ = _setup()
    out = c.get("/api/models").json()
    assert out["current"] == config.get_config._config["inference"]["model_id"]
    assert "qwen/qwen3-30b-a3b" in out["available"]
    assert "current_loaded" not in out          # no detail -> no load claims
    print("✓ GET /api/models: current + available")


def test_list_models_load_state():
    c, _ = _setup()
    main.get_models_detail = lambda: [
        {"id": "qwen/qwen3-30b-a3b", "type": "llm", "state": "loaded",
         "quantization": "4bit", "max_context_length": 32768,
         "loaded_context_length": 16384},
        {"id": "qwen/qwen3-coder-next", "type": "llm", "state": "not-loaded",
         "quantization": None, "max_context_length": 65536,
         "loaded_context_length": None},
        {"id": "whisper-large-v3-turbo", "type": "stt", "state": "loaded",
         "quantization": None, "max_context_length": 4096,
         "loaded_context_length": None},
    ]
    out = c.get("/api/models").json()
    assert out["loaded"] == ["qwen/qwen3-30b-a3b"]      # llm only, stt excluded
    # Configured model isn't the loaded one -> visible mismatch flag.
    assert out["current_loaded"] is (
        config.get_config._config["inference"]["model_id"] == "qwen/qwen3-30b-a3b")
    assert any(m["quantization"] == "4bit" for m in out["models"])
    print("✓ GET /api/models: load state exposed, mismatch flagged")


def test_switch_applies_live_and_persists():
    c, dot = _setup()
    original = config.get_config._config["inference"]["model_id"]

    r = c.put("/api/model", json={"model_id": "qwen/qwen3-30b-a3b"})
    assert r.status_code == 200 and r.json()["persisted"] is True
    # Applies live: the shared config dict (used by inference too) is updated.
    assert config.get_config._config["inference"]["model_id"] == "qwen/qwen3-30b-a3b"
    assert inference._get_config()["inference"]["model_id"] == "qwen/qwen3-30b-a3b"
    # Persists to app_settings.json (state, not config) — never config.yaml.
    import json as _json
    saved = _json.load(open(dot))
    assert saved["inference"]["model_id"] == "qwen/qwen3-30b-a3b"

    # Restore.
    c.put("/api/model", json={"model_id": original, "force": True})
    print("✓ PUT /api/model: applies immediately (shared dict) + persists to app_settings.json")


def test_validation_and_force():
    c, _ = _setup()
    original = config.get_config._config["inference"]["model_id"]
    r = c.put("/api/model", json={"model_id": "made/up-model"})
    assert r.status_code == 422 and "Available" in r.json()["detail"]
    assert config.get_config._config["inference"]["model_id"] == original  # unchanged

    r = c.put("/api/model", json={"model_id": "made/up-model", "force": True})
    assert r.status_code == 200
    c.put("/api/model", json={"model_id": original, "force": True})       # restore

    assert c.put("/api/model", json={"model_id": "  "}).status_code == 422
    print("✓ unknown model 422 with available list; force overrides; empty 422")


if __name__ == "__main__":
    test_list_models()
    test_switch_applies_live_and_persists()
    test_validation_and_force()
    print("\n✓ All model-switch tests passed!")


def test_current_loaded_vlm_and_id_variants():
    """Vision chat models (type vlm) count as loaded; id comparison tolerates
    case/prefix variants — the false 'not loaded' warning bug."""
    c, _ = _setup()
    orig = config.get_config._config["inference"]["model_id"]
    config.get_config._config["inference"]["model_id"] = "qwen3-vl-30b"
    try:
        main.get_models_detail = lambda: [
            {"id": "qwen/qwen3-vl-30b", "type": "vlm", "state": "loaded",
             "quantization": "4bit", "max_context_length": 32768,
             "loaded_context_length": 32768}]
        out = c.get("/api/models").json()
        assert out["loaded"] == ["qwen/qwen3-vl-30b"]     # vlm included
        assert out["current_loaded"] is True              # prefix-variant match
    finally:
        config.get_config._config["inference"]["model_id"] = orig
    print("✓ vlm models count as loaded; id variants don't false-warn")
