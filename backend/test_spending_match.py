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
