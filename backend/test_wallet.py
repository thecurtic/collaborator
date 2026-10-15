"""Tests for wallet.py: the provider switch, the park-before-pay ledger and
caps, recovery of unconfirmed payments, and the LNbits provider's HTTP
(mocked — nothing here touches a network or a node)."""

import json
import os
import sqlite3
import tempfile

import pytest

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, nwc, wallet
importlib.reload(db)
importlib.reload(main)

VALID_URI = ("nostr+walletconnect://" + "ab" * 32
             + "?relay=wss://relay.example.com&secret=" + "cd" * 32)


def _fresh_db():
    path = os.path.join(tempfile.mkdtemp(), "conversations.db")
    sqlite3.connect(path).close()
    return path


def _wallet_cfg(monkeypatch, provider="nwc", **over):
    tools = config.get_config().setdefault("tools", {})
    cfg = {"provider": provider, "max_sats_per_payment": 100,
           "max_sats_per_day": 500, "timeout": 1, **over}
    monkeypatch.setitem(tools, "wallet", cfg)
    if provider == "nwc":
        monkeypatch.setitem(tools, "nwc", {"connections": {"default": VALID_URI}})
    return cfg


def _rows(dbp):
    conn = sqlite3.connect(dbp)
    try:
        wallet._ensure_schema(conn)
        return conn.execute("SELECT amount_msat, status, preimage, reason "
                            "FROM wallet_spends ORDER BY id").fetchall()
    finally:
        conn.close()


class _ScriptedNwc:
    """nwc_call stand-in: pops one scripted behavior per call (a result dict
    to return, or an exception to raise)."""

    def __init__(self, script):
        self.script, self.calls = list(script), []

    def __call__(self, uri, method, params, timeout=30):
        self.calls.append((method, params))
        behavior = self.script.pop(0)
        if isinstance(behavior, Exception):
            raise behavior
        return behavior


# --- provider switch ------------------------------------------------------------

def test_provider_switch_and_per_user_gating(monkeypatch):
    _wallet_cfg(monkeypatch, provider="lnbits", lnbits={
        "url": "https://lnbits.example.com",
        "wallets": {"default": {"invoice_key": "inv", "admin_key": "adm"},
                    "receive-only": {"invoice_key": "inv"}}})
    p = wallet.provider_for("default")
    assert isinstance(p, wallet.LnbitsProvider) and p.can_pay
    assert wallet.provider_for("receive-only").can_pay is False
    assert wallet.provider_for("someone-else") is None

    _wallet_cfg(monkeypatch, provider="nwc")
    assert isinstance(wallet.provider_for("default"), wallet.NwcProvider)
    assert wallet.provider_for("nobody") is None
    _wallet_cfg(monkeypatch, provider="carrier-pigeon")
    assert wallet.provider_for("default") is None
    print("✓ provider switch: lnbits | nwc, per user, spend key optional")


# --- caps + ledger (NWC provider, wallet mocked) --------------------------------

