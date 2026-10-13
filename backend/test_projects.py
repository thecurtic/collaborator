"""Tests for project name overrides (UX doc, How a project forms)."""

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


def test_overrides_round_trip_and_validation():
    db.init_db()
    c = TestClient(main.app)
    assert c.get("/api/projects/overrides").json() == {"pinned": [], "ignored": []}
    r = c.put("/api/projects/overrides", json={"pinned": ["Garden", "garden"],
                                               "ignored": ["urgent"]})
    assert r.status_code == 200
    assert r.json() == {"pinned": ["garden"], "ignored": ["urgent"]}
    assert c.get("/api/projects/overrides").json() == r.json()
    assert c.put("/api/projects/overrides",
                 json={"pinned": ["x"], "ignored": ["x"]}).status_code == 422
    assert c.put("/api/projects/overrides", json={"ignored": ["project"]}).status_code == 422
    assert c.put("/api/projects/overrides", json={}).json() == {"pinned": [], "ignored": []}
    print("✓ project overrides: replace both lists, normalized, validated")
