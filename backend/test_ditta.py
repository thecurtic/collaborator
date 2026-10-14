"""Tests for ditta.py: the broker's signed payment challenge (checked against
the DITTA spec's own vectors), and the quote -> 402 -> pay -> replay loop
against a fake broker. No network, no node: HTTP and the wallet are mocked."""

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

coincurve = pytest.importorskip("coincurve")

# The DITTA spec's published test-vector key for a broker (spec/vectors.json).
BROKER_SECKEY = "371ceb18f5e01877e33489d2c48398114339ed7f77e882acddaed063b313a995"
BROKER_PUBKEY = "88c5204e618b7294b22867984e31db7c3980c8f1fa76e52e6d12328f97fa2e9b"
SPEC_CHALLENGE = {
    "pubkey": "4af8136ba2e2c7027f55742d1d75b0a03f3388367c139f51ef19420562d129c8",
    "request_id": "q-7730",
    "invoice": "lnbc500n1pn0examplequeryinvoicebodyisopaquehere",
    "macaroon": "AgEEbGV0aGUCAgABAAISbGV0aGUgYmF0Y2ggbWFjYXJvb24AAAYg",
    "expiry": 1788307200,
    "sig": "03276ff2444567a75f272dd9ca28a5e74510059ea70c67b51da5f3e9676dad04"
           "8d0d4186dbcaf5121fa9ee3e7e8d765c698d5125dc6058b4312407956b0b8bbd",
}


def test_canonical_bytes_match_the_spec_vectors():
    assert ditta.canonical_bytes(
        {k: v for k, v in SPEC_CHALLENGE.items() if k != "sig"}) == (
        b'{"expiry":1788307200,"invoice":"lnbc500n1pn0examplequeryinvoicebody'
        b'isopaquehere","macaroon":"AgEEbGV0aGUCAgABAAISbGV0aGUgYmF0Y2ggbWFjYX'
        b'Jvb24AAAYg","pubkey":"4af8136ba2e2c7027f55742d1d75b0a03f3388367c139f'
        b'51ef19420562d129c8","request_id":"q-7730"}')
    escapes = {"pubkey": BROKER_PUBKEY, "max_results": 1,
               "query": 'he said "p\\q" a/b\tx\ny\u0001 café 🔍',
               "request_id": "€" * 21 + "x", "pricing_type": "per_query",
               "max_price": 9007199254740991}
    assert ditta.canonical_bytes(escapes) == (
        '{"max_price":9007199254740991,"max_results":1,"pricing_type":'
        f'"per_query","pubkey":"{BROKER_PUBKEY}","query":'
        r'"he said \"p\\q\" a/b\tx\ny\u0001 café 🔍",'
        f'"request_id":"{"€" * 21}x"}}').encode()
    print("✓ canonical serialization matches the spec's vectors")


def test_spec_challenge_signature_verifies():
    assert ditta.verify_challenge(SPEC_CHALLENGE, SPEC_CHALLENGE["pubkey"])
    assert not ditta.verify_challenge({**SPEC_CHALLENGE, "invoice": "lnbc1x"},
                                      SPEC_CHALLENGE["pubkey"])
    assert not ditta.verify_challenge(SPEC_CHALLENGE, BROKER_PUBKEY)
    print("✓ the spec's signed payment challenge verifies; tampering doesn't")


# --- a fake broker ----------------------------------------------------------------

def _sign(body: dict, seckey=BROKER_SECKEY) -> dict:
    digest = ditta._tagged_hash(ditta._TAG, ditta.canonical_bytes(body))
    sig = coincurve.PrivateKey(bytes.fromhex(seckey)).sign_schnorr(digest)
    return {**body, "sig": sig.hex()}


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
        self.seckey = BROKER_SECKEY
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
        challenge = {"pubkey": BROKER_PUBKEY, "request_id": ask["request_id"],
                     "invoice": self.invoice, "macaroon": "MAC",
                     "expiry": int(time.time()) + 600}
        if self.tamper:
            challenge = self.tamper(challenge)
        body = challenge if "sig" in challenge else _sign(challenge, self.seckey)
        return _Resp(402, body, {"WWW-Authenticate":
                                 f'L402 macaroon="MAC", invoice="{self.invoice}"'})


def _setup(monkeypatch, broker, **over):
    import requests
    tools = config.get_config().setdefault("tools", {})
    monkeypatch.setitem(tools, "ditta", {"url": "https://broker.example.com/",
                                         "pubkey": BROKER_PUBKEY,
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
    (lambda c: {**c, "sig": "00" * 64}, "signature"),
    (lambda c: _sign({**c, "pubkey": "4af8136ba2e2c7027f55742d1d75b0a03f3388367c139f51ef19420562d129c8"},
                     "f1c4d22b1f9b4cf3362ab0f245b092537eebbea0c8f48d61a106c5e8e8dc89ce"),
     "different key"),
    (lambda c: {**c, "request_id": "someone-elses"}, "different request"),
    (lambda c: {**c, "invoice": "lnbc1pswapped"}, "disagrees"),
    (lambda c: {**c, "expiry": 1}, "expired"),
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
    monkeypatch.setitem(tools, "ditta", {"url": "https://broker.example.com"})
    names = {s["function"]["name"] for s in main._build_tools(os.environ["DB_PATH"])[0]}
    assert "ditta_search" not in names            # no pinned pubkey, no tool
    print("✓ onion refused without a proxy; the tool needs url + pinned key")


def test_key_mismatch_says_what_the_broker_advertises(monkeypatch):
    broker = FakeBroker()
    dbp, paid = _setup(monkeypatch, broker, pubkey="4af8136ba2e2c7027f55742d1d75b0a03f3388367c139f51ef19420562d129c8")
    inner = broker.request

    def with_root(method, url, **kw):
        if url.endswith("broker.example.com/"):
            return _Resp(200, {"pubkey": BROKER_PUBKEY})
        return inner(method, url, **kw)
    import requests
    monkeypatch.setattr(requests, "request", with_root)
    out = ditta.ditta_search(dbp, "default", "q")
    assert "different key (88c5204e618b7294…)" in out["error"]
    assert "pin that key" in out["error"] and paid == []
    print("✓ a key mismatch names both keys and what the broker advertises")