def test_pay_caps_and_ledger(monkeypatch):
    _wallet_cfg(monkeypatch, max_sats_per_payment=100, max_sats_per_day=250)
    dbp = _fresh_db()
    calls = _ScriptedNwc([{"preimage": "ef" * 32, "fees_paid": 21}] * 3)
    monkeypatch.setattr(nwc, "nwc_call", calls)

    out = wallet.wallet_tool(dbp, "default", "pay_invoice",
                             invoice="lnbc1u1p...", reason="test spend")
    assert out["status"] == "paid" and out["amount_sats"] == 100
    assert out["preimage"] == "ef" * 32 and out["spent_today_sats"] == 100

    # Over the per-payment cap: refused before the wallet is ever contacted.
    assert "per-payment cap" in wallet.wallet_tool(
        dbp, "default", "pay_invoice", invoice="lnbc2m1p...")["error"]
    assert len(calls.calls) == 1

    # Second 100-sat payment fits; the third busts the 250/day cap.
    assert wallet.wallet_tool(dbp, "default", "pay_invoice",
                              invoice="lnbc1u1p...x")["status"] == "paid"
    assert "today's cap" in wallet.wallet_tool(
        dbp, "default", "pay_invoice", invoice="lnbc1u1p...y")["error"]
    assert len(calls.calls) == 2
    assert _rows(dbp)[0] == (100_000, "paid", "ef" * 32, "test spend")

    # The same invoice again is never paid twice.
    again = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc1u1p...")
    assert again["already_paid"] is True and len(calls.calls) == 2

    # Amountless invoices are refused (caps would be unenforceable).
    assert "amountless" in wallet.wallet_tool(
        dbp, "default", "pay_invoice", invoice="lnbc1pvjluez...")["error"]
    assert "no wallet" in wallet.wallet_tool(dbp, "nobody", "get_balance")["error"]
    print("✓ caps enforced app-side, every payment in the ledger, none twice")


def test_callers_ceiling(monkeypatch):
    _wallet_cfg(monkeypatch)
    dbp = _fresh_db()
    monkeypatch.setattr(nwc, "nwc_call", _ScriptedNwc([]))
    with pytest.raises(wallet.WalletCapExceeded):
        wallet.pay(dbp, "default", "lnbc500n1p...", max_msat=20_000)
    assert _rows(dbp) == []
    print("✓ a caller's own ceiling (the DITTA per-query cap) applies too")


def test_get_balance_and_low_balance(monkeypatch):
    _wallet_cfg(monkeypatch, low_balance_sats=200)
    dbp = _fresh_db()
    monkeypatch.setattr(nwc, "nwc_call",
                        lambda uri, m, p, timeout=30: {"balance": 123_000})
    out = wallet.wallet_tool(dbp, "default", "get_balance")
    assert out["balance_sats"] == 123 and out["remaining_today_sats"] == 500
    assert out["low_balance"] is True and "create_invoice" in out["note"]
    print("✓ get_balance: balance + remaining budget, low balance flagged")


# --- unconfirmed payments: park, then recover -----------------------------------

def test_timeout_parks_then_recovers(monkeypatch):
    _wallet_cfg(monkeypatch)
    dbp = _fresh_db()
    inv = "lnbc100n1p...lethe"
    monkeypatch.setattr(nwc, "nwc_call",
                        _ScriptedNwc([nwc.NwcTimeout("timed out waiting")]))
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice=inv,
                             reason="lethe access")
    assert out["status"] == "unconfirmed" and "SAME invoice" in out["note"]
    # Parked, and it counts against the daily cap while unconfirmed.
    assert _rows(dbp) == [(10_000, "unconfirmed", None, "lethe access")]
    conn = sqlite3.connect(dbp)
    assert wallet.spent_today_msat(conn) == 10_000
    conn.close()

    # Retry: the wallet says it settled -> recovered, not re-paid.
    scripted = _ScriptedNwc([{"preimage": "cd" * 32, "fees_paid": 3,
                              "settled_at": 1755772800}])
    monkeypatch.setattr(nwc, "nwc_call", scripted)
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice=inv)
    assert out["status"] == "paid" and out["recovered"] is True
    assert [m for m, _ in scripted.calls] == ["lookup_invoice"]
    assert _rows(dbp) == [(10_000, "paid", "cd" * 32, "lethe access")]
    print("✓ timeout parks the attempt; retry recovers it, records once")


