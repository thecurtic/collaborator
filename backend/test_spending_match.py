"""Tests for product matching (spending_match.py): approved lines only,
alias → decision model (two orders) → chat model, unsure marking, and
corrections that remap and log. No live model: every call is faked."""

import json

import pytest

import decision
import inference
import spending
import spending_match as sm
from test_spending import GROCERY, _Resp, _fresh


def _committed(dbp, receipt=GROCERY, approve=True):
    r, problems = spending.normalize(json.loads(json.dumps(receipt)))
    assert not problems
    tx = spending.record_receipt(dbp, r, image_path="x.png", image_mime="image/png",
                                 image_hash=None, extracted=receipt, caption=None)["transaction_id"]
    if approve:
        spending.approve(dbp, tx)
    return tx


def _lines(dbp, tx):
    return spending.get_transaction(dbp, tx)["line_items"]


# What the chat model knows: printed text → (name, brand, category, sure).
KNOWN = {
    "CLASSICO TOM BASIL": ("tomato basil pasta sauce", "Classico", "pasta sauce", True),
    "KICKING HORSE 454G": ("coffee beans", "Kicking Horse", "coffee", True),
    "SPARKLING WTR 12PK": ("sparkling water", None, "water", False),
}


@pytest.fixture
def models(monkeypatch):
    """Faked embeddings (none), chat model and decision model. Returns the
    call log; set `calls["decide"]` to a function (options) -> (choice, p)."""
    calls = {"chat": [], "decision": [], "decide": None}
    monkeypatch.setattr(inference, "embed_texts", lambda texts: [None] * len(texts))
    monkeypatch.setattr(inference, "get_embedding", lambda text: None)

    def complete(messages, fmt):
        line = messages[1]["content"].rsplit("Line: ", 1)[1]
        calls["chat"].append(line)
        name, brand, cat, sure = KNOWN[line]
        return json.dumps({"product_id": None, "name": name, "brand": brand,
                           "category": cat, "sure": sure})
    monkeypatch.setattr(spending, "_complete", complete)

    def post(url, json=None, timeout=None):
        q = json["questions"][0]
        options = [c["value"] for c in q["choices"]]
        calls["decision"].append(options)
        pick, p = calls["decide"](options)
        probs = [{"value": v, "probability": p if v == pick else (1 - p) / max(len(options) - 1, 1)}
                 for v in options]
        return _Resp({"answers": [{"type": "choice", "name": q["name"], "choice": pick,
                                   "probabilities": probs, "confidence": p}]})
    monkeypatch.setattr(decision.requests, "post", post)
    return calls


def test_only_approved_lines_are_matched(models):
    c, cfg, dbp = _fresh()
    _committed(dbp, approve=False)
    assert sm.unmatched_lines(dbp) == [] and sm.run_once(dbp) == {}
    assert models["chat"] == []


def test_first_receipt_is_labelled_by_the_chat_model_then_aliases_take_over(models):
    c, cfg, dbp = _fresh()
    tx = _committed(dbp)
    assert sm.run_once(dbp) == {"chat": 2, "unsure": 1}
    lines = _lines(dbp, tx)
    assert lines[1]["product"] == {"id": lines[1]["product_id"], "name": "coffee beans",
                                   "brand": "Kicking Horse", "category": "coffee"}
    assert [l["match"] for l in lines] == ["chat", "chat", "unsure"]
    # The same store, printed the same way: sure labels are aliases now; the
    # unsure one isn't, so it's asked again.
    models["chat"].clear()
    tx2 = _committed(dbp)
    assert sm.run_once(dbp) == {"alias": 2, "unsure": 1}
    assert models["chat"] == ["SPARKLING WTR 12PK"]
    assert _lines(dbp, tx2)[1]["product_id"] == lines[1]["product_id"]
    # No product is made twice.
    conn = spending.connect(dbp)
    assert conn.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 3
    conn.close()


