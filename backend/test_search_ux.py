"""Tests for the in-chat search UX fixes: date-grounded queries, search outcome
visibility, and recovery of tool calls the model writes as plain-text JSON."""

import os
import json
import time
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, inference
importlib.reload(db)
importlib.reload(main)


SCHEMAS = [{"type": "function", "function": {"name": "web_search"}},
           {"type": "function", "function": {"name": "fetch_url"}}]


def _scripted(rounds, captured=None):
    """Fake inference._iter_stream_events driven by per-round delta lists."""
    calls = {"i": 0}
    def fake(payload):
        if captured is not None:
            captured.append(payload)
        deltas = rounds[calls["i"]] if calls["i"] < len(rounds) else []
        calls["i"] += 1
        for d in deltas:
            yield ({}, d)
    return fake


def _run(rounds, execute, captured=None, max_rounds=12, **kw):
    orig = inference._iter_stream_events
    inference._iter_stream_events = _scripted(rounds, captured)
    try:
        return list(inference.generate_with_tools(
            "hi", None, None, SCHEMAS, execute, max_rounds=max_rounds, **kw))
    finally:
        inference._iter_stream_events = orig


def test_today_placeholder_substituted():
    descs = main._load_tool_descriptions()
    today = time.strftime("%Y-%m-%d")
    assert today in descs["web_search"]
    assert "{today}" not in descs["web_search"]
    # And it flows into the schemas the model actually receives (web_search only
    # registers when a SearXNG url is configured).
    cfg = config.get_config._config
    orig_url = cfg["tools"]["web_search"].get("url")
    cfg["tools"]["web_search"]["url"] = "http://searx.test"
    try:
        schemas, _, _ = main._build_tools(os.environ["DB_PATH"])
    finally:
        cfg["tools"]["web_search"]["url"] = orig_url
    ws = next(s for s in schemas if s["function"]["name"] == "web_search")
    assert today in ws["function"]["description"]
    print("✓ {today} placeholder resolved to the current date in tool schemas")


def test_parse_textual_tool_calls():
    p = inference._parse_textual_tool_calls
    known = {"web_search", "fetch_url"}
    want = [{"name": "web_search", "args": {"query": "boe governor"}}]
    assert p('{"name": "web_search", "arguments": {"query": "boe governor"}}', known) == want
    assert p('```json\n{"name": "web_search", "arguments": {"query": "boe governor"}}\n```', known) == want
    assert p('<tool_call>{"name": "web_search", "arguments": {"query": "boe governor"}}</tool_call>', known) == want
    # arguments serialized as a string, and the "parameters" alias
    assert p('{"name": "web_search", "arguments": "{\\"query\\": \\"boe governor\\"}"}', known) == want
    assert p('{"name": "web_search", "parameters": {"query": "boe governor"}}', known) == want
    # qwen3's XML-style format (seen live)
    xml = ("<tool_call>\n<function=web_search>\n<parameter=query>\n"
           "boe governor\n</parameter>\n</function>\n</tool_call>")
    assert p(xml, known) == want
    # not tool calls
    assert p("The governor is Andrew Bailey.", known) == []
    assert p('{"answer": 42}', known) == []
    assert p('{"name": "rm_rf", "arguments": {}}', known) == []
    assert p("<function=rm_rf>\n</function>", known) == []
    print("✓ textual tool-call parser accepts real calls, rejects everything else")


def test_textual_tool_call_recovered_not_streamed():
    """A tool call written as plain-text JSON executes instead of reaching the user."""
    blob = '{"name": "web_search", "arguments": {"query": "boe governor"}}'
    rounds = [
        [{"content": blob[:20]}, {"content": blob[20:]}],   # model writes JSON as text
        [{"content": "Andrew Bailey is the governor."}],
    ]
    executed = []
    def execute(name, args):
        executed.append((name, args))
        return json.dumps({"results": [{"title": "BoE", "url": "https://x", "snippet": ""}]})

    events = _run(rounds, execute)
    assert executed == [("web_search", {"query": "boe governor"})]
    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert "Andrew Bailey" in text
    assert '"name"' not in text and "{" not in text     # raw JSON never shown
    assert any(e["type"] == "status" and e.get("query") == "boe governor" for e in events)
    print("✓ plain-text JSON tool call executed, not streamed to the user")


def test_braced_answer_still_delivered():
    """Content that starts with '{' but isn't a tool call is flushed as tokens."""
    rounds = [[{"content": '{"answer": 42} is what '}, {"content": "the config expects."}]]
    events = _run(rounds, lambda n, a: "{}")
    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert text == '{"answer": 42} is what the config expects.'
    print("✓ non-tool-call JSON-looking answers are still delivered")


def test_prose_streams_immediately():
    rounds = [[{"content": "Hello "}, {"content": "world."}]]
    events = _run(rounds, lambda n, a: "{}")
    tokens = [e["content"] for e in events if e["type"] == "token"]
    assert tokens == ["Hello ", "world."]       # per-chunk, not batched at round end
    print("✓ ordinary prose is streamed chunk by chunk (no buffering penalty)")


def _tool_call(idx_id, name, arguments):
    return [{"tool_calls": [{"index": 0, "id": idx_id, "type": "function",
                             "function": {"name": name, "arguments": ""}}]},
            {"tool_calls": [{"index": 0, "function": {"arguments": arguments}}]}]


