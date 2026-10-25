"""The tool-call log: every tool call Collaborator's own model makes.

An audit trail first ("was that call innocent?"), usage stats second. One row
per call, written by the code as each call finishes (generate_with_tools'
on_tool_call hook), so a turn that errors or is later discarded still leaves
its trace. Agent backends on the agent seam never pass through here: only the
model's own tool loop does.

Boundaries this module keeps:
  - The model can't reach it. No tool reads, edits or deletes these rows
    (read_logs reads the in-memory ring buffer, not this table).
  - Arguments are kept in full: they ARE the audit (what it searched, which
    URL, what it wanted to pay or write). Results are kept as their size and
    a short preview only (tools.log.preview_chars): the vault and the
    transcripts are the source of truth, not a second copy here.
  - Blocked and malformed calls are logged too: an attempt is what matters.
  - Rows are kept forever; without full results they stay small.

Each call gets a category by what it can do; money, outbound, writes and
anything unrecognized form the "risk" scope the view can narrow to.
"""

import json
import sqlite3
from typing import Dict, List, Optional

from config import get_config

# What a tool can do. Unknown tools land in "other", which counts as risk.
_CATEGORY = {
    "ditta_search": "money",
    "web_search": "outbound", "fetch_url": "outbound",
    "screenshot_page": "outbound", "git_issue": "outbound",
    "propose_note": "writes", "propose_edit": "writes",
    "stage_note_send": "writes",
    "recall_semantic": "reads", "recall_keyword": "reads",
    "search_notes": "reads", "get_note": "reads", "get_notes": "reads",
    "graph_notes": "reads", "list_events": "reads", "read_logs": "reads",
    "git_read": "reads", "list_transcripts": "reads",
    "read_transcript": "reads", "list_attachments": "reads",
    "read_attachment": "reads", "read_agent_messages": "reads",
    "run_report": "reads", "read_run_log": "reads",
    "calculate": "compute", "datetime": "compute", "synthesize": "compute",
}
CATEGORIES = ("money", "outbound", "writes", "reads", "compute", "other")
RISK_CATEGORIES = ("money", "outbound", "writes", "other")

SORTS = {
    "time": "c.ts {o}, c.id {o}",
    "tool": "c.tool {o}, c.ts DESC",
    "category": "c.category {o}, c.ts DESC",
    "duration": "c.duration_ms IS NULL, c.duration_ms {o}, c.ts DESC",
    "outcome": "c.outcome {o}, c.ts DESC",
    "uses": "uses {o}, c.tool, c.ts DESC",
}

# Result keys whose empty list means "ran, found nothing".
_RESULT_LISTS = ("results", "matches", "notes", "events", "messages",
                 "transcripts", "attachments", "items")


def _cfg() -> Dict:
    return (get_config().get("tools") or {}).get("log") or {}


def enabled() -> bool:
    return bool(_cfg().get("enabled", True))


def category(name: str, args: Optional[Dict] = None) -> str:
    """What this call can do. A few tools depend on their arguments."""
    args = args or {}
    if name == "wallet":
        action = args.get("action") or "get_balance"
        return "reads" if action == "get_balance" else "money"
    if name == "transcribe_video":
        # With a URL it downloads; without, it searches the saved ones.
        return "outbound" if (args.get("url") or "").strip() else "reads"
    return _CATEGORY.get(name, "other")


def ensure_schema(conn) -> None:
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tool_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL DEFAULT (datetime('now')),
            run_id TEXT,
            source TEXT NOT NULL DEFAULT 'chat',
            root_id INTEGER,
            turn_id INTEGER,
            round INTEGER,
            tool TEXT NOT NULL,
            category TEXT NOT NULL,
            args TEXT,
            outcome TEXT NOT NULL,
            error TEXT,
            result_chars INTEGER,
            result_preview TEXT,
            duration_ms INTEGER,
            recovered INTEGER NOT NULL DEFAULT 0,
            model TEXT,
            trigger TEXT,
            backfilled INTEGER NOT NULL DEFAULT 0
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(ts)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id)")
    cur.execute("CREATE TABLE IF NOT EXISTS tool_log_meta "
                "(key TEXT PRIMARY KEY, value TEXT)")
    conn.commit()
    if not cur.execute("SELECT 1 FROM tool_log_meta WHERE key = 'backfilled'"
                       ).fetchone():
        _backfill(conn)