def test_decision_model_picks_when_both_orders_agree(models):
    c, cfg, dbp = _fresh()
    cfg["decision"]["model"] = "decider"
    conn = spending.connect(dbp)
    coffee = sm.new_product(conn, "coffee beans", "Kicking Horse", "coffee")
    conn.commit(); conn.close()
    other = dict(GROCERY, store={"name": "Thrifty Foods", "address": None, "store_number": None},
                 line_items=[GROCERY["line_items"][1]], charges=[], subtotal=15.49, total=15.49)
    models["decide"] = lambda options: (f"p{coffee}", 0.93)
    tx = _committed(dbp, other)
    assert sm.run_once(dbp) == {"model": 1}
    assert models["chat"] == []
    assert len(models["decision"]) == 2 and models["decision"][0][:-1] == models["decision"][1][:-1][::-1]
    assert _lines(dbp, tx)[0]["product_id"] == coffee
    conn = spending.connect(dbp)
    log = conn.execute("SELECT task, model, answer, used FROM decision_log").fetchall()
    alias = conn.execute("SELECT source FROM aliases").fetchone()
    conn.close()
    assert [tuple(r) for r in log] == [("match", "decider", f"p{coffee}", 1)]
    assert alias["source"] == "model"


def test_order_disagreement_goes_to_the_chat_model(models):
    c, cfg, dbp = _fresh()
    cfg["decision"]["model"] = "decider"
    conn = spending.connect(dbp)
    sm.new_product(conn, "coffee beans", "Kicking Horse", "coffee")
    sm.new_product(conn, "orange pekoe tea", "Tetley", "tea")
    conn.commit(); conn.close()
    one = dict(GROCERY, line_items=[GROCERY["line_items"][1]], charges=[], subtotal=15.49, total=15.49)
    models["decide"] = lambda options: (options[0], 0.9)     # whatever is listed first
    _committed(dbp, one)
    assert sm.run_once(dbp) == {"chat": 1}
    assert models["chat"] == ["KICKING HORSE 454G"]
    conn = spending.connect(dbp)
    used = [r[0] for r in conn.execute("SELECT used FROM decision_log ORDER BY id")]
    conn.close()
    assert used == [0, 1]            # the decision model's, then the chat model's


def test_correction_remaps_logs_and_becomes_the_alias(models):
    c, cfg, dbp = _fresh()
    tx = _committed(dbp)
    sm.run_once(dbp)
    tx2 = _committed(dbp)
    sm.run_once(dbp)
    water = _lines(dbp, tx)[2]
    assert {u["id"] for u in sm.unsure_lines(dbp)} == {water["id"], _lines(dbp, tx2)[2]["id"]}

    r = c.put(f"/api/spending/lines/{water['id']}/product",
              json={"new": {"name": "sparkling water", "brand": "Bubly", "category": "water"}})
    assert r.status_code == 200
    assert sorted(r.json()["lines"]) == sorted([water["id"], _lines(dbp, tx2)[2]["id"]])
    for t in (tx, tx2):
        line = _lines(dbp, t)[2]
        assert line["match"] == "user" and line["product"]["brand"] == "Bubly"
    assert sm.unsure_lines(dbp) == []
    conn = spending.connect(dbp)
    corrected = conn.execute("SELECT COUNT(*) FROM decision_log WHERE corrected_to IS NOT NULL").fetchone()[0]
    alias = conn.execute("SELECT source FROM aliases WHERE raw_text = 'SPARKLING WTR 12PK'").fetchone()
    conn.close()
    assert corrected == 2 and alias["source"] == "user"
    # Next time, the user's label is a plain lookup.
    models["chat"].clear()
    _committed(dbp)
    sm.run_once(dbp)
    assert models["chat"] == []

    assert c.put(f"/api/spending/lines/{water['id']}/product", json={}).status_code == 422
    assert c.put("/api/spending/lines/9999/product", json={"product_id": 1}).status_code == 404


def test_confident_label_can_be_corrected_to_an_existing_product(models):
    c, cfg, dbp = _fresh()
    tx = _committed(dbp)
    sm.run_once(dbp)
    found = c.get("/api/spending/products", params={"q": "pasta"}).json()["products"]
    assert [p["name"] for p in found] == ["tomato basil pasta sauce"]
    coffee_line = _lines(dbp, tx)[1]
    r = c.put(f"/api/spending/lines/{coffee_line['id']}/product", json={"product_id": found[0]["id"]})
    assert r.status_code == 200 and _lines(dbp, tx)[1]["product"]["name"] == "tomato basil pasta sauce"


def test_a_chat_model_failure_is_retried_later(models, monkeypatch):
    c, cfg, dbp = _fresh()
    _committed(dbp)
    monkeypatch.setattr(spending, "_complete", lambda *a: (_ for _ in ()).throw(RuntimeError("down")))
    assert sm.run_once(dbp) == {"failed": 1}        # stops at the first failure
    assert len(sm.unmatched_lines(dbp)) == 3
    for _ in range(sm.MAX_TRIES):
        sm.run_once(dbp)
    assert len(sm.unmatched_lines(dbp)) == 2        # the first line gave up


