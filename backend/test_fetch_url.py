"""Tests for the fetch_url tool: extraction, guards, truncation, registry."""

import os
import json
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, inference
importlib.reload(db)
importlib.reload(main)


def test_strip_tracking_params():
    from inference import strip_tracking_params as strip
    assert (strip("https://x.com/a?utm_source=nl&id=5&fbclid=abc")
            == "https://x.com/a?id=5")
    assert strip("https://x.com/a?gclid=1") == "https://x.com/a"
    assert strip("https://youtu.be/xyz?si=share123") == "https://youtu.be/xyz"
    assert (strip("https://x.com/search?q=utm+tags&page=2")
            == "https://x.com/search?q=utm+tags&page=2")   # functional params kept
    assert strip("https://x.com/a") == "https://x.com/a"
    assert strip("") == ""
    # Links harvested from pages come back stripped too.
    html = ('<html><body><a href="https://ex.com/read?id=7&utm_campaign=x">a</a>'
            "</body></html>")
    _, _, links = inference._HtmlTextExtractor().extract(html)
    assert links == [{"text": "a", "url": "https://ex.com/read?id=7"}]
    print("✓ tracking params stripped from URLs and harvested links")


def test_html_extraction():
    html = """<html><head><title>My Page</title><style>p{color:red}</style>
    <script>alert('hi')</script></head><body>
    <h1>Heading</h1><p>First para.</p><div>Second <b>bold</b> bit.</div>
    <script>var x = 'never show this';</script></body></html>"""
    title, text, links = inference._HtmlTextExtractor().extract(html)
    assert title == "My Page"
    assert "Heading" in text and "First para." in text and "bold" in text
    assert "alert" not in text and "color:red" not in text and "never show" not in text
    assert links == []
    print("✓ extractor: title captured, scripts/styles stripped, text kept")


def test_link_extraction():
    html = """<body>
    <a href="/relative/page">Relative link</a>
    <a href="https://other.example/x#frag">Absolute with fragment</a>
    <a href="https://other.example/x">Duplicate after defrag</a>
    <a href="javascript:alert(1)">JS link</a>
    <a href="mailto:a@b.c">Mail</a>
    <a href="#section">Fragment only</a>
    <script><a href="https://hidden.example">inside script</a></script>
    </body>"""
    _, _, links = inference._HtmlTextExtractor().extract(
        html, base_url="https://site.example/dir/page", max_links=10)
    urls = [l["url"] for l in links]
    assert urls == ["https://site.example/relative/page", "https://other.example/x"]
    assert links[0]["text"] == "Relative link"

    # Cap respected.
    many = "".join(f'<a href="https://e.com/{i}">L{i}</a>' for i in range(100))
    _, _, links = inference._HtmlTextExtractor().extract(many, base_url="https://e.com", max_links=5)
    assert len(links) == 5
    print("✓ links: resolved absolute, defragged, deduped, js/mailto dropped, capped")


def test_guards():
    assert "only http(s)" in inference.fetch_url("ftp://example.com/x")["error"]
    assert "only http(s)" in inference.fetch_url("not a url")["error"]
    # Private/loopback blocked by default...
    out = inference.fetch_url("http://127.0.0.1:8001/api/health")
    assert "private/internal" in out["error"]
    # ...unless allow_private is enabled (mock the HTTP so nothing real is hit).
    class FakeResp:
        url = "http://127.0.0.1:8001/api/health"
        headers = {"content-type": "application/json"}
        encoding = "utf-8"
        def raise_for_status(self): pass
        def iter_content(self, n): yield b'{"status":"healthy"}'
    cfg = config.get_config._config
    cfg["tools"]["fetch_url"]["allow_private"] = True
    orig = inference.requests.get
    inference.requests.get = lambda *a, **k: FakeResp()
    try:
        out = inference.fetch_url("http://127.0.0.1:8001/api/health")
    finally:
        inference.requests.get = orig
        cfg["tools"]["fetch_url"]["allow_private"] = False
    assert out["content"] == '{"status":"healthy"}'
    print("✓ guards: scheme + private-host blocked; allow_private opens tailnet/LAN")


