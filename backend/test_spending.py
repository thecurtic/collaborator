"""Tests for spending (receipt capture, phase 1): the divert out of Scratch,
receipt parsing into cents, the arithmetic and novelty checks, and the
pending → approve / discard lifecycle. No live model: vision.look is faked."""

import io
import json
import os
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, scratch, spending, vision
importlib.reload(db)
importlib.reload(main)
from starlette.testclient import TestClient


def _fresh():
    path = os.path.join(tempfile.mkdtemp(), "conv.db")
    os.environ["DB_PATH"] = path
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(tempfile.mkdtemp(), "vault")
    cfg["notes"]["bootstrap_user_note"] = False
    cfg["scratch"]["link_previews"] = False
    cfg["inference"]["vision"] = True
    cfg["spending"]["enabled"] = True
    config.get_config._config = cfg
    vision._vlm_cache.clear()
    importlib.reload(db)
    importlib.reload(main)
    db.init_db()
    return TestClient(main.app), cfg, path


GROCERY = {
    "store": {"name": "Safeway", "address": "Kingsway", "store_number": "4931"},
    "datetime": "2026-10-28T17:42", "currency": "CAD",
    "line_items": [
        {"raw_text": "CLASSICO TOM BASIL", "qty": 1, "unit_price": 4.99, "line_total": 4.99},
        {"raw_text": "KICKING HORSE 454G", "qty": 1, "unit_price": 15.49, "line_total": 15.49},
        {"raw_text": "SPARKLING WTR 12PK", "qty": 1, "unit_price": 6.99, "line_total": 6.99},
    ],
    "charges": [
        {"kind": "deposit", "name": "Bottle deposit", "raw_text": "DEP", "amount": 1.20,
         "rate": None, "line_index": 2},
        {"kind": "tax", "name": "GST", "raw_text": "GST 5%", "amount": 0.42,
         "rate": 0.05, "line_index": None},
    ],
    "subtotal": 28.67, "total": 29.09,
    "payment": {"method": "card", "card_brand": "Visa", "last_four": "****1234",
                "tendered": None, "change": None},
    "unmapped": [],
}


def _png():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (40, 30), "white").save(buf, format="PNG")
    return buf.getvalue()


def _fake_vision(monkeypatch, label, receipt=None, calls=None):
    def look(images, prompt, **k):
        if calls is not None:
            calls.append(prompt)
        if prompt == spending.CLASSIFY_PROMPT:
            assert k.get("response_format", {}).get("type") == "json_schema"
            return json.dumps({"label": label})
        if prompt == spending.RECEIPT_PROMPT:
            return json.dumps(receipt)
        return "A photo of a dog in a park."
    monkeypatch.setattr(vision, "look", look)


def _hold(c, data=None, caption=None):
    r = c.post("/api/scratch/media", data={"content": caption} if caption else None,
               files={"file": ("r.png", io.BytesIO(data or _png()), "image/png")})
    item = r.json()["item"]
    return item, c.post(f"/api/scratch/{item['id']}/act").json()


def test_to_cents():
    assert spending.to_cents(4.99) == 499
    assert spending.to_cents("$1,234.50") == 123450
    assert spending.to_cents("-0.30") == -30
    assert spending.to_cents(0.1 + 0.2) == 30
    assert spending.to_cents(None) is None and spending.to_cents("n/a") is None
    assert spending.to_cents(True) is None


def test_receipt_diverts_out_of_scratch(monkeypatch):
    c, cfg, dbp = _fresh()
    _fake_vision(monkeypatch, "receipt", GROCERY)
    monkeypatch.setattr(scratch, "run_text_action", lambda *a: (_ for _ in ()).throw(
        AssertionError("a receipt never reaches the Scratch agent")))
    item, out = _hold(c, caption="lunch with Sam")
    assert out["diverted"] is True and "item" not in out

    # Gone from Scratch, file included (nothing else shared it)...
    assert c.get("/api/scratch").json()["count"] == 0
    assert not os.listdir(scratch.media_dir(dbp))
    # ...and copied into evidence, the caption kept.
    tx = c.get(f"/api/spending/transactions/{out['transaction_id']}").json()["transaction"]
    assert tx["status"] == "pending"
    assert tx["amount_cents"] == 2909 and tx["subtotal_cents"] == 2867
    assert tx["store"] == "Safeway" and tx["currency"] == "CAD"
    assert [l["raw_text"] for l in tx["line_items"]][0] == "CLASSICO TOM BASIL"
    assert tx["charges"][0]["line_index"] == 2
    assert tx["payment"] == {"method": "card", "card_brand": "Visa", "last_four": "1234",
                             "tendered_cents": None, "change_cents": None}
    assert tx["evidence"][0]["caption"] == "lunch with Sam"
    assert tx["evidence"][0]["role"] == "origin"
    # The numbers add up; the only reasons are the never-seen charge types.
    assert tx["review"] == ["new charge: Bottle deposit", "new charge: GST"]
    img = c.get(f"/api/spending/evidence/{out['evidence_id']}/image")
    assert img.status_code == 200 and img.content == _png()


def test_shared_scratch_file_survives_divert(monkeypatch):
    c, cfg, dbp = _fresh()
    _fake_vision(monkeypatch, "receipt", GROCERY)
    data = _png()
    c.post("/api/scratch/media", files={"file": ("a.png", io.BytesIO(data), "image/png")})
    _, out = _hold(c, data)
    assert out["diverted"]
    # The tapped (inert) copy stays, and so does the file it points at.
    assert c.get("/api/scratch").json()["count"] == 1
    assert len(os.listdir(scratch.media_dir(dbp))) == 1


