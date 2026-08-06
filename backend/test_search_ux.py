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
    # Call style with a positional arg (seen live, unclosed tags included).
    assert p('<tool_call>\n<function=web_search("boe governor")\n</function>', known) == want
    assert p('<function=web_search("boe governor")>', known) == want
    # Call style with kwargs; positional maps to the tool's primary param.
    assert p('<function=fetch_url(url="https://x.example/p")</function>', known) == \
        [{"name": "fetch_url", "args": {"url": "https://x.example/p"}}]
    assert p("<function=fetch_url('https://x.example/p')", known) == \
        [{"name": "fetch_url", "args": {"url": "https://x.example/p"}}]
    # JSON body inside function tags.
    assert p('<function=web_search>{"query": "boe governor"}</function>', known) == want
    # not tool calls
    assert p("The governor is Andrew Bailey.", known) == []
    assert p('{"answer": 42}', known) == []
    assert p('{"name": "rm_rf", "arguments": {}}', known) == []
    assert p("<function=rm_rf>\n</function>", known) == []
    assert p('<function=rm_rf("x")>', known) == []
    print("✓ textual tool-call parser accepts real calls, rejects everything else")


def test_prose_then_blob_intercepted():
    """The reported failure: prose first, then a textual tool call — the prose
    must stream, the blob must execute instead of reaching the user."""
    prose = "I'll quickly verify the ownership structure and key facts.\n\n"
    blob = ('<tool_call>\n<function=web_search("GCT Global Container Terminals '
            'ownership CK Hutchison China")  \n</function>')
    whole = prose + blob
    rounds = [
        # split awkwardly so the marker straddles a chunk boundary
        [{"content": whole[:30]}, {"content": whole[30:68]},
         {"content": whole[68:75]}, {"content": whole[75:]}],
        [{"content": "GCT is owned by ..."}],
    ]
    executed = []
    events = _run(rounds, lambda n, a: executed.append((n, a)) or
                  json.dumps({"results": [{"title": "x"}]}))
    assert executed == [("web_search",
                         {"query": "GCT Global Container Terminals ownership "
                                   "CK Hutchison China"})]
    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert "I'll quickly verify" in text            # prose delivered
    assert "<tool_call" not in text and "<function" not in text
    assert "GCT is owned by" in text                # real answer streamed after
    print("✓ prose + textual tool call: prose streams, call executes, blob hidden")


def test_prose_mentioning_function_still_delivered():
    """Mid-prose marker that is NOT a real call gets delivered, not eaten."""
    msg = "In JS you might write <function=foo> style pseudo-tags, which is invalid."
    rounds = [[{"content": msg[:40]}, {"content": msg[40:]}]]
    events = _run(rounds, lambda n, a: "{}")
    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert text == msg
    print("✓ false-alarm markers in prose are still delivered verbatim")


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
    rounds = [[{"content": "Hello there my friend, "}, {"content": "how are you today?"}]]
    events = _run(rounds, lambda n, a: "{}")
    tokens = [e["content"] for e in events if e["type"] == "token"]
    assert "".join(tokens) == "Hello there my friend, how are you today?"
    # Streaming still incremental: text flows during the round (a small tail is
    # withheld for marker detection), not one blob at round end.
    assert len(tokens) >= 2
    print("✓ ordinary prose streams incrementally and is delivered verbatim")


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


def test_minimax_xml_tool_call_recovered():
    """MiniMax's native <minimax:tool_call>/<invoke> form executes, with invented
    argument keys ("input_string") repaired onto the tool's real parameter."""
    xml = ('<minimax:tool_call>\n<invoke name="web_search">\n'
           '<parameter name="input_string">boe governor</parameter>\n'
           '</invoke>\n</minimax:tool_call>')
    rounds = [
        [{"content": xml[:18]}, {"content": xml[18:]}],
        [{"content": "Answer from search."}],
    ]
    executed = []
    events = _run(rounds, lambda n, a: executed.append((n, a)) or
                  json.dumps({"results": [{"title": "x"}]}))
    assert executed == [("web_search", {"query": "boe governor"})]
    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert text == "Answer from search." and "invoke" not in text
    print("✓ minimax XML tool call executed with repaired argument names")


