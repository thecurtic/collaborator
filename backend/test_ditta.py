"""Tests for ditta.py: the quote -> 402 -> pay -> replay loop against a fake
broker that speaks /client's plain-JSON 402. No network, no node: HTTP and
the wallet are mocked."""

import json
import os
import sqlite3
import tempfile
import time

import pytest

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, ditta, wallet
importlib.reload(db)
importlib.reload(main)


# --- a fake broker ----------------------------------------------------------------

class _Resp:
    def __init__(self, status_code, payload=None, headers=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class FakeBroker:
    """Speaks /client/quote and /client/search like the broker does."""

    def __init__(self, price_msat=5000, invoice="lnbc50n1pfakebrokerinvoice"):
        self.price = price_msat
        self.invoice = invoice
        self.searches = []          # (body bytes, Authorization or None)
        self.retain = False         # answer the paid search "no indexer replied"
        self.tamper = None          # mutate the challenge body before sending
        self.spent = set()

    def request(self, method, url, timeout=None, params=None, data=None,
                headers=None, proxies=None):
        if url.endswith("/client/quote"):
            return _Resp(200, {"quote_msat": self.price, "ask": params})
        auth = (headers or {}).get("Authorization")
        self.searches.append((data, auth))
        ask = json.loads(data)
        results = {"request_id": ask["request_id"], "charged_msat": self.price,
                   "results": [{"id": "1", "url": "https://example.org/a",
                                "title": "A", "snippet": "about a", "rank": 1,
                                "sources": [{"pubkey": "aa" * 32, "rank": 1}]}]}
        if self.price == 0:
            return _Resp(200, results)
        if auth and auth.startswith("L402 MAC:") and data not in self.spent:
            if self.retain:
                return _Resp(200, {**results, "results": [], "charged_msat": 0},
                             {"X-Credential-Retained": "1"})
            self.spent.add(data)
            return _Resp(200, results)
        now = int(time.time())
        body = {"error": "payment_required", "request_id": ask["request_id"],
                "invoice": self.invoice, "macaroon": "MAC",
                "payment_hash": "cd" * 32, "amount_msat": self.price,
                "invoice_expires": now + 600, "credential_expires": now + 86400}
        if self.tamper:
            body = self.tamper(body)
        return _Resp(402, body, {"WWW-Authenticate":
                                 f'L402 macaroon="MAC", invoice="{self.invoice}"'})


def _setup(monkeypatch, broker, **over):
    import requests
    tools = config.get_config().setdefault("tools", {})
    monkeypatch.setitem(tools, "ditta", {"url": "https://broker.example.com/",
                                         "max_sats_per_query": 10, **over})
    monkeypatch.setattr(requests, "request", broker.request)
    paid = []

    def fake_pay(db_path, user_key, invoice, reason=None, max_msat=None):
        paid.append((invoice, max_msat, reason))
        return {"status": "paid", "preimage": "ab" * 32, "amount_msat": 5000}
    monkeypatch.setattr(wallet, "pay", fake_pay)
    dbp = os.path.join(tempfile.mkdtemp(), "conv.db")
    sqlite3.connect(dbp).close()
    return dbp, paid


def test_paid_search_quote_pay_replay(monkeypatch):
    broker = FakeBroker()
    dbp, paid = _setup(monkeypatch, broker)
    out = ditta.ditta_search(dbp, "default", "raised bed timber", n=5)
    assert out["count"] == 1 and out["results"][0]["url"] == "https://example.org/a"
    assert out["results"][0]["indexers"] == 1 and out["charged_sats"] == 5
    assert "untrusted" in out["note"]
    assert paid == [("lnbc50n1pfakebrokerinvoice", 10_000,
                     "DITTA search: raised bed timber")]
    (first, a1), (second, a2) = broker.searches
    assert a1 is None and a2 == f"L402 MAC:{'ab' * 32}"
    assert first == second                       # byte-identical replay
    assert json.loads(first)["n"] == 5 and json.loads(first)["max_msat"] == 10_000
    print("✓ quote -> 402 -> pay -> byte-identical replay -> results")


def test_free_broker_needs_no_wallet(monkeypatch):
    broker = FakeBroker(price_msat=0)
    dbp, paid = _setup(monkeypatch, broker)
    assert ditta.ditta_search(dbp, "default", "anything")["count"] == 1
    assert paid == []
    print("✓ a free broker answers without any payment")


def test_over_cap_quote_pays_nothing(monkeypatch):
    broker = FakeBroker(price_msat=25_000)
    dbp, paid = _setup(monkeypatch, broker)
    out = ditta.ditta_search(dbp, "default", "expensive")
    assert "over the 10-sat per-query cap" in out["error"]
    assert paid == [] and broker.searches == []
    print("✓ a quote over the per-query cap stops before anything is sent")


@pytest.mark.parametrize("tamper,why", [
    (lambda c: {**c, "error": "something_else"}, "no payment challenge"),
    (lambda c: {**c, "request_id": "someone-elses"}, "different request"),
    (lambda c: {**c, "invoice": "lnbc1pswapped"}, "disagrees"),
    (lambda c: {**c, "invoice_expires": 1}, "expired"),
    (lambda c: {k: v for k, v in c.items() if k != "invoice_expires"}, "expired"),
    (lambda c: {**c, "amount_msat": 50_000}, "over the 10-sat per-query cap"),
])
def test_bad_challenges_are_never_paid(monkeypatch, tamper, why):
    broker = FakeBroker()
    broker.tamper = tamper
    dbp, paid = _setup(monkeypatch, broker)
    out = ditta.ditta_search(dbp, "default", "q")
    assert why in out["error"] and paid == []
    print(f"✓ refused to pay: {why}")


def test_retained_credential_replays_free(monkeypatch):
    broker = FakeBroker()
    broker.retain = True
    dbp, paid = _setup(monkeypatch, broker)
    out = ditta.ditta_search(dbp, "default", "Quiet  Topic")
    assert out["count"] == 0 and "costs nothing" in out["note"]

    broker.retain = False
    out = ditta.ditta_search(dbp, "default", "quiet topic")   # same ask
    assert out["count"] == 1 and len(paid) == 1               # no second payment
    body, auth = broker.searches[-1]
    assert body == broker.searches[0][0] and auth.startswith("L402 MAC:")
    conn = sqlite3.connect(dbp)
    assert conn.execute("SELECT COUNT(*) FROM ditta_parked").fetchone()[0] == 0
    print("✓ a retained credential replays the same bytes free, then clears")


def test_unconfirmed_payment_is_checked_not_repaid(monkeypatch):
    broker = FakeBroker()
    dbp, paid = _setup(monkeypatch, broker)

    def unconfirmed(db_path, user_key, invoice, reason=None, max_msat=None):
        paid.append(invoice)
        raise wallet.WalletUnconfirmed("not confirmed yet")
    monkeypatch.setattr(wallet, "pay", unconfirmed)
    out = ditta.ditta_search(dbp, "default", "slow wallet")
    assert out["status"] == "unconfirmed"

    # Asked again: the SAME invoice goes back to the wallet (which checks
    # before paying), and the same bytes are replayed — no new challenge.
    monkeypatch.setattr(wallet, "pay", lambda *a, **k: (
        paid.append(a[2]), {"status": "paid", "preimage": "ab" * 32,
                            "amount_msat": 5000})[1])
    out = ditta.ditta_search(dbp, "default", "slow wallet")
    assert out["count"] == 1 and paid == [broker.invoice, broker.invoice]
    assert [a for _, a in broker.searches] == [None, f"L402 MAC:{'ab' * 32}"]
    print("✓ an unconfirmed payment is resumed through the wallet, not re-asked")


def test_wallet_refusal_reaches_the_model(monkeypatch):
    broker = FakeBroker()
    dbp, _ = _setup(monkeypatch, broker)
    monkeypatch.setattr(wallet, "pay", lambda *a, **k: (_ for _ in ()).throw(
        wallet.WalletError("LNbits refused the payment: Insufficient balance.")))
    out = ditta.ditta_search(dbp, "default", "q")
    assert "Insufficient balance" in out["error"] and "create_invoice" in out["note"]
    conn = sqlite3.connect(dbp)
    assert conn.execute("SELECT COUNT(*) FROM ditta_parked").fetchone()[0] == 0
    print("✓ a wallet refusal is reported with a top-up hint, nothing parked")


def test_onion_needs_a_proxy_and_config_gates_the_tool(monkeypatch):
    broker = FakeBroker()
    dbp, _ = _setup(monkeypatch, broker, url="http://abcdefghijklmnop.onion")
    assert "SOCKS proxy" in ditta.ditta_search(dbp, "default", "q")["error"]
    assert broker.searches == []

    tools = config.get_config()["tools"]
    names = {s["function"]["name"] for s in main._build_tools(os.environ["DB_PATH"])[0]}
    assert "ditta_search" in names
    monkeypatch.setitem(tools, "ditta", {"url": ""})
    names = {s["function"]["name"] for s in main._build_tools(os.environ["DB_PATH"])[0]}
    assert "ditta_search" not in names            # no url, no tool
    print("✓ onion refused without a proxy; the tool needs a broker url")