def test_fetch_html_truncation_and_types():
    cfg = config.get_config._config
    cfg["tools"]["fetch_url"]["max_chars"] = 50

    def resp(ctype, payload):
        class R:
            url = "https://example.com/page"
            headers = {"content-type": ctype}
            encoding = "utf-8"
            def raise_for_status(self): pass
            def iter_content(self, n): yield payload
        return R()

    orig = inference.requests.get
    try:
        inference.requests.get = lambda *a, **k: resp(
            "text/html", b"<html><head><title>T</title></head><body><p>" +
            b"word " * 100 + b"</p></body></html>")
        out = inference.fetch_url("https://example.com/page")
        assert out["title"] == "T" and out["truncated"] is True and len(out["content"]) == 50

        inference.requests.get = lambda *a, **k: resp("application/pdf", b"%PDF-1.4")
        assert "unsupported content type" in inference.fetch_url("https://example.com/f.pdf")["error"]

        inference.requests.get = lambda *a, **k: (_ for _ in ()).throw(
            inference.requests.exceptions.ConnectionError("refused"))
        assert "fetch failed" in inference.fetch_url("https://example.com/x")["error"]
    finally:
        inference.requests.get = orig
        cfg["tools"]["fetch_url"]["max_chars"] = 8000
    print("✓ fetch: html parsed + truncated flag; pdf rejected; errors are tool-level")


def test_fetch_budget_and_same_domain():
    cfg = config.get_config._config
    orig_budget = cfg["tools"]["fetch_url"]["max_per_turn"]
    cfg["tools"]["fetch_url"]["max_per_turn"] = 2

    def ok_resp(url):
        class R:
            headers = {"content-type": "text/html"}
            encoding = "utf-8"
            def raise_for_status(self): pass
            def iter_content(self, n): yield b"<html><body>hi</body></html>"
        R.url = url
        return R()

    orig = inference.requests.get
    inference.requests.get = lambda url, **k: ok_resp(url)
    try:
        _, execute, state = main._build_tools(os.environ["DB_PATH"])
        assert "error" not in json.loads(execute("fetch_url", {"url": "https://a.example/1"}))
        assert "error" not in json.loads(execute("fetch_url", {"url": "https://b.example/2"}))
        out = json.loads(execute("fetch_url", {"url": "https://c.example/3"}))
        assert "budget" in out["error"]                      # third fetch refused
        assert "listing" in out["instruction"]               # model told to report links
        assert state["fetch_count"] == 2
        assert state["denied_fetches"] == ["https://c.example/3"]   # recorded for the UI

        # same_domain_only: second fetch must stay on the first host.
        cfg["tools"]["fetch_url"]["same_domain_only"] = True
        _, execute, state = main._build_tools(os.environ["DB_PATH"])
        assert "error" not in json.loads(execute("fetch_url", {"url": "https://a.example/1"}))
        out = json.loads(execute("fetch_url", {"url": "https://b.example/2"}))
        assert "cross-domain" in out["error"]
        assert "error" not in json.loads(execute("fetch_url", {"url": "https://a.example/9"}))
    finally:
        inference.requests.get = orig
        cfg["tools"]["fetch_url"]["same_domain_only"] = False
        cfg["tools"]["fetch_url"]["max_per_turn"] = orig_budget
    print("✓ per-turn fetch budget enforced; same_domain_only guards cross-domain hops")


def test_proxy_passed_through():
    cfg = config.get_config._config
    cfg["tools"]["fetch_url"]["proxy"] = "socks5h://tor.example:9050"
    captured = {}
    class R:
        url = "https://x.example"
        headers = {"content-type": "text/plain"}
        encoding = "utf-8"
        def raise_for_status(self): pass
        def iter_content(self, n): yield b"ok"
    orig = inference.requests.get
    inference.requests.get = lambda url, **k: captured.update(k) or R()
    try:
        inference.fetch_url("https://x.example")
    finally:
        inference.requests.get = orig
        cfg["tools"]["fetch_url"]["proxy"] = None
    assert captured["proxies"] == {"http": "socks5h://tor.example:9050",
                                   "https": "socks5h://tor.example:9050"}
    print("✓ proxy config routes fetches (privacy hook ready for Tor/VPN)")


def _webtool_resp(content, url="https://example.com/page"):
    class R:
        def raise_for_status(self): pass
        def json(self): return {"url": url, "content": content}
    return R()


