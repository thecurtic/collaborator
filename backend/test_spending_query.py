"""Tests for the chat model's spending tools (spending_query.py): names
resolve to ids first, SQL does the sums, and the summary carries its own
caveats. No model involved."""

import json

import main
import spending
import spending_match as sm
import spending_query as sq
from test_spending import GROCERY, _fresh


def _receipt(dbp, store, lines, *, day="2026-10-20", card="1234", approve=True):
    r = json.loads(json.dumps(GROCERY))
    r["store"] = {"name": store, "address": None, "store_number": None}
    r["datetime"] = f"{day}T12:00"
    r["line_items"] = [{"raw_text": t, "qty": 1, "unit_price": a, "line_total": a} for t, a, _ in lines]
    r["charges"] = []
    r["subtotal"] = r["total"] = round(sum(a for _, a, _ in lines), 2)
    r["payment"]["last_four"] = card
    n, problems = spending.normalize(r)
    assert not problems
    tx = spending.record_receipt(dbp, n, image_path="x.png", image_mime=None, image_hash=None,
                                 extracted=r, caption=None)["transaction_id"]
    if approve:
        spending.approve(dbp, tx)
    conn = spending.connect(dbp)
    for line, (_, _, label) in zip(conn.execute("SELECT id FROM line_items WHERE transaction_id = ? "
                                                "ORDER BY position", (tx,)).fetchall(), lines):
        if label:
            name, brand, cat, match = label
            pid = sm.new_product(conn, name, brand, cat)
            conn.execute("UPDATE line_items SET product_id = ?, match = ? WHERE id = ?",
                         (pid, match, line["id"]))
    conn.commit(); conn.close()
    return tx


KH = ("coffee beans", "Kicking Horse", "coffee", "chat")
ST = ("dark roast beans", "Starbucks", "coffee", "unsure")
SAUCE = ("tomato basil pasta sauce", "Classico", "pasta sauce", "alias")


def _data():
    c, cfg, dbp = _fresh()
    _receipt(dbp, "Safeway", [("KICKING HORSE 454G", 15.49, KH), ("CLASSICO TOM BASIL", 4.99, SAUCE)])
    _receipt(dbp, "Safeway", [("SBUX DRK RST", 12.99, ST)], day="2026-10-22", card="9999")
    _receipt(dbp, "Thrifty Foods", [("KICKING HORSE 454G", 16.99, KH), ("MYSTERY ITEM", 3.00, None)],
             day="2026-10-25", card="9999")
    _receipt(dbp, "Safeway", [("KICKING HORSE 454G", 15.49, None)], day="2026-10-26", approve=False)
    return c, cfg, dbp


def test_lookup_resolves_misspoken_names_and_flags_ambiguity():
    c, cfg, dbp = _data()
    hit = sq.lookup(dbp, "Safway")
    assert hit["matches"][0]["type"] == "store" and hit["matches"][0]["name"] == "Safeway"
    assert not hit["ambiguous"]
    coffee = sq.lookup(dbp, "coffee")
    assert coffee["matches"][0] == {"type": "category", "id": coffee["matches"][0]["id"],
                                    "name": "coffee", "score": 1.0}
    assert sq.lookup(dbp, "card 9999")["matches"][0]["type"] == "card"
    assert sq.lookup(dbp, "kicking horse")["matches"][0]["type"] == "brand"
    nothing = sq.lookup(dbp, "zzzz qqqq")
    assert nothing["matches"] == [] and "ask the user" in nothing["note"]
    # Two stores fitting equally well is "ask which one".
    conn = spending.connect(dbp)
    conn.execute("INSERT INTO stores (name, address) VALUES ('Safeway', 'Main St')")
    conn.commit(); conn.close()
    assert sq.lookup(dbp, "Safeway")["ambiguous"] is True


def test_card_total_is_what_was_paid():
    c, cfg, dbp = _data()
    out = sq.query(dbp, card_last_four="9999", period="all")
    assert out["basis"] == "receipt totals"
    assert out["summary"].startswith("$32.98 CAD across 2 purchases")
    # The pending Safeway receipt (card 1234) is outside this filter.
    assert "approval" not in out["summary"]
    assert "awaits approval" in sq.query(dbp, period="all")["summary"]