def test_recovery_bypasses_daily_cap(monkeypatch):
    _wallet_cfg(monkeypatch, max_sats_per_day=10)
    dbp = _fresh_db()
    monkeypatch.setattr(nwc, "nwc_call", _ScriptedNwc([nwc.NwcTimeout("t/o")]))
    wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc100n1p...ghost")
    monkeypatch.setattr(nwc, "nwc_call", _ScriptedNwc(
        [{"preimage": "ff" * 32, "settled_at": 1}]))
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc100n1p...ghost")
    assert out["status"] == "paid" and out["recovered"] is True
    assert "today's cap" in wallet.wallet_tool(
        dbp, "default", "pay_invoice", invoice="lnbc100n1p...new")["error"]
    print("✓ a settled ghost is recorded past the cap; new pays still capped")


def test_unpaid_lookup_allows_safe_retry(monkeypatch):
    _wallet_cfg(monkeypatch)
    dbp = _fresh_db()
    inv = "lnbc100n1p...retry"
    monkeypatch.setattr(nwc, "nwc_call", _ScriptedNwc([nwc.NwcTimeout("t/o")]))
    wallet.wallet_tool(dbp, "default", "pay_invoice", invoice=inv)
    scripted = _ScriptedNwc([nwc.NwcError("wallet error NOT_FOUND: no match"),
                             {"preimage": "ab" * 32, "fees_paid": 0}])
    monkeypatch.setattr(nwc, "nwc_call", scripted)
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice=inv)
    assert out["status"] == "paid" and "recovered" not in out
    assert [m for m, _ in scripted.calls] == ["lookup_invoice", "pay_invoice"]
    assert [r[1] for r in _rows(dbp)] == ["paid"]
    print("✓ a wallet-confirmed-unpaid attempt retries safely (one spend)")


def test_uncheckable_attempt_is_never_repaid(monkeypatch):
    _wallet_cfg(monkeypatch)
    dbp = _fresh_db()
    inv = "lnbc100n1p...stuck"
    monkeypatch.setattr(nwc, "nwc_call", _ScriptedNwc([nwc.NwcTimeout("t/o")]))
    wallet.wallet_tool(dbp, "default", "pay_invoice", invoice=inv)
    # Neither lookup path works, or the wallet is deaf: nothing new is paid.
    for script in ([nwc.NwcError("wallet error NOT_IMPLEMENTED: no")] * 2,
                   [nwc.NwcUnreachable("deaf")]):
        scripted = _ScriptedNwc(script)
        monkeypatch.setattr(nwc, "nwc_call", scripted)
        out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice=inv)
        assert out["status"] == "unconfirmed"
        assert "pay_invoice" not in [m for m, _ in scripted.calls]
    assert [r[1] for r in _rows(dbp)] == ["unconfirmed"]
    print("✓ an attempt that can't be checked blocks re-pay instead of gambling")


def test_definitive_failure_clears_the_row(monkeypatch):
    _wallet_cfg(monkeypatch)
    dbp = _fresh_db()
    for err in (nwc.NwcError("wallet error FAILED_TO_PAY_INVOICE: no route"),
                nwc.NwcUnreachable("nothing sent")):
        monkeypatch.setattr(nwc, "nwc_call", _ScriptedNwc([err]))
        out = wallet.wallet_tool(dbp, "default", "pay_invoice",
                                 invoice="lnbc100n1p...norouted")
        assert str(err) in out["error"]
    assert _rows(dbp) == []
    print("✓ definitive failures (incl. never sent) leave no row behind")


# --- LNbits provider (HTTP mocked) -----------------------------------------------

class _Resp:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload) if payload is not None else ""

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class _FakeLnbits:
    """POST/GET stand-ins keyed by what LNbits would see."""

    def __init__(self):
        self.posts, self.gets = [], []
        self.status = {}          # payment_hash -> GET payload / status code
        self.pay_reply = _Resp(201, {"payment_hash": "11" * 32})
        self.raise_on_pay = None

    def post(self, url, headers=None, json=None, timeout=None):
        self.posts.append((url, headers["X-Api-Key"], json))
        if json.get("out") is False:
            return _Resp(201, {"payment_hash": "22" * 32,
                               "bolt11": f"lnbc{json['amount']}0n1pminted"})
        if self.raise_on_pay:
            raise self.raise_on_pay
        return self.pay_reply

    def get(self, url, headers=None, timeout=None):
        self.gets.append((url, headers["X-Api-Key"]))
        if url.endswith("/api/v1/wallet"):
            return _Resp(200, {"name": "collab", "balance": 4_200_000})
        reply = self.status.get(url.rsplit("/", 1)[1], 404)
        return _Resp(reply) if isinstance(reply, int) else _Resp(200, reply)


