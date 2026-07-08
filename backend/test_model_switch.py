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
    dot = os.path.join(tempfile.mkdtemp(), ".config.yaml")
    main._dot_config_path = lambda: dot
    main.get_available_models = lambda: ["qwen/qwen3-coder-next", "qwen/qwen3-30b-a3b"]
    return TestClient(main.app), dot


def test_list_models():
    c, _ = _setup()
    out = c.get("/api/models").json()
    assert out["current"] == config.get_config._config["inference"]["model_id"]
    assert "qwen/qwen3-30b-a3b" in out["available"]
    print("✓ GET /api/models: current + available")


def test_switch_applies_live_and_persists():
    c, dot = _setup()
    original = config.get_config._config["inference"]["model_id"]

    r = c.put("/api/model", json={"model_id": "qwen/qwen3-30b-a3b"})
    assert r.status_code == 200 and r.json()["persisted"] is True
    # Applies live: the shared config dict (used by inference too) is updated.
    assert config.get_config._config["inference"]["model_id"] == "qwen/qwen3-30b-a3b"
    assert inference._get_config()["inference"]["model_id"] == "qwen/qwen3-30b-a3b"
    # Persists to the gitignored machine override, not config.yaml.
    saved = yaml.safe_load(open(dot))
    assert saved["inference"]["model_id"] == "qwen/qwen3-30b-a3b"

    # Restore.
    c.put("/api/model", json={"model_id": original, "force": True})
    print("✓ PUT /api/model: applies immediately (shared dict) + persists to .config.yaml")


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