def test_seed_categories_and_endpoints(models):
    c, cfg, dbp = _fresh()
    cats = c.get("/api/spending/categories").json()["categories"]
    assert {"coffee", "pasta sauce"} <= {x["name"] for x in cats}
    assert c.get("/api/spending/labels/unsure").json() == {"lines": []}


# --- Web search on unsure labels ------------------------------------------------


@pytest.fixture
def searching(models, monkeypatch):
    """Search faked (each test configures brave after _fresh); the chat
    model is sure once it has results. Returns the queries sent."""
    queries = []
    def web_search(query, limit=None, provider=None):
        queries.append((query, provider))
        return {"results": [{"title": "bubly Sparkling Water, Lime, 12 x 355 mL",
                             "snippet": "Unsweetened sparkling water.", "url": "https://x"}]}
    monkeypatch.setattr(inference, "web_search", web_search)
    plain = spending._complete
    def complete(messages, fmt):
        if "Web search results" in messages[1]["content"]:
            return json.dumps({"product_id": None, "name": "sparkling water", "brand": "Bubly",
                               "category": "water", "sure": True})
        return plain(messages, fmt)
    monkeypatch.setattr(spending, "_complete", complete)
    return queries


def test_unsure_label_is_searched_and_looked_at_again(searching):
    c, cfg, dbp = _fresh()
    cfg["tools"]["web_search"].update(provider="brave", brave_api_key="k")
    tx = _committed(dbp)
    assert sm.run_once(dbp) == {"chat": 3}
    assert searching == [("SPARKLING WTR 12PK Safeway", "brave")]   # store name kept
    water = _lines(dbp, tx)[2]
    assert water["match"] == "chat" and water["product"]["brand"] == "Bubly"
    conn = spending.connect(dbp)
    models_logged = [r[0] for r in conn.execute("SELECT model FROM decision_log ORDER BY id")]
    conn.close()
    assert models_logged[-1].endswith("+search")
    # Searched once: the next receipt resolves by alias, and a repeat query
    # would come from the cache.
    assert sm.search(dbp, "SPARKLING WTR 12PK Safeway")[0]["title"].startswith("bubly")
    assert len(searching) == 1


def test_search_respects_the_setting_and_the_provider(searching):
    c, cfg, dbp = _fresh()
    cfg["tools"]["web_search"].update(provider="brave", brave_api_key="k")
    r = c.get("/api/spending/settings").json()
    assert r == {"settings": {"search_fallback": True}, "search_provider": "brave"}
    assert c.put("/api/spending/settings", json={"search_fallback": False}).json()["settings"] == \
        {"search_fallback": False}
    tx = _committed(dbp)
    assert sm.run_once(dbp) == {"chat": 2, "unsure": 1} and searching == []
    # Back on, but the configured provider has no credential: no search.
    spending.set_settings(dbp, {"search_fallback": True})
    cfg["spending"]["search_provider"] = "searxng"
    cfg["tools"]["web_search"]["url"] = None
    assert sm.search_provider() is None
    cfg["tools"]["web_search"]["url"] = "http://searx.invalid"
    assert sm.search_provider() == "searxng"
    with pytest.raises(ValueError):
        spending.set_settings(dbp, {"search_fallback": "yes"})


def test_old_unsure_labels_get_one_searched_look(searching):
    c, cfg, dbp = _fresh()
    spending.set_settings(dbp, {"search_fallback": False})     # labelled with search off
    tx = _committed(dbp)
    assert sm.run_once(dbp) == {"chat": 2, "unsure": 1}
    cfg["tools"]["web_search"].update(provider="brave", brave_api_key="k")
    spending.set_settings(dbp, {"search_fallback": True})
    assert sm.run_once(dbp) == {"searched chat": 1}
    water = _lines(dbp, tx)[2]
    assert water["match"] == "chat" and water["product"]["brand"] == "Bubly"
    assert sm.run_once(dbp) == {} and len(searching) == 1        # never looked at twice