def test_webtool_routing():
    """webtool_url set -> fetches go through the Playwright service (POST /fetch,
    raw HTML), links still extracted, and failures NEVER fall back to direct."""
    cfg = config.get_config._config
    cfg["tools"]["fetch_url"]["webtool_url"] = "http://search-vm:8200"
    posts = []
    html = ('<html><head><title>VPN Page</title></head><body><p>' + 'word ' * 60 +
            '</p><a href="/next">Next</a></body></html>')

    def fake_post(url, json=None, timeout=None, **k):
        posts.append({"endpoint": url, "body": json, "timeout": timeout})
        return _webtool_resp(html)

    orig_post, orig_get = inference.requests.post, inference.requests.get
    def no_get(*a, **k):
        raise AssertionError("direct fetch attempted while webtool configured")
    inference.requests.post, inference.requests.get = fake_post, no_get
    try:
        out = inference.fetch_url("https://example.com/page")
        assert out["title"] == "VPN Page" and out["via"] == "webtool"
        assert "word" in out["content"]
        assert out["links"] == [{"text": "Next", "url": "https://example.com/next"}]
        assert posts[0]["endpoint"] == "http://search-vm:8200/fetch"
        assert posts[0]["body"] == {"url": "https://example.com/page",
                                    "text_only": False, "wait_ms": 0}
        assert posts[0]["timeout"] == 60

        # Guards run BEFORE the webtool: private hosts still refused, no request.
        posts.clear()
        assert "private/internal" in inference.fetch_url("http://127.0.0.1/x")["error"]
        assert posts == []

        # Webtool down -> error naming the webtool; still no direct fallback.
        def down(*a, **k):
            raise inference.requests.exceptions.ConnectionError("refused")
        inference.requests.post = down
        out = inference.fetch_url("https://example.com/page")
        assert "webtool" in out["error"]
    finally:
        inference.requests.post, inference.requests.get = orig_post, orig_get
        cfg["tools"]["fetch_url"]["webtool_url"] = None
    print("✓ webtool routing: POST /fetch, links preserved, fail-closed, guards first")


def test_webtool_empty_page_retries_with_settle():
    """A near-empty first render triggers one retry with wait_ms=2500 (SPA settle)."""
    cfg = config.get_config._config
    cfg["tools"]["fetch_url"]["webtool_url"] = "http://search-vm:8200"
    calls = []
    full = "<html><title>App</title><body>" + "loaded content " * 30 + "</body></html>"

    def fake_post(url, json=None, **k):
        calls.append(json["wait_ms"])
        return _webtool_resp("<html><body></body></html>" if json["wait_ms"] == 0 else full)

    orig = inference.requests.post
    inference.requests.post = fake_post
    try:
        out = inference.fetch_url("https://app.example/spa")
        assert calls == [0, 2500]
        assert "loaded content" in out["content"] and out["title"] == "App"
    finally:
        inference.requests.post = orig
        cfg["tools"]["fetch_url"]["webtool_url"] = None
    print("✓ webtool: near-empty render auto-retries once with 2.5s JS settle")


def test_screenshot_page():
    """screenshot_page: webtool /screenshot -> vision model; gated, budgeted."""
    cfg = config.get_config._config
    cfg["tools"]["fetch_url"]["webtool_url"] = "http://search-vm:8200"
    cfg["inference"]["vision"] = True    # the chat model reads images
    posts = []

    def fake_post(url, json=None, timeout=None, **k):
        posts.append({"endpoint": url, "body": json})
        class R:
            def raise_for_status(self): pass
            def json(self_inner):
                if url.endswith("/screenshot"):
                    return {"url": json["url"], "text": "Pricing: Pro $9/mo",
                            "screenshot_b64": "aGk="}
                return {"choices": [{"message": {"content":
                        "A pricing page with three tiers; Pro is $9/month."}}]}
        return R()

    orig_post = inference.requests.post
    inference.requests.post = fake_post
    try:
        out = inference.screenshot_page("https://example.com/pricing",
                                        "what does the pricing table say?")
        assert out["visual"].startswith("A pricing page")
        assert out["page_text_excerpt"] == "Pricing: Pro $9/mo"
        assert out["via"] == "webtool"
        # First hop: webtool /screenshot. Second: vision chat with image + question.
        assert posts[0]["endpoint"].endswith("/screenshot")
        vision = posts[1]["body"]
        assert vision["model"] == cfg["inference"]["model_id"]
        parts = vision["messages"][0]["content"]
        assert parts[0]["image_url"]["url"] == "data:image/png;base64,aGk="
        assert parts[1]["text"] == "what does the pricing table say?"

        # Guards still first: private host refused before any request.
        posts.clear()
        assert "private/internal" in inference.screenshot_page("http://10.0.0.1/x")["error"]
        assert posts == []
    finally:
        inference.requests.post = orig_post
        cfg["tools"]["fetch_url"]["webtool_url"] = None
        cfg["inference"].pop("vision", None)
    print("✓ screenshot_page: webtool + vision chained, question passed, guards first")


