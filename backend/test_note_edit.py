"""Tests for editing approved notes: body/tags, rename + inbound-link rewriting."""

import os
import sqlite3
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, notes_index
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def _fake_embed(texts):
    return [[float(len(t)), 1.0] for t in texts]


def _fresh():
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(tempfile.mkdtemp(), "vault")
    config.get_config._config = cfg
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    main.embed_texts = _fake_embed
    vault = cfg["notes"]["vault_dir"]
    os.makedirs(vault, exist_ok=True)

    def write(title, body, extra_front=""):
        with open(os.path.join(vault, f"{title}.md"), "w", encoding="utf-8") as f:
            f.write(f"---\ncreated: 2026-07-08\ntags: [concept]\nsource_turns: [4]\n"
                    f"{extra_front}---\n\n# {title}\n\n{body}\n")
    write("Alpha", "See [[Beta]] and also [[Beta|the beta note]].")
    write("Beta", "Standalone claim.")
    write("Gamma", "Unrelated.", extra_front="custom_key: keep-me\n")
    conn = sqlite3.connect(path)
    notes_index.reindex_vault(conn, vault, embed_fn=_fake_embed)
    conn.close()
    return TestClient(main.app), vault


def test_body_and_tags_edit_preserves_frontmatter():
    c, vault = _fresh()
    r = c.patch("/api/notes/Gamma", json={"body": "Rewritten body with [[Alpha]].",
                                          "tags": ["Open Question", "databases"]})
    assert r.status_code == 200
    note = r.json()["note"]
    assert note["body"] == "Rewritten body with [[Alpha]]."
    assert note["tags"] == ["open-question", "databases"]      # normalized
    assert note["links"] == ["Alpha"]                          # reindexed immediately

    raw = open(os.path.join(vault, "Gamma.md"), encoding="utf-8").read()
    assert "custom_key: keep-me" in raw                        # unknown key preserved
    assert "source_turns" in raw and "created:" in raw         # provenance kept
    assert raw.count("# Gamma") == 1
    print("✓ body/tags edit: normalized tags, frontmatter (incl. unknown keys) preserved")


def test_rename_rewrites_inbound_links():
    c, vault = _fresh()
    r = c.patch("/api/notes/Beta", json={"title": "Beta prime"})
    assert r.status_code == 200
    out = r.json()
    assert out["renamed"] is True and out["links_rewritten"] == ["Alpha"]

    # Old file gone, new file present; index follows.
    assert not os.path.exists(os.path.join(vault, "Beta.md"))
    assert os.path.exists(os.path.join(vault, "Beta prime.md"))
    assert c.get("/api/notes/Beta").status_code == 404
    renamed = c.get("/api/notes/Beta prime").json()["note"]
    assert [b["title"] for b in renamed["backlinks"]] == ["Alpha"]

    # Both link forms rewritten in the linker's file.
    alpha_raw = open(os.path.join(vault, "Alpha.md"), encoding="utf-8").read()
    assert "[[Beta prime]]" in alpha_raw and "[[Beta prime|the beta note]]" in alpha_raw
    assert "[[Beta]]" not in alpha_raw and "[[Beta|" not in alpha_raw
    print("✓ rename: file moved, index updated, inbound [[links]] (incl. alias) rewritten")


def test_rename_validation():
    c, vault = _fresh()
    assert c.patch("/api/notes/Beta", json={"title": "Alpha"}).status_code == 409   # collision
    assert c.patch("/api/notes/Beta", json={"title": "bad [chars]"}).status_code == 422
    assert c.patch("/api/notes/Missing", json={"body": "x"}).status_code == 404
    # Case-only self-rename is not a collision with itself.
    r = c.patch("/api/notes/Beta", json={"title": "BETA"})
    assert r.status_code == 200 and r.json()["note"]["title"] == "BETA"
    print("✓ rename validation: collision 409, bad chars 422, missing 404, self-case ok")


if __name__ == "__main__":
    test_body_and_tags_edit_preserves_frontmatter()
    test_rename_rewrites_inbound_links()
    test_rename_validation()
    print("\n✓ All note-edit tests passed!")