def test_non_receipt_takes_the_ordinary_path(monkeypatch):
    c, cfg, dbp = _fresh()
    _fake_vision(monkeypatch, "photo")
    seen = {}

    def fake_action(db_path, text, build_tools, generate):
        seen["text"] = text
        return {"kind": "flagged", "note": "left as a note"}
    monkeypatch.setattr(scratch, "run_text_action", fake_action)
    item, out = _hold(c)
    assert out["item"]["id"] == item["id"]
    assert "dog in a park" in seen["text"]
    assert c.get("/api/spending/transactions").json()["count"] == 0


def test_disabled_never_classifies(monkeypatch):
    c, cfg, dbp = _fresh()
    cfg["spending"]["enabled"] = False
    calls = []
    _fake_vision(monkeypatch, "receipt", GROCERY, calls)
    monkeypatch.setattr(scratch, "run_text_action",
                        lambda *a: {"kind": "flagged", "note": "x"})
    _, out = _hold(c)
    assert "item" in out and spending.CLASSIFY_PROMPT not in calls


def test_no_vision_falls_through(monkeypatch):
    c, cfg, dbp = _fresh()
    cfg["inference"]["vision"] = False
    vision._vlm_cache.clear()
    _, out = _hold(c)
    assert out["item"]["action_result"]["kind"] == "unsupported"


def test_secret_on_receipt_is_refused_and_stays(monkeypatch):
    c, cfg, dbp = _fresh()
    bad = json.loads(json.dumps(GROCERY))
    bad["unmapped"] = ["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"]
    _fake_vision(monkeypatch, "receipt", bad)
    item, out = _hold(c)
    assert out["item"]["status"] == "refused"
    assert c.get("/api/scratch").json()["count"] == 1
    assert c.get("/api/spending/transactions").json()["count"] == 0


def test_unreadable_receipt_stays_in_scratch(monkeypatch):
    c, cfg, dbp = _fresh()
    _fake_vision(monkeypatch, "receipt", {"store": {}, "line_items": [], "total": None})
    item, out = _hold(c)
    assert out["item"]["action_result"]["kind"] == "error"
    assert "no total" in out["item"]["action_result"]["note"]
    assert c.get("/api/scratch").json()["count"] == 1


def test_review_reasons():
    receipt, problems = spending.normalize(GROCERY)
    assert problems == []
    known = {("deposit", "bottle deposit"), ("tax", "gst")}
    assert spending.review_reasons(receipt, known) == []

    # Cash rounding: total 29.10 for 29.09 is inside the $0.05 tolerance.
    cash = dict(receipt, total_cents=2910)
    assert spending.review_reasons(cash, known) == []
    # A deposit printed inside the subtotal, not under a line, also balances.
    inside = json.loads(json.dumps(receipt))
    inside["charges"][0]["line_index"] = None
    assert spending.review_reasons(inside, known) == []
    # A missing PST line breaks the arithmetic: flagged whatever the model did.
    off = dict(receipt, total_cents=3209)
    assert spending.review_reasons(off, known) == ["the numbers don't add up to the total"]
    # No subtotal printed: lines + every charge must reach the total.
    nosub = dict(receipt, subtotal_cents=None)
    assert spending.review_reasons(nosub, known) == []

    odd = json.loads(json.dumps(receipt))
    odd["unmapped"] = ["Eco levy 0.10"]
    odd["payment"]["method"] = "other"
    assert spending.review_reasons(odd, known) == [
        "something on the receipt fits no field", "payment method unclear"]


def test_approve_learns_charge_types_and_takes_edits(monkeypatch):
    c, cfg, dbp = _fresh()
    _fake_vision(monkeypatch, "receipt", GROCERY)
    _, out = _hold(c)
    tx_id = out["transaction_id"]

    edited = json.loads(json.dumps(GROCERY))
    edited["line_items"][1]["raw_text"] = "KICKING HORSE COFFEE 454G"
    r = c.post(f"/api/spending/transactions/{tx_id}/approve", json={"receipt": edited})
    assert r.status_code == 200
    tx = r.json()["transaction"]
    assert tx["status"] == "committed" and tx["review"] == []
    assert tx["line_items"][1]["raw_text"] == "KICKING HORSE COFFEE 454G"
    assert all(ch["known"] for ch in tx["charges"])
    # Approving again: it's no longer pending.
    assert c.post(f"/api/spending/transactions/{tx_id}/approve", json={}).status_code == 404

    # The next receipt with the same charges isn't flagged for them.
    _, out2 = _hold(c, _png() + b"x")
    tx2 = c.get(f"/api/spending/transactions/{out2['transaction_id']}").json()["transaction"]
    assert tx2["review"] == []
    assert [t["id"] for t in c.get("/api/spending/transactions",
                                   params={"status": "pending"}).json()["items"]] == [tx2["id"]]

    bad = json.loads(json.dumps(GROCERY))
    bad["total"] = None
    r = c.post(f"/api/spending/transactions/{tx2['id']}/approve", json={"receipt": bad})
    assert r.status_code == 422


def test_discard_removes_rows_and_image(monkeypatch):
    c, cfg, dbp = _fresh()
    _fake_vision(monkeypatch, "receipt", GROCERY)
    _, out = _hold(c)
    assert os.listdir(spending.evidence_dir(dbp))
    assert c.delete(f"/api/spending/transactions/{out['transaction_id']}").json() == {
        "deleted": out["transaction_id"]}
    assert c.get("/api/spending/transactions").json()["count"] == 0
    assert not os.listdir(spending.evidence_dir(dbp))
    assert c.get(f"/api/spending/evidence/{out['evidence_id']}/image").status_code == 404
    assert c.delete(f"/api/spending/transactions/{out['transaction_id']}").status_code == 404
    assert c.get("/api/spending/transactions", params={"status": "x"}).status_code == 422