def test_category_query_sums_lines_and_carries_caveats():
    c, cfg, dbp = _data()
    coffee = sq.lookup(dbp, "coffee")["matches"][0]["id"]
    out = sq.query(dbp, category_ids=[coffee], since="2026-10-01", until="2026-10-31",
                   group_by="brand", list_items=True)
    assert out["basis"] == "line items"
    assert out["summary"].startswith("$45.47 CAD across 3 lines (from 2026-10-01 to 2026-10-31)")
    assert "before tax" in out["summary"]
    assert "1 of these lines ($12.99) is labelled but marked unsure" in out["summary"]
    assert "1 line in this range isn't labelled yet, so it may be missing" in out["summary"]
    assert "1 receipt ($15.49) still awaits approval and isn't counted" in out["summary"]
    assert [(g["key"], g["total_cents"]) for g in out["groups"]] == [
        ("Kicking Horse", 3248), ("Starbucks", 1299)]
    assert len(out["items"]) == 3 and any(i["unsure"] for i in out["items"])
    assert len(out["caveats"]) == 3 and out["must_mention"] is True


def test_tags_group_categories_and_count_each_line_once():
    c, cfg, dbp = _data()
    beverages = next(m for m in sq.lookup(dbp, "beverages")["matches"] if m["type"] == "tag")
    assert "coffee" in beverages["name"]                    # "beverages (covers ... coffee ...)"
    breakfast = next(m for m in sq.lookup(dbp, "breakfast")["matches"] if m["type"] == "tag")
    # Coffee carries both tags: asked together, its lines count once.
    both = sq.query(dbp, tag_ids=[beverages["id"], breakfast["id"]], period="all")
    assert both["summary"].startswith("$45.47 CAD across 3 lines")
    # A category plus a tag that covers it: still once.
    coffee = sq.lookup(dbp, "coffee")["matches"][0]["id"]
    assert sq.query(dbp, category_ids=[coffee], tag_ids=[beverages["id"]],
                    period="all")["summary"].startswith("$45.47 CAD across 3 lines")
    # Pasta sauce is pantry, not beverages.
    pantry = next(m for m in sq.lookup(dbp, "pantry")["matches"] if m["type"] == "tag")
    assert sq.query(dbp, tag_ids=[pantry["id"]], period="all")["summary"].startswith("$4.99")


def test_tag_breakdown_reports_its_overlap():
    c, cfg, dbp = _data()
    beverages = next(m for m in sq.lookup(dbp, "beverages")["matches"] if m["type"] == "tag")
    breakfast = next(m for m in sq.lookup(dbp, "breakfast")["matches"] if m["type"] == "tag")
    out = sq.query(dbp, tag_ids=[beverages["id"], breakfast["id"]], period="all", group_by="tag")
    assert {g["key"]: g["total_cents"] for g in out["groups"]} == {"beverages": 4547, "breakfast": 4547}
    assert out["summary"].startswith("$45.47 CAD across 3 lines")
    assert any("$45.47 is counted in more than one tag" in n for n in out["caveats"])
    # By category, the groups add up to the total: no overlap note.
    by_cat = sq.query(dbp, period="all", group_by="category")
    assert not any("overlap" in n for n in by_cat["caveats"])


def test_store_and_grouping():
    c, cfg, dbp = _data()
    safeway = sq.lookup(dbp, "Safeway")["matches"][0]["id"]
    out = sq.query(dbp, store_ids=[safeway], period="all", group_by="card")
    assert {g["key"]: g["total_cents"] for g in out["groups"]} == {
        "Visa ending 1234": 2048, "Visa ending 9999": 1299}
    by_store = sq.query(dbp, period="all", group_by="category")
    assert by_store["groups"][0]["key"] == "coffee"
    try:
        sq.query(dbp, store_ids=["Safeway"])
        assert False, "names are refused"
    except ValueError as e:
        assert "spending_lookup" in str(e)


def test_tools_are_offered_and_answer():
    c, cfg, dbp = _data()
    schemas, execute = main._build_tools(dbp)[:2]
    names = {s["function"]["name"] for s in schemas}
    assert {"spending_lookup", "spending_query"} <= names
    out = json.loads(execute("spending_query", {"card_last_four": "9999", "period": "all"}))
    assert out["summary"].startswith("$32.98")
    assert "error" in json.loads(execute("spending_query", {"group_by": "planet"}))
    cfg["spending"]["enabled"] = False
    names = {s["function"]["name"] for s in main._build_tools(dbp)[0]}
    assert "spending_query" not in names
