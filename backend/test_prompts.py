"""Tests for the read-only prompt visibility endpoints."""

import os
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient

EXPECTED = {"system", "datetime", "paragraph-style", "voice-style", "tools-guidance",
            "tools-spec", "synthesis-memory", "synthesis-web", "synthesis-notes"}


def test_inventory_lists_all_building_blocks():
    c = TestClient(main.app)
    out = c.get("/api/prompts").json()
    names = {p["name"] for p in out["prompts"]}
    assert EXPECTED <= names, names
    for p in out["prompts"]:
        assert p["content"].strip(), f"{p['name']} has empty content"
        assert p["source"] in ("file", "config", "default")
        assert "applies" in p and "description" in p
    print("✓ inventory lists all 8+ building blocks with content + provenance")


def test_file_backed_content_matches_disk():
    c = TestClient(main.app)
    p = c.get("/api/prompts/tools-guidance").json()["prompt"]
    assert p["source"] == "file" and p["file"] == "tools-guidance.md"
    on_disk = open(config.resolve_path("tools-guidance.md"), encoding="utf-8").read().strip()
    assert p["content"] == on_disk
    # The system prompt carries its staleness caveat.
    sysp = c.get("/api/prompts/system").json()["prompt"]
    assert "restart" in sysp.get("note", "")
    print("✓ file-backed prompts match disk; system prompt carries the restart note")


def test_default_fallback_reported():
    cfg = config.get_config._config
    orig = cfg["tools"]["guidance_file"]
    cfg["tools"]["guidance_file"] = "/nope/missing.md"
    try:
        c = TestClient(main.app)
        p = c.get("/api/prompts/tools-guidance").json()["prompt"]
        assert p["source"] == "default" and "tools" in p["content"].lower()
    finally:
        cfg["tools"]["guidance_file"] = orig
    print("✓ missing file degrades to built-in default, honestly labeled")


def test_unknown_name_404():
    c = TestClient(main.app)
    assert c.get("/api/prompts/nope").status_code == 404
    print("✓ unknown prompt name -> 404")


if __name__ == "__main__":
    test_inventory_lists_all_building_blocks()
    test_file_backed_content_matches_disk()
    test_default_fallback_reported()
    test_unknown_name_404()
    print("\n✓ All prompt-visibility tests passed!")
