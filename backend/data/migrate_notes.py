"""CLI: migrate existing notes vaults to the 2026-10-12 tags/types format.

goal, question, decision and memory became plain tags and no note has a
manual state any more (NOTES-FORMAT.md, "What changed on 2026-10-12"). This
removes the top-level `state` and `due` frontmatter keys from every note.
Tags, every other key and the body are left byte-identical. Safe to re-run:
a migrated vault has nothing left to change.

    backend/.venv/bin/python backend/data/migrate_notes.py --dry-run
    backend/.venv/bin/python backend/data/migrate_notes.py
    backend/.venv/bin/python backend/data/migrate_notes.py --vault /path/to/vault

Without --vault it finds every vault the app would use (one per user under
authentication, else the single vault) and updates each one's notes index.
"""

import argparse
import os
import re
import shutil
import sqlite3
import sys
import tempfile

import yaml

backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)
from config import get_config, resolve_path, vault_dir_for  # noqa: E402
import notes_index  # noqa: E402

REMOVED_KEYS = ("state", "due")
_KEY_RE = re.compile(r"^(" + "|".join(REMOVED_KEYS) + r")\s*:")


def _split_front(raw: str):
    """(frontmatter text, rest starting at the closing '\\n---') or None,
    using the same boundary rule as notes_index.parse_note_file."""
    if not raw.startswith("---"):
        return None
    end = raw.find("\n---", 3)
    if end == -1:
        return None
    return raw[4:end], raw[end:]


def _drop_keys(front_text: str) -> str:
    """Remove top-level removed keys and their continuation lines (indented
    lines, or '- ' items of a block list, which YAML allows at column 0)."""
    out, skipping = [], False
    for line in front_text.split("\n"):
        if _KEY_RE.match(line):
            skipping = True
            continue
        if skipping and (line[:1] in (" ", "\t") or line.startswith("- ")
                         or line == "-"):
            continue
        skipping = False
        out.append(line)
    return "\n".join(out)


def migrate_note(path: str, dry_run: bool = False) -> dict:
    """Strip removed keys from one note. Returns {"removed": {key: value}}
    (empty when nothing applied) or {"skipped": reason}."""
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    parts = _split_front(raw)
    if parts is None:
        return {"removed": {}}
    front_text, rest = parts
    try:
        front = yaml.safe_load(front_text) or {}
    except yaml.YAMLError as e:
        return {"skipped": f"unreadable frontmatter ({e.__class__.__name__})"}
    if not isinstance(front, dict):
        return {"skipped": "frontmatter is not a mapping"}
    removed = {k: front[k] for k in REMOVED_KEYS if k in front}
    if not removed:
        return {"removed": {}}
    if dry_run:
        return {"removed": removed}

    kept = {k: v for k, v in front.items() if k not in REMOVED_KEYS}
    new_text = _drop_keys(front_text)
    try:
        exact = (yaml.safe_load(new_text) or {}) == kept
    except yaml.YAMLError:
        exact = False
    if not kept:
        # Nothing left: drop the whole block, the body starts the file.
        new_raw = rest[len("\n---"):].lstrip("\n")
    elif exact:
        new_raw = f"---\n{new_text}{rest}"
    else:
        # Unusual layout the line edit can't reproduce: re-dump the mapping.
        dumped = yaml.safe_dump(kept, default_flow_style=None, sort_keys=False,
                                allow_unicode=True).strip()
        new_raw = f"---\n{dumped}{rest}"

    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".migrate-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(new_raw)
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return {"removed": removed}


def _refresh_index(db_path: str, paths) -> int:
    """Re-index migrated notes that are already indexed, keeping their
    embeddings (the embedded text is title + aliases + body, unchanged here).
    Notes the index doesn't know yet are left for the app's own reindex,
    which embeds them."""
    if not paths or not os.path.exists(db_path):
        return 0
    conn = sqlite3.connect(db_path)
    try:
        try:
            known = {r[0] for r in conn.execute(
                "SELECT filename FROM notes_index").fetchall()}
        except sqlite3.OperationalError:
            return 0                       # no index yet: nothing to refresh
        n = 0
        for path in paths:
            if os.path.basename(path) in known:
                notes_index.index_note_file(conn, path, embed_fn=None)
                n += 1
        return n
    finally:
        conn.close()


def migrate_vault(vault_dir: str, db_path: str = None,
                  dry_run: bool = False, out=print) -> dict:
    """Migrate every note in one vault. Returns counts."""
    stats = {"notes": 0, "changed": 0, "skipped": 0, "reindexed": 0}
    if not os.path.isdir(vault_dir):
        return stats
    changed_paths = []
    for name in sorted(os.listdir(vault_dir)):
        if not name.endswith(".md") or name.startswith("."):
            continue
        path = os.path.join(vault_dir, name)
        stats["notes"] += 1
        result = migrate_note(path, dry_run=dry_run)
        if "skipped" in result:
            stats["skipped"] += 1
            out(f"  skipped {name}: {result['skipped']}")
        elif result["removed"]:
            stats["changed"] += 1
            changed_paths.append(path)
            values = ", ".join(f"{k}={v}" for k, v in result["removed"].items())
            out(f"  {'would strip' if dry_run else 'stripped'} {name}: {values}")
    if not dry_run and db_path:
        stats["reindexed"] = _refresh_index(db_path, changed_paths)
    return stats


def find_vaults(cfg: dict):
    """(vault_dir, db_path) for every vault the app would serve."""
    auth_enabled = cfg.get("authentication", {}).get("enabled", False)
    configured = cfg.get("notes", {}).get("vault_dir")
    if auth_enabled:
        users_dir = cfg.get("authentication", {}).get("users_dir")
        users_dir = resolve_path(users_dir or "backend/data/users")
        if not os.path.isdir(users_dir):
            return []
        pairs = []
        for user_hash in sorted(os.listdir(users_dir)):
            db_path = os.path.join(users_dir, user_hash, "conversations.db")
            if os.path.isfile(db_path):
                pairs.append((vault_dir_for(db_path, configured, True), db_path))
        return pairs
    db_path = cfg.get("memory", {}).get("db_path")
    db_path = resolve_path(db_path or "backend/data/conversations.db")
    return [(vault_dir_for(db_path, configured, False), db_path)]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Strip removed frontmatter (state, due) from notes vaults")
    parser.add_argument("--dry-run", action="store_true",
                        help="show what would change, write nothing")
    parser.add_argument("--vault", action="append",
                        help="migrate this vault directory only (repeatable); "
                             "its index is not touched")
    args = parser.parse_args(argv)

    pairs = ([(v, None) for v in args.vault] if args.vault
             else find_vaults(get_config()))
    if not pairs:
        print("No vaults found.")
        return 0
    total = {"notes": 0, "changed": 0, "skipped": 0, "reindexed": 0}
    for vault, db_path in pairs:
        print(f"{vault}")
        stats = migrate_vault(vault, db_path, dry_run=args.dry_run)
        for k in total:
            total[k] += stats[k]
    verb = "would change" if args.dry_run else "changed"
    print(f"{len(pairs)} vault(s), {total['notes']} note(s): {total['changed']} "
          f"{verb}, {total['skipped']} skipped, {total['reindexed']} re-indexed")
    return 1 if total["skipped"] else 0


if __name__ == "__main__":
    sys.exit(main())