def _backfill(conn) -> None:
    """One-time: the per-reply "Sources" records that predate this log
    (turns.tool_activity) become rows marked backfilled: no duration, no
    preview, arguments only as far as Sources kept them."""
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(turns)").fetchall()}
    if "tool_activity" in cols:
        parents = dict(cur.execute("SELECT id, parent_turn_id FROM turns").fetchall())

        def root_of(tid):
            seen = set()
            while parents.get(tid) is not None and tid not in seen:
                seen.add(tid)
                tid = parents[tid]
            return tid

        rows = cur.execute("""
            SELECT a.id, a.created_at, a.model_name, a.tool_activity, u.content
            FROM turns a LEFT JOIN turns u ON u.id = a.parent_turn_id
            WHERE a.tool_activity IS NOT NULL ORDER BY a.id""").fetchall()
        for tid, ts, model, raw, trigger in rows:
            try:
                activity = json.loads(raw) or []
            except Exception:
                continue
            for entry in activity:
                name = entry.get("tool")
                if not name:
                    continue
                args = {k: entry[k] for k in ("query", "url", "title") if entry.get(k)}
                cur.execute("""
                    INSERT INTO tool_calls (ts, run_id, source, root_id, turn_id,
                        tool, category, args, outcome, error, model, trigger,
                        backfilled)
                    VALUES (?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                    (ts, f"backfill-{tid}", root_of(tid), tid, name,
                     category(name, args), json.dumps(args),
                     entry.get("outcome") or "unknown", entry.get("error"),
                     model, _snippet(trigger)))
    cur.execute("INSERT OR REPLACE INTO tool_log_meta (key, value) "
                "VALUES ('backfilled', datetime('now'))")
    conn.commit()


def _snippet(text: Optional[str], n: int = 300) -> Optional[str]:
    if not text:
        return None
    text = " ".join(text.split())
    return text if len(text) <= n else text[:n] + "…"


def classify_result(result: str):
    """(outcome, error) from a tool's result string: error | empty | ok."""
    try:
        data = json.loads(result)
    except Exception:
        return "ok", None
    if isinstance(data, dict):
        if data.get("error"):
            return "error", str(data["error"])[:500]
        if data.get("count") == 0 or any(
                isinstance(data.get(k), list) and not data[k] for k in _RESULT_LISTS):
            return "empty", None
    elif isinstance(data, list) and not data:
        return "empty", None
    return "ok", None


def recorder(db_path: str, source: str, run_id: str,
             trigger: Optional[str] = None, model: Optional[str] = None):
    """An on_tool_call callback for generate_with_tools, bound to one run.
    Never raises: a logging failure must not break a turn."""
    if not enabled():
        return None
    preview_chars = int(_cfg().get("preview_chars", 400))
    trigger = _snippet(trigger)
    if model is None:
        try:
            model = get_config()["inference"]["model_id"]
        except Exception:
            model = None

    def record(call: Dict) -> None:
        try:
            name = call["tool"]
            args = call.get("args")
            result = call.get("result") or ""
            if call.get("args_error"):
                outcome, error = "error", call["args_error"]
                args_json = json.dumps({"_unparsed": (call.get("raw_args") or "")[:4000]})
            else:
                outcome, error = classify_result(result)
                args_json = json.dumps(args or {}, ensure_ascii=False)
            preview = result if len(result) <= preview_chars else result[:preview_chars] + "…"
            conn = sqlite3.connect(db_path)
            try:
                conn.execute("""
                    INSERT INTO tool_calls (run_id, source, round, tool, category,
                        args, outcome, error, result_chars, result_preview,
                        duration_ms, recovered, model, trigger)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (run_id, source, call.get("round"), name,
                     category(name, args), args_json, outcome, error,
                     len(result), preview, call.get("duration_ms"),
                     1 if call.get("recovered") else 0,
                     model, trigger))
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            print(f"Warning: tool log write failed: {e}")

    return record


def attach_turn(conn, run_id: str, turn_id: int, root_id: Optional[int]) -> None:
    """Link a run's calls to the reply they belong to, once it exists."""
    conn.execute("UPDATE tool_calls SET turn_id = ?, root_id = ? "
                 "WHERE run_id = ? AND turn_id IS NULL",
                 (turn_id, root_id, run_id))
    conn.commit()


def _label(name: str, args: Dict) -> str:
    from inference import _tool_status_label
    try:
        return _tool_status_label(name, args or {}).rstrip("…").strip()
    except Exception:
        return name


def _row(r: sqlite3.Row, full: bool = False) -> Dict:
    try:
        args = json.loads(r["args"]) if r["args"] else {}
    except Exception:
        args = {}
    d = {k: r[k] for k in ("id", "ts", "source", "root_id", "turn_id", "round",
                           "tool", "category", "outcome", "error",
                           "result_chars", "duration_ms", "model")}
    d.update(args=args, label=_label(r["tool"], args),
             risk=r["category"] in RISK_CATEGORIES,
             recovered=bool(r["recovered"]), backfilled=bool(r["backfilled"]),
             trigger=r["trigger"])
    if "uses" in r.keys():
        d["uses"] = r["uses"]
    if full:
        d["result_preview"] = r["result_preview"]
        d["run_id"] = r["run_id"]
    return d


def _where(*, tool=None, category=None, risk=False, outcome=None, source=None,
           model=None, since=None, until=None, q=None):
    clauses, params = [], []
    if tool:
        clauses.append("c.tool = ?"); params.append(tool)
    if category:
        clauses.append("c.category = ?"); params.append(category)
    if risk:
        clauses.append(f"c.category IN ({','.join('?' * len(RISK_CATEGORIES))})")
        params.extend(RISK_CATEGORIES)
    if outcome:
        clauses.append("c.outcome = ?"); params.append(outcome)
    if source:
        clauses.append("c.source = ?"); params.append(source)
    if model:
        clauses.append("c.model = ?"); params.append(model)
    if since:
        clauses.append("c.ts >= ?"); params.append(since)
    if until:
        clauses.append("c.ts < ?"); params.append(until)
    if q:
        for word in q.split():
            clauses.append("(c.args LIKE ? OR c.tool LIKE ? OR c.trigger LIKE ?)")
            params.extend([f"%{word}%"] * 3)
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", params


def list_calls(conn, *, sort: str = "time", order: str = "desc",
               limit: int = 100, offset: int = 0, **filters) -> Dict:
    """One page of calls plus the filtered total. Sorts: time, tool, category,
    duration, outcome, uses (how often that tool appears in the filtered set)."""
    if sort not in SORTS:
        raise ValueError(f"sort must be one of {', '.join(SORTS)}")
    o = "ASC" if order == "asc" else "DESC"
    where, params = _where(**filters)
    conn.row_factory = sqlite3.Row
    total = conn.execute(f"SELECT COUNT(*) FROM tool_calls c{where}", params).fetchone()[0]
    rows = conn.execute(f"""
        WITH f AS (SELECT c.* FROM tool_calls c{where}),
             u AS (SELECT tool, COUNT(*) AS uses FROM f GROUP BY tool)
        SELECT c.*, u.uses FROM f c JOIN u ON u.tool = c.tool
        ORDER BY {SORTS[sort].format(o=o)} LIMIT ? OFFSET ?""",
        params + [limit, offset]).fetchall()
    return {"calls": [_row(r) for r in rows], "total": total}


def get_call(conn, call_id: int) -> Optional[Dict]:
    conn.row_factory = sqlite3.Row
    r = conn.execute("SELECT * FROM tool_calls WHERE id = ?", (call_id,)).fetchone()
    if not r:
        return None
    d = _row(r, full=True)
    # Whether the reply it belongs to still exists (a discarded turn may not).
    d["turn_exists"] = bool(d["turn_id"]) and bool(conn.execute(
        "SELECT 1 FROM turns WHERE id = ?", (d["turn_id"],)).fetchone())
    # The other calls in the same run, in order: the call's context.
    d["siblings"] = [{"id": s[0], "tool": s[1], "outcome": s[2]} for s in conn.execute(
        "SELECT id, tool, outcome FROM tool_calls WHERE run_id = ? ORDER BY id",
        (r["run_id"],)).fetchall()] if r["run_id"] else []
    return d


def _p95(values: List[int]) -> Optional[int]:
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int(round(0.95 * (len(values) - 1))))]