def test_outcome_events():
    """Each search yields a follow-up status: ok(count) / empty / error."""
    cases = [
        (json.dumps({"results": [{"title": "A"}, {"title": "B"}]}), "ok", 2),
        (json.dumps({"results": []}), "empty", 0),
        (json.dumps({"error": "web search failed: timeout"}), "error", None),
    ]
    for result, outcome, count in cases:
        rounds = [_tool_call("1", "web_search", json.dumps({"query": "x"})),
                  [{"content": "done"}]]
        events = _run(rounds, lambda n, a, r=result: r)
        out = [e for e in events if e["type"] == "status" and e.get("outcome")]
        assert len(out) == 1 and out[0]["outcome"] == outcome
        if count is not None:
            assert out[0]["count"] == count
        if outcome == "error":
            assert "timeout" in out[0]["error"]
    print("✓ outcome status events distinguish ok / empty / failed searches")


def test_start_status_has_structured_fields():
    rounds = [_tool_call("1", "fetch_url", json.dumps({"url": "https://ex.com/p"})),
              [{"content": "done"}]]
    events = _run(rounds, lambda n, a: json.dumps({"title": "Ex", "content": "hi"}))
    start = next(e for e in events if e["type"] == "status" and "outcome" not in e)
    assert start["url"] == "https://ex.com/p"
    print("✓ status events carry structured query/url fields for the frontend")


def test_xml_tool_call_recovered():
    """qwen's <function=...> text form is executed like a real tool call."""
    xml = ("<tool_call>\n<function=web_search>\n<parameter=query>\n"
           "boe governor\n</parameter>\n</function>\n</tool_call>")
    rounds = [
        [{"content": xml[:15]}, {"content": xml[15:]}],
        [{"content": "Answer from search."}],
    ]
    executed = []
    events = _run(rounds, lambda n, a: executed.append((n, a)) or
                  json.dumps({"results": [{"title": "x"}]}))
    assert executed == [("web_search", {"query": "boe governor"})]
    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert text == "Answer from search." and "<function" not in text
    print("✓ XML-style textual tool call executed, not streamed")


def test_final_round_tool_blob_suppressed():
    """If the forced final round still emits a tool-call blob, the user gets an
    honest sentence instead of raw XML/JSON."""
    xml = "<tool_call>\n<function=web_search>\n<parameter=query>\nx\n</parameter>\n</function>\n</tool_call>"
    rounds = [
        _tool_call("1", "web_search", json.dumps({"query": "x"})),
        [{"content": xml}],                       # final round: still trying to search
    ]
    events = _run(rounds, lambda n, a: json.dumps({"results": []}), max_rounds=1)
    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert "<function" not in text and "ran out of tool calls" in text
    print("✓ final-round tool-call blob replaced with an honest fallback")


def test_searxng_engine_failures_are_errors():
    """Zero results + every engine unresponsive => error, not 'no results'."""
    class FakeResp:
        def raise_for_status(self): pass
        def json(self):
            return {"results": [], "answers": [],
                    "unresponsive_engines": [["brave", "Suspended: too many requests"],
                                             ["duckduckgo", "CAPTCHA"]]}
    cfg = config.get_config._config
    cfg["tools"]["web_search"]["url"] = "http://searx.test"
    orig = inference.requests.get
    inference.requests.get = lambda *a, **k: FakeResp()
    try:
        out = inference.web_search_searxng("anything")
        assert "no engines responded" in out["error"] and "CAPTCHA" in out["error"]

        # But genuine zero-results (engines fine) stays a normal empty result.
        class EmptyOK(FakeResp):
            def json(self): return {"results": [], "answers": []}
        inference.requests.get = lambda *a, **k: EmptyOK()
        out = inference.web_search_searxng("gibberishquery")
        assert out == {"results": []}
    finally:
        inference.requests.get = orig
        cfg["tools"]["web_search"]["url"] = None
    print("✓ all-engines-down surfaces as a search FAILURE, real empties stay empty")


def test_final_round_nudge():
    """When tools are dropped (budget spent), the model is told to answer in prose."""
    rounds = [
        _tool_call("1", "web_search", json.dumps({"query": "x"})),
        [{"content": "final answer"}],
    ]
    captured = []
    _run(rounds, lambda n, a: json.dumps({"results": []}), captured, max_rounds=1)
    final_payload = captured[-1]
    assert "tools" not in final_payload
    nudges = [m for m in final_payload["messages"]
              if m["role"] == "system" and "no longer available" in m["content"]]
    assert len(nudges) == 1
    assert "plain prose" in nudges[0]["content"]
    print("✓ forced final round carries the answer-in-prose nudge, tools dropped")


if __name__ == "__main__":
    test_today_placeholder_substituted()
    test_parse_textual_tool_calls()
    test_textual_tool_call_recovered_not_streamed()
    test_braced_answer_still_delivered()
    test_prose_streams_immediately()
    test_outcome_events()
    test_start_status_has_structured_fields()
    test_xml_tool_call_recovered()
    test_final_round_tool_blob_suppressed()
    test_searxng_engine_failures_are_errors()
    test_final_round_nudge()
    print("\n✓ All search UX tests passed!")