def test_screenshot_gating_and_shared_budget():
    cfg = config.get_config._config
    cfg["inference"]["vision"] = False
    # Gated off without webtool_url, and without a chat model that sees.
    schemas, _, _ = main._build_tools(os.environ["DB_PATH"])
    assert "screenshot_page" not in {s["function"]["name"] for s in schemas}
    cfg["tools"]["fetch_url"]["webtool_url"] = "http://search-vm:8200"
    schemas, _, _ = main._build_tools(os.environ["DB_PATH"])
    assert "screenshot_page" not in {s["function"]["name"] for s in schemas}
    cfg["inference"]["vision"] = True
    orig_budget = cfg["tools"]["fetch_url"]["max_per_turn"]
    cfg["tools"]["fetch_url"]["max_per_turn"] = 1
    try:
        schemas, execute, state = main._build_tools(os.environ["DB_PATH"])
        assert "screenshot_page" in {s["function"]["name"] for s in schemas}

        def fake_post(url, json=None, **k):
            class R:
                def raise_for_status(self): pass
                def json(self_inner):
                    if url.endswith("/screenshot"):
                        return {"url": json["url"], "text": "t", "screenshot_b64": "aGk="}
                    return {"choices": [{"message": {"content": "looks fine"}}]}
            return R()
        orig_post = inference.requests.post
        inference.requests.post = fake_post
        try:
            out = json.loads(execute("screenshot_page", {"url": "https://a.example/1"}))
            assert out["visual"] == "looks fine" and state["fetch_count"] == 1
            # Budget shared with fetch_url: second page (either tool) is denied.
            out = json.loads(execute("screenshot_page", {"url": "https://b.example/2"}))
            assert "budget" in out["error"]
            assert state["denied_fetches"] == ["https://b.example/2"]
        finally:
            inference.requests.post = orig_post
    finally:
        cfg["tools"]["fetch_url"]["max_per_turn"] = orig_budget
        cfg["tools"]["fetch_url"]["webtool_url"] = None
        cfg["inference"].pop("vision", None)
    print("✓ screenshot_page: self-gating + shares the per-turn fetch budget")


def test_registry_and_executor():
    schemas, execute, _ = main._build_tools(os.environ["DB_PATH"])
    assert "fetch_url" in {s["function"]["name"] for s in schemas}

    config.get_config._config["tools"]["available"]["fetch_url"] = False
    schemas, _, _ = main._build_tools(os.environ["DB_PATH"])
    assert "fetch_url" not in {s["function"]["name"] for s in schemas}
    config.get_config._config["tools"]["available"]["fetch_url"] = True

    out = json.loads(execute("fetch_url", {"url": "gopher://x"}))
    assert "error" in out
    print("✓ registry gating + executor path")


def _scripted(rounds):
    """Fake inference._iter_stream_events driven by per-round delta lists."""
    calls = {"i": 0}
    def fake(payload):
        deltas = rounds[calls["i"]] if calls["i"] < len(rounds) else []
        calls["i"] += 1
        for d in deltas:
            yield ({}, d)
    return fake


def _tool_call(idx_id, name, arguments):
    return [{"tool_calls": [{"index": 0, "id": idx_id, "type": "function",
                             "function": {"name": name, "arguments": ""}}]},
            {"tool_calls": [{"index": 0, "function": {"arguments": arguments}}]}]


def test_unfollowed_links_sse_event():
    """Budget-denied links surface as an unfollowed_links SSE event."""
    from starlette.testclient import TestClient
    cfg = config.get_config._config
    cfg["tools"]["enabled"] = True
    orig_budget = cfg["tools"]["fetch_url"]["max_per_turn"]
    cfg["tools"]["fetch_url"]["max_per_turn"] = 1

    def ok_resp(url):
        class R:
            headers = {"content-type": "text/html"}
            encoding = "utf-8"
            def raise_for_status(self): pass
            def iter_content(self, n): yield b"<html><body>page</body></html>"
        R.url = url
        return R()

    rounds = [
        _tool_call("1", "fetch_url", json.dumps({"url": "https://a.example/1"})),
        _tool_call("2", "fetch_url", json.dumps({"url": "https://b.example/2"})),   # denied
        [{"content": "Done — I couldn't read b.example, continue?"}],
    ]
    orig_stream, orig_get = inference._iter_stream_events, inference.requests.get
    inference._iter_stream_events = _scripted(rounds)
    inference.requests.get = lambda url, **k: ok_resp(url)
    try:
        c = TestClient(main.app)
        r = c.post("/api/messages", json={"message": "read these", "recall": True})
    finally:
        inference._iter_stream_events = orig_stream
        inference.requests.get = orig_get
        cfg["tools"]["enabled"] = False
        cfg["tools"]["fetch_url"]["max_per_turn"] = orig_budget

    events = [json.loads(l[6:]) for l in r.text.splitlines() if l.startswith("data: ")]
    ev = next(e for e in events if e["type"] == "unfollowed_links")
    assert ev["links"] == ["https://b.example/2"]
    assert any(e["type"] == "done" for e in events)
    print("✓ unfollowed_links SSE event carries budget-denied URLs")