def stats(conn, **filters) -> Dict:
    """Usage per tool and overall, over the filtered set."""
    where, params = _where(**filters)
    rows = conn.execute(f"""
        SELECT c.tool, c.category, c.outcome, c.duration_ms, c.result_chars,
               c.ts, c.source, c.model, c.recovered, substr(c.ts, 1, 10)
        FROM tool_calls c{where} ORDER BY c.ts""", params).fetchall()
    tools: Dict[str, Dict] = {}
    totals = {"calls": 0, "errors": 0, "empty": 0, "risk": 0, "recovered": 0,
              "by_category": {}, "by_source": {}, "by_model": {}}
    days: Dict[str, int] = {}
    durations: Dict[str, List[int]] = {}
    for tool, cat, outcome, ms, chars, ts, source, model, recovered, day in rows:
        t = tools.setdefault(tool, {
            "tool": tool, "category": cat, "risk": cat in RISK_CATEGORIES,
            "count": 0, "errors": 0, "empty": 0, "recovered": 0,
            "first_used": ts, "last_used": ts, "result_chars": 0})
        t["count"] += 1
        t["errors"] += outcome == "error"
        t["empty"] += outcome == "empty"
        t["recovered"] += bool(recovered)
        t["last_used"] = ts
        t["result_chars"] += chars or 0
        if ms is not None:
            durations.setdefault(tool, []).append(ms)
        totals["calls"] += 1
        totals["errors"] += outcome == "error"
        totals["empty"] += outcome == "empty"
        totals["risk"] += cat in RISK_CATEGORIES
        totals["recovered"] += bool(recovered)
        for key, val in (("by_category", cat), ("by_source", source),
                         ("by_model", model or "unknown")):
            totals[key][val] = totals[key].get(val, 0) + 1
        days[day] = days.get(day, 0) + 1
    for name, t in tools.items():
        ds = durations.get(name) or []
        t["avg_ms"] = round(sum(ds) / len(ds)) if ds else None
        t["p95_ms"] = _p95(ds)
        t["avg_result_chars"] = round(t.pop("result_chars") / t["count"])
        t["error_rate"] = round(t["errors"] / t["count"], 3)
    return {"tools": sorted(tools.values(), key=lambda t: -t["count"]),
            "totals": totals,
            "daily": [{"day": d, "count": n} for d, n in sorted(days.items())]}

