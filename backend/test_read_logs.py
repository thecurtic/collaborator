"""Tests for the read_logs tool: ring buffer capture (print + logging), grep,
caps, registry gating, executor."""

import os
import json
import logging
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, logbuffer
importlib.reload(db)
importlib.reload(main)


def test_buffer_captures_print_and_logging():
    print("read_logs sentinel: PRINTED line")
    logging.getLogger("uvicorn.error").error("read_logs sentinel: LOGGED line")
    lines = logbuffer.get_lines(500)
    assert any("sentinel: PRINTED line" in l for l in lines)
    assert any("sentinel: LOGGED line" in l for l in lines)
    # Timestamps prefixed.
    assert all(l[:4].isdigit() for l in lines)
    print("✓ ring buffer captures print() and logging output, timestamped")


def test_grep_and_caps():
    for i in range(12):
        print(f"greptest line {i}")
    hits = logbuffer.get_lines(500, grep="GREPTEST")     # case-insensitive
    assert len(hits) >= 12 and all("greptest" in l for l in hits)
    assert len(logbuffer.get_lines(5, grep="greptest")) == 5
    assert len(logbuffer.get_lines(99999)) <= 500        # hard cap
    assert logbuffer.get_lines("not-a-number")           # bad limit -> default, no crash
    print("✓ grep filters case-insensitively; limits clamped; bad input tolerated")


def test_registry_and_executor():
    cfg = config.get_config._config
    schemas, execute, _ = main._build_tools(os.environ["DB_PATH"])
    assert "read_logs" in {s["function"]["name"] for s in schemas}

    cfg["tools"]["available"]["read_logs"] = False
    schemas, _, _ = main._build_tools(os.environ["DB_PATH"])
    assert "read_logs" not in {s["function"]["name"] for s in schemas}
    cfg["tools"]["available"]["read_logs"] = True

    print("executor sentinel: findme-abc123")
    out = json.loads(execute("read_logs", {"grep": "findme-abc123", "lines": 10}))
    assert out["count"] >= 1
    assert any("findme-abc123" in l for l in out["lines"])
    assert "diagnostic" in out["note"]
    print("✓ read_logs registered, gated, and served through the executor")


def test_install_idempotent():
    import sys
    before = sys.stdout
    logbuffer.install()
    logbuffer.install()
    assert sys.stdout is before                      # no double-wrapping
    handlers = [h for h in logging.getLogger().handlers
                if isinstance(h, logbuffer._BufferHandler)]
    assert len(handlers) == 1                        # no duplicate handlers
    print("✓ install() is idempotent (reload-safe)")


if __name__ == "__main__":
    test_buffer_captures_print_and_logging()
    test_grep_and_caps()
    test_registry_and_executor()
    test_install_idempotent()
    print("\n✓ All read_logs tests passed!")