def test_minimax_prose_then_blob_intercepted():
    """Mid-prose <minimax:tool_call> markers arm the guard like <tool_call>."""
    msg = ('Let me check.\n<minimax:tool_call>\n<invoke name="web_search">\n'
           '<parameter name="query">x</parameter>\n</invoke>\n</minimax:tool_call>')
    rounds = [
        [{"content": msg[:20]}, {"content": msg[20:]}],
        [{"content": "Done."}],
    ]
    executed = []
    events = _run(rounds, lambda n, a: executed.append((n, a)) or
                  json.dumps({"results": []}))
    assert executed == [("web_search", {"query": "x"})]
    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert "minimax" not in text and "invoke" not in text
    print("✓ mid-prose minimax blob intercepted and executed")


def test_unknown_tool_name_corrected_not_shown():
    """A structurally-valid call to a nonexistent tool ("memoryrecall") is never
    shown to the user; the model is corrected with the real tool list and the
    loop continues."""
    xml = ('<minimax:tool_call>\n<invoke name="memoryrecall">\n'
           '<parameter name="input_string">chronicle</parameter>\n'
           '</invoke>\n</minimax:tool_call>')
    rounds = [
        [{"content": xml}],
        [{"content": "Here is what I found."}],
    ]
    captured = []
    events = _run(rounds, lambda n, a: json.dumps({}), captured=captured)
    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert text == "Here is what I found."
    assert "memoryrecall" not in text and "invoke" not in text
    assert any(e["type"] == "status" and "unknown tool" in e.get("label", "")
               for e in events)
    # The correction round told the model the real tool list.
    correction = captured[1]["messages"][-1]
    assert correction["role"] == "system"
    assert "do not exist" in correction["content"]
    assert "web_search" in correction["content"]
    print("✓ unknown-tool blob suppressed; model corrected with real tool list")


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
        assert out["results"] == [] and "error" not in out
        assert out["engines"] == {"responded": {}, "failed": []}
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


def test_manual_search_endpoint():
    """GET /api/search: user-driven search, independent of the tool loop."""
    from starlette.testclient import TestClient
    c = TestClient(main.app)
    cfg = config.get_config._config
    orig_url = cfg["tools"]["web_search"].get("url")

    # Unconfigured -> 503; blank query -> 400.
    cfg["tools"]["web_search"]["url"] = None
    assert c.get("/api/search", params={"q": "x"}).status_code == 503
    cfg["tools"]["web_search"]["url"] = "http://searx.test"
    try:
        assert c.get("/api/search", params={"q": "   "}).status_code == 400

        class FakeResp:
            def raise_for_status(self): pass
            def json(self):
                return {"results": [{"title": f"R{i}", "url": f"https://e.com/{i}",
                                     "content": "snippet", "engine": "mojeek"}
                                    for i in range(30)],
                        "answers": ["direct answer"]}
        orig_get = inference.requests.get
        inference.requests.get = lambda *a, **k: FakeResp()
        try:
            r = c.get("/api/search", params={"q": "collaborator", "limit": 2})
            assert r.status_code == 200
            body = r.json()
            assert body["query"] == "collaborator"
            assert len(body["results"]) == 2
            assert body["results"][0]["title"] == "R0"
            assert body["answers"] == ["direct answer"]

            # limit clamps to 20; omitted limit falls back to config (5).
            assert len(c.get("/api/search", params={"q": "x", "limit": 999}).json()["results"]) == 20
            assert len(c.get("/api/search", params={"q": "x"}).json()["results"]) == 5

            # Backend failure -> 502 with the reason.
            class DownResp(FakeResp):
                def json(self):
                    return {"results": [], "answers": [],
                            "unresponsive_engines": [["brave", "CAPTCHA"]]}
            inference.requests.get = lambda *a, **k: DownResp()
            r = c.get("/api/search", params={"q": "x"})
            assert r.status_code == 502 and "no engines responded" in r.json()["detail"]
        finally:
            inference.requests.get = orig_get
    finally:
        cfg["tools"]["web_search"]["url"] = orig_url
    print("✓ GET /api/search: 400/503/502 paths + results, limit clamp, config default")


if __name__ == "__main__":
    test_today_placeholder_substituted()
    test_parse_textual_tool_calls()
    test_prose_then_blob_intercepted()
    test_prose_mentioning_function_still_delivered()
    test_textual_tool_call_recovered_not_streamed()
    test_braced_answer_still_delivered()
    test_prose_streams_immediately()
    test_outcome_events()
    test_start_status_has_structured_fields()
    test_xml_tool_call_recovered()
    test_final_round_tool_blob_suppressed()
    test_searxng_engine_failures_are_errors()
    test_final_round_nudge()
    test_manual_search_endpoint()
    print("\n✓ All search UX tests passed!")