def test_tools_work_in_voice_mode():
    """mode='voice' does not gate tools: search + answer flow works."""
    from starlette.testclient import TestClient
    cfg = config.get_config._config
    cfg["tools"]["enabled"] = True

    rounds = [
        _tool_call("1", "recall_keyword", json.dumps({"query": "anything"})),
        [{"content": "Spoken answer, plain prose."}],
    ]
    orig = inference._iter_stream_events
    inference._iter_stream_events = _scripted(rounds)
    try:
        c = TestClient(main.app)
        r = c.post("/api/messages", json={"message": "what did we decide?",
                                          "mode": "voice", "recall": True})
    finally:
        inference._iter_stream_events = orig
        cfg["tools"]["enabled"] = False

    events = [json.loads(l[6:]) for l in r.text.splitlines() if l.startswith("data: ")]
    types = [e["type"] for e in events]
    assert "status" in types and "token" in types and "done" in types
    # And the voice layer rides along with tools active.
    msgs = inference._build_messages("x", mode="voice", include_tools_guidance=True)
    system = msgs[0]["content"].lower()
    assert "voice mode" in system and "tools" in system
    print("✓ tools run in voice mode; voice layer + tools guidance coexist")


if __name__ == "__main__":
    test_html_extraction()
    test_link_extraction()
    test_guards()
    test_fetch_html_truncation_and_types()
    test_fetch_budget_and_same_domain()
    test_proxy_passed_through()
    test_webtool_routing()
    test_webtool_empty_page_retries_with_settle()
    test_screenshot_page()
    test_screenshot_gating_and_shared_budget()
    test_registry_and_executor()
    test_unfollowed_links_sse_event()
    test_tools_work_in_voice_mode()
    print("\n✓ All fetch_url tests passed!")


def test_fetch_paging_and_engine_report():
    from unittest.mock import patch, MagicMock
    import inference

    long_body = "".join(f"w{i:05d} " for i in range(3000))   # ~21k chars
    html = f"<html><head><title>Long</title></head><body><p>{long_body}</p><a href='https://x.com/a'>a</a></body></html>"
    def mock_get(*a, **k):
        r = MagicMock()
        r.raise_for_status = MagicMock()
        r.iter_content = lambda n: iter([html.encode()])
        r.headers = {"content-type": "text/html"}
        r.encoding = "utf-8"
        r.url = "https://ex.com/long"
        return r

    cfg = __import__("config").get_config()["tools"]["fetch_url"]
    orig_max = cfg.get("max_chars", 8000)
    cfg["max_chars"] = 5000
    try:
        with patch("requests.get", side_effect=mock_get):
            p1 = inference.fetch_url("https://ex.com/long")
            p2 = inference.fetch_url("https://ex.com/long", chunk=2)
        assert p1["chunk"] == 1 and p1["total_chunks"] >= 4
        assert p1["truncated"] and "chunk=2" in p1["note"]
        assert p2["content"] != p1["content"]                 # actually advances
        assert p1["links"] and p2["links"] == []              # links on part 1 only
    finally:
        cfg["max_chars"] = orig_max

    # Engine health present on SUCCESSFUL searches too.
    def mock_searx(*a, **k):
        r = MagicMock()
        r.raise_for_status = MagicMock()
        r.json = lambda: {"results": [{"title": "t", "url": "https://r", "content": "s",
                                       "engine": "brave"}],
                          "unresponsive_engines": [["duckduckgo", "CAPTCHA"]]}
        return r
    wcfg = __import__("config").get_config()["tools"]["web_search"]
    orig_url = wcfg.get("url")
    wcfg["url"] = "http://searx.test"
    try:
        with patch("requests.get", side_effect=mock_searx):
            out = inference.web_search_searxng("q")
        assert out["engines"]["responded"] == {"brave": 1}
        assert out["engines"]["failed"] == [{"engine": "duckduckgo", "reason": "CAPTCHA"}]
    finally:
        wcfg["url"] = orig_url
    print("✓ fetch paging (distinct parts, links once) + always-on engine report")