def _lnbits(monkeypatch, **over):
    import requests
    _wallet_cfg(monkeypatch, provider="lnbits", lnbits={
        "url": "https://lnbits.example.com/",
        "wallets": {"default": {"invoice_key": "INV", "admin_key": "ADM"}}},
        **over)
    fake = _FakeLnbits()
    monkeypatch.setattr(requests, "post", fake.post)
    monkeypatch.setattr(requests, "get", fake.get)
    return fake


def test_lnbits_pay_polls_for_the_preimage(monkeypatch):
    fake = _lnbits(monkeypatch)
    dbp = _fresh_db()
    fake.status["11" * 32] = {"paid": True, "preimage": "ab" * 32,
                              "details": {"fee": -2000, "status": "success"}}
    out = wallet.wallet_tool(dbp, "default", "pay_invoice",
                             invoice="lightning:LNBC1U1P...", reason="r")
    assert out["status"] == "paid" and out["preimage"] == "ab" * 32
    assert out["fees_msat"] == 2000
    url, key, body = fake.posts[0]
    assert url == "https://lnbits.example.com/api/v1/payments" and key == "ADM"
    assert body == {"out": True, "bolt11": "lnbc1u1p..."}   # prefix + case gone
    print("✓ LNbits: pay with the admin key, preimage from the status lookup")


def test_lnbits_refusal_and_failure_spend_nothing(monkeypatch):
    fake = _lnbits(monkeypatch)
    dbp = _fresh_db()
    fake.pay_reply = _Resp(520, {"detail": "Insufficient balance."})
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc1u1p...a")
    assert "Insufficient balance" in out["error"] and "create_invoice" in out["note"]

    fake.pay_reply = _Resp(201, {"payment_hash": "33" * 32})
    fake.status["33" * 32] = {"paid": False, "details": {"status": "failed"}}
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc1u1p...b")
    assert "failed" in out["error"]
    assert _rows(dbp) == []
    print("✓ LNbits: a refusal or a failed payment leaves nothing parked")


def test_lnbits_timeout_then_recovery_by_hash(monkeypatch):
    import requests
    fake = _lnbits(monkeypatch)
    dbp = _fresh_db()
    fake.raise_on_pay = requests.Timeout("slow")
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc1u1p...t")
    assert out["status"] == "unconfirmed"
    # No payment hash in a synthetic invoice: the check can't be made, so a
    # retry refuses to pay again rather than risk paying twice.
    fake.raise_on_pay = None
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc1u1p...t")
    assert out["status"] == "unconfirmed" and len(fake.posts) == 1

    # With a hash on the parked row, the retry looks it up and recovers.
    conn = sqlite3.connect(dbp)
    conn.execute("UPDATE wallet_spends SET payment_hash = ?", ("44" * 32,))
    conn.commit(); conn.close()
    fake.status["44" * 32] = {"paid": True, "preimage": "cd" * 32}
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc1u1p...t")
    assert out["recovered"] is True and out["preimage"] == "cd" * 32
    assert len(fake.posts) == 1                      # never paid a second time
    print("✓ LNbits: a timed-out payment is recovered by hash, not repeated")


