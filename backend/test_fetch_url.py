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
        assert state["fetch_count"] == 2

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
        cfg["tools"]["fetch_url"]["max_per_turn"] = 3
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


if __name__ == "__main__":
    test_html_extraction()
    test_link_extraction()
    test_guards()
    test_fetch_html_truncation_and_types()
    test_fetch_budget_and_same_domain()
    test_proxy_passed_through()
    test_registry_and_executor()
    print("\n✓ All fetch_url tests passed!")