def test_new_category_takes_its_tags_and_the_pick_is_logged(models, monkeypatch):
    c, cfg, dbp = _fresh()
    def complete(messages, fmt):
        prompt = messages[0]["content"]
        assert "Categories to choose from:" in prompt and "coffee" in prompt
        assert "Tags in use" in prompt and "beverages" in prompt
        return json.dumps({"product_id": None, "name": "kombucha", "brand": "GT's",
                           "category": "fermented drinks", "tags": ["beverages", "made-up"],
                           "sure": True})
    monkeypatch.setattr(spending, "_complete", complete)
    one = dict(GROCERY, line_items=[{"raw_text": "GTS KOMBUCHA", "qty": 1, "unit_price": 4.5,
                                     "line_total": 4.5}], charges=[], subtotal=4.5, total=4.5)
    tx = _committed(dbp, one)
    assert sm.run_once(dbp) == {"chat": 1}
    cats = {x["name"]: x["tags"] for x in c.get("/api/spending/categories").json()["categories"]}
    assert cats["fermented drinks"] == ["beverages"]        # only tags that exist
    assert cats["coffee"] == ["beverages", "breakfast", "groceries"]
    conn = spending.connect(dbp)
    row = conn.execute("SELECT answer, options FROM decision_log WHERE task = 'category'").fetchone()
    conn.close()
    assert row["answer"] == "fermented drinks" and row["options"] == len(spending.SEED_CATEGORIES)


def test_category_options_are_capped(models):
    c, cfg, dbp = _fresh()
    cfg["spending"]["category_options"] = 5
    conn = spending.connect(dbp)
    coffee = sm.new_product(conn, "coffee beans", "Kicking Horse", "coffee")
    opts = sm.category_options(conn, "KICKING HORSE 454G",
                               [{"id": coffee, "name": "coffee beans", "brand": "Kicking Horse",
                                 "category": "coffee"}])
    conn.close()
    assert len(opts) == 5 and "coffee" in opts               # the candidates' own always kept


def test_an_approved_purchase_can_be_deleted(models):
    c, cfg, dbp = _fresh()
    tx = _committed(dbp)
    sm.run_once(dbp)
    assert c.delete(f"/api/spending/transactions/{tx}").status_code == 200
    assert c.get(f"/api/spending/transactions/{tx}").status_code == 404
    assert c.get("/api/spending/labels/unsure").json() == {"lines": []}
    conn = spending.connect(dbp)
    assert conn.execute("SELECT COUNT(*) FROM line_items").fetchone()[0] == 0
    conn.close()


def test_an_approved_purchase_can_be_edited_after_the_fact(models):
    c, cfg, dbp = _fresh()
    tx = _committed(dbp)
    sm.run_once(dbp)
    before = _lines(dbp, tx)
    sauce, coffee = before[0], before[1]

    fixed = json.loads(json.dumps(GROCERY))
    fixed["store"]["address"] = "Cambie and 7th"
    fixed["line_items"][1]["raw_text"] = "KICKING HORSE 454G "          # spacing only
    fixed["line_items"][2]["raw_text"] = "SPARKLING WATER 12PK"         # misread, fixed
    fixed["line_items"][0]["line_total"] = fixed["line_items"][0]["unit_price"] = 5.49
    fixed["subtotal"], fixed["total"] = 29.17, 29.59
    r = c.put(f"/api/spending/transactions/{tx}", json={"receipt": fixed})
    assert r.status_code == 200
    out = r.json()["transaction"]
    assert out["status"] == "committed" and out["amount_cents"] == 2959
    assert out["store_address"] == "Cambie and 7th"
    lines = out["line_items"]
    # Unchanged lines keep their row and label; the price change came along.
    assert lines[0]["id"] == sauce["id"] and lines[0]["product"] == sauce["product"]
    assert lines[0]["line_total_cents"] == 549
    assert lines[1]["id"] == coffee["id"] and lines[1]["match"] == coffee["match"]
    # The corrected line starts unlabelled and the matcher picks it up.
    assert lines[2]["match"] is None and lines[2]["product"] is None
    assert sm.unmatched_lines(dbp) == [lines[2]["id"]]
    # The deposit charge still points at the third line.
    assert out["charges"][0]["line_index"] == 2

    # Only approved purchases are edited here; a bad edit is refused.
    pending = _committed(dbp, approve=False)
    assert c.put(f"/api/spending/transactions/{pending}", json={"receipt": fixed}).status_code == 404
    assert c.put(f"/api/spending/transactions/{tx}", json={"receipt": dict(fixed, total=None)}).status_code == 422
    assert c.put(f"/api/spending/transactions/{tx}", json={}).status_code == 422