def test_lnbits_balance_and_create_invoice(monkeypatch):
    fake = _lnbits(monkeypatch)
    dbp = _fresh_db()
    assert wallet.wallet_tool(dbp, "default", "get_balance")["balance_sats"] == 4200
    assert fake.gets[-1][1] == "INV"                 # read with the invoice key
    out = wallet.wallet_tool(dbp, "default", "create_invoice", amount_sats=5000)
    assert out["status"] == "invoice_created" and out["invoice"].startswith("lnbc")
    assert f"lightning:{out['invoice']}" in out["instruction"]
    url, key, body = fake.posts[-1]
    assert key == "INV" and body["out"] is False and body["amount"] == 5000
    assert "amount_sats" in wallet.wallet_tool(dbp, "default", "create_invoice")["error"]
    print("✓ LNbits: balance and top-up invoices use the invoice key only")


def test_build_tools_registers_wallet_per_user(monkeypatch):
    dbp = os.environ["DB_PATH"]
    tools = config.get_config().setdefault("tools", {})
    monkeypatch.setitem(tools, "wallet", {"provider": "lnbits", "lnbits": {}})
    names = {s["function"]["name"] for s in main._build_tools(dbp)[0]}
    assert "wallet" not in names
    _lnbits(monkeypatch)
    schemas, execute, _ = main._build_tools(dbp)
    assert "wallet" in {s["function"]["name"] for s in schemas}
    out = json.loads(execute("wallet", {"action": "get_balance"}))
    assert out["balance_sats"] == 4200
    print("✓ the wallet tool registers only for a user with a wallet")


def test_switching_wallets_never_repays_a_parked_attempt(monkeypatch):
    """NWC and LNbits can sit on different nodes: an attempt parked by one
    is never checked (or repaid) through the other, and each has its own
    daily budget."""
    _wallet_cfg(monkeypatch, provider="nwc", max_sats_per_day=150)
    dbp = _fresh_db()
    monkeypatch.setattr(nwc, "nwc_call", _ScriptedNwc([nwc.NwcTimeout("t/o")]))
    wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc1u1p...nwc")

    fake = _lnbits(monkeypatch, max_sats_per_day=150)
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc1u1p...nwc")
    assert out["status"] == "unconfirmed" and "nwc wallet" in out["error"]
    assert fake.posts == []

    # The NWC attempt's 100 sats don't eat LNbits' 150-sat day.
    fake.status["11" * 32] = {"paid": True, "preimage": "ab" * 32}
    out = wallet.wallet_tool(dbp, "default", "pay_invoice", invoice="lnbc1u1p...new")
    assert out["status"] == "paid" and out["spent_today_sats"] == 100
    print("✓ switching wallets: no cross-wallet repay, separate daily caps")


# --- the Wallet screen (/api/wallet) ----------------------------------------------

SPEC_INVOICE = (  # BOLT11's own example: 250,000 sat, "1 cup coffee", 60 s expiry
    "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5"
    "xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se9"
    "03vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp")


def test_decode_invoice_for_the_send_screen():
    out = wallet.decode_invoice("lightning:" + SPEC_INVOICE.upper())
    assert out["amount_sats"] == 250_000 and out["description"] == "1 cup coffee"
    assert out["payment_hash"] == "0001020304050607080900010203040506070809" \
                                  "000102030405060708090102"
    assert out["expires_at"] == 1496314658 + 60 and out["expired"] is True
    with pytest.raises(wallet.WalletError):
        wallet.decode_invoice("hello")
    print("✓ decode: amount, description and expiry before the user pays")


def test_user_sends_skip_the_models_caps(monkeypatch):
    _wallet_cfg(monkeypatch, max_sats_per_payment=100, max_sats_per_day=250)
    dbp = _fresh_db()
    calls = _ScriptedNwc([{"preimage": "ef" * 32, "fees_paid": 0}] * 3)
    monkeypatch.setattr(nwc, "nwc_call", calls)
    # 2,000 sats is far over both caps, but it's the user taking money out.
    res = wallet.pay(dbp, "default", "lnbc20u1p...", source="user")
    assert res["status"] == "paid"
    assert wallet.recent_spends(dbp)[0]["source"] == "user"
    # ...and it doesn't eat the model's budget: 200 sats still fit today.
    for inv in ("lnbc1u1p...a", "lnbc1u1p...b"):
        assert wallet.pay(dbp, "default", inv)["status"] == "paid"
    with pytest.raises(wallet.WalletCapExceeded):
        wallet.pay(dbp, "default", "lnbc1u1p...c")
    # The same invoice is still never paid twice, whoever pays it.
    assert wallet.pay(dbp, "default", "lnbc20u1p...", source="user")["already_paid"]
    assert len(calls.calls) == 3
    print("✓ the user's own sends are ledgered but outside the model's caps")


def test_ledger_gains_source_column_in_place():
    dbp = _fresh_db()
    conn = sqlite3.connect(dbp)
    conn.execute("CREATE TABLE wallet_spends (id INTEGER PRIMARY KEY "
                 "AUTOINCREMENT, created_at TEXT NOT NULL, day TEXT NOT NULL, "
                 "provider TEXT NOT NULL, amount_msat INTEGER NOT NULL, "
                 "fees_msat INTEGER, invoice TEXT NOT NULL, payment_hash TEXT, "
                 "preimage TEXT, reason TEXT, status TEXT NOT NULL)")
    import time as _t
    conn.execute("INSERT INTO wallet_spends (created_at, day, provider, "
                 "amount_msat, invoice, status) VALUES ('x', ?, 'lnbits', "
                 "5000, 'lnbc50n1p', 'paid')", (_t.strftime("%Y-%m-%d"),))
    conn.commit()
    assert wallet.spent_today_msat(conn, "lnbits") == 5000   # old rows = model
    conn.close()
    print("✓ an existing ledger gains the source column; old rows are the model's")


def test_wallet_endpoints(monkeypatch):
    from starlette.testclient import TestClient
    fake = _lnbits(monkeypatch)
    client = TestClient(main.app)

    got = client.get("/api/wallet").json()
    assert got["configured"] and got["provider"] == "lnbits" and got["can_pay"]
    assert got["balance_sats"] == 4200 and got["recent"] == []

    inv = client.post("/api/wallet/receive", json={"amount_sats": 2100}).json()
    assert inv["invoice"].startswith("lnbc") and inv["payment_hash"] == "22" * 32
    assert client.get(f"/api/wallet/invoices/{'22' * 32}").json()["paid"] is False
    fake.status["22" * 32] = {"paid": True}
    assert client.get(f"/api/wallet/invoices/{'22' * 32}").json()["paid"] is True
    assert client.get("/api/wallet/invoices/nothex").status_code == 422
    assert client.post("/api/wallet/receive",
                       json={"amount_sats": 0}).status_code == 422

    d = client.post("/api/wallet/decode", json={"invoice": SPEC_INVOICE}).json()
    assert d["amount_sats"] == 250_000
    assert client.post("/api/wallet/decode",
                       json={"invoice": "nope"}).status_code == 422

    fake.status["11" * 32] = {"paid": True, "preimage": "ab" * 32}
    sent = client.post("/api/wallet/send", json={"invoice": "lnbc5m1p...out"})
    assert sent.json() == {"status": "paid", "amount_sats": 500_000,
                           "fees_sats": 0, "already_paid": False,
                           "recovered": False}
    assert fake.posts[-1][1] == "ADM"
    recent = client.get("/api/wallet").json()["recent"]
    assert recent[0]["source"] == "user" and recent[0]["amount_sats"] == 500_000
    assert client.post("/api/wallet/send",
                       json={"invoice": "lnbc1pvjluez..."}).status_code == 422

    monkeypatch.setitem(config.get_config()["tools"], "wallet", {})
    assert client.get("/api/wallet").json() == {"configured": False}
    print("✓ /api/wallet: balance, receive + paid check, decode, send")
