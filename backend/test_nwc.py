"""Tests for nwc (NIP-47 wallet client, spend caps/ledger, L402 loop with
Lethe search) and the executor wiring in main.

Crypto tests need coincurve + cryptography (skipped when absent); nothing
here touches the network — the relay roundtrip and HTTP are mocked.
"""

import json
import os
import sqlite3
import tempfile

import pytest

os.environ["AUTH_ENABLED"] = "false"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "conversations.db")
import config
config.get_config._config = config.load_config()
import importlib, db, main, nwc
importlib.reload(db)
importlib.reload(main)

VALID_URI = ("nostr+walletconnect://" + "ab" * 32
             + "?relay=wss://relay.example.com&secret=" + "cd" * 32)


def _fresh_db():
    path = os.path.join(tempfile.mkdtemp(), "conversations.db")
    sqlite3.connect(path).close()
    return path


def _nwc_settings(monkeypatch, **over):
    cfg = config.get_config().setdefault("tools", {}).setdefault("nwc", {})
    monkeypatch.setitem(cfg, "connections", {"default": VALID_URI})
    for k, v in over.items():
        monkeypatch.setitem(cfg, k, v)
    return cfg


# --- connection URI --------------------------------------------------------------

def test_parse_nwc_uri():
    parts = nwc.parse_nwc_uri(VALID_URI)
    assert parts["wallet_pubkey"] == "ab" * 32
    assert parts["relay"] == "wss://relay.example.com"
    assert parts["secret"] == "cd" * 32

    for bad in ("", "https://x", "nostr+walletconnect://tooshort?relay=wss://r&secret=" + "cd" * 32,
                "nostr+walletconnect://" + "ab" * 32 + "?secret=" + "cd" * 32,
                "nostr+walletconnect://" + "ab" * 32 + "?relay=wss://r&secret=xyz"):
        with pytest.raises(nwc.NwcError):
            nwc.parse_nwc_uri(bad)
    print("✓ NWC URI parsing: pubkey/relay/secret validated, garbage rejected")


def test_user_key_for_db():
    assert nwc.user_key_for_db("/x/users/abc123/conversations.db", True) == "abc123"
    assert nwc.user_key_for_db("/x/data/conversations.db", False) == "default"
    print("✓ per-user key: identity hash under auth, 'default' without")


# --- BOLT11 amounts --------------------------------------------------------------

def test_bolt11_amounts():
    assert nwc.bolt11_amount_msat("lnbc2500u1p...") == 250_000_000   # 250k sat
    assert nwc.bolt11_amount_msat("lnbc10n1p...") == 1_000           # 1 sat
    assert nwc.bolt11_amount_msat("LNBC25M1P...") == 2_500_000_000
    assert nwc.bolt11_amount_msat("lntb210n1p...") == 21_000
    assert nwc.bolt11_amount_msat("lnbcrt1u1p...") == 100_000
    assert nwc.bolt11_amount_msat("lnbc10p1p...") == 1               # 1 msat
    assert nwc.bolt11_amount_msat("lnbc1pvjluez...") is None         # amountless
    with pytest.raises(nwc.NwcError):
        nwc.bolt11_amount_msat("lnbc1p1p...")   # sub-msat precision
    with pytest.raises(nwc.NwcError):
        nwc.bolt11_amount_msat("not an invoice")
    print("✓ bolt11 hrp amounts: units, case, amountless, sub-msat rejection")


# --- NIP-04 + event signing (real crypto, no network) ----------------------------

def test_nip04_roundtrip_and_event_signature():
    coincurve = pytest.importorskip("coincurve")
    a = coincurve.PrivateKey()
    b = coincurve.PrivateKey()
    a_hex, b_hex = a.secret.hex(), b.secret.hex()
    a_pub = a.public_key.format(compressed=True)[1:].hex()
    b_pub = b.public_key.format(compressed=True)[1:].hex()

    msg = json.dumps({"method": "pay_invoice", "params": {"invoice": "lnbc1..."}})
    ct = nwc.nip04_encrypt(a_hex, b_pub, msg)
    assert "?iv=" in ct and msg not in ct
    # The counterparty decrypts with ITS secret and the sender's pubkey (ECDH
    # symmetry) — this is exactly what the wallet does with our request.
    assert nwc.nip04_decrypt(b_hex, a_pub, ct) == msg

    ev = nwc._signed_event(a_hex, 23194, [["p", b_pub]], ct)
    assert ev["pubkey"] == a_pub and ev["kind"] == 23194
    import hashlib
    payload = json.dumps([0, ev["pubkey"], ev["created_at"], ev["kind"],
                          ev["tags"], ev["content"]],
                         separators=(",", ":"), ensure_ascii=False)
    assert ev["id"] == hashlib.sha256(payload.encode()).hexdigest()
    xonly = coincurve.PublicKeyXOnly(bytes.fromhex(a_pub))
    assert xonly.verify(bytes.fromhex(ev["sig"]), bytes.fromhex(ev["id"]))
    print("✓ NIP-04 roundtrip + BIP-340 event signature verify")


# --- NIP-44 v2 -------------------------------------------------------------------

def test_nip44_padding_lengths():
    for unpadded, padded in [(1, 32), (16, 32), (32, 32), (33, 64), (37, 64),
                             (45, 64), (49, 64), (64, 64), (65, 96),
                             (100, 128), (111, 128), (200, 224), (250, 256),
                             (320, 320), (400, 448), (500, 512), (512, 512),
                             (515, 640), (700, 768), (800, 896), (900, 1024),
                             (1020, 1024), (65535, 65536)]:
        assert nwc._nip44_padded_len(unpadded) == padded, unpadded
    print("✓ nip44 padding: spec vector table")


def test_nip44_roundtrip_and_tamper():
    coincurve = pytest.importorskip("coincurve")
    a, b = coincurve.PrivateKey(), coincurve.PrivateKey()
    a_hex, b_hex = a.secret.hex(), b.secret.hex()
    a_pub = a.public_key.format(compressed=True)[1:].hex()
    b_pub = b.public_key.format(compressed=True)[1:].hex()

    # Conversation key is symmetric — both sides derive the same one.
    assert nwc._nip44_conversation_key(a_hex, b_pub) == \
        nwc._nip44_conversation_key(b_hex, a_pub)

    for msg in ("x", "héllo wörld ⚡" * 40,
                json.dumps({"method": "pay_invoice",
                            "params": {"invoice": "lnbc1u1p..."}})):
        ct = nwc.nip44_encrypt(a_hex, b_pub, msg)
        assert "?iv=" not in ct
        assert nwc.nip44_decrypt(b_hex, a_pub, ct) == msg

    ct = nwc.nip44_encrypt(a_hex, b_pub, "pay me")
    raw = bytearray(__import__("base64").b64decode(ct))
    raw[40] ^= 1                                     # flip a ciphertext bit
    import base64 as b64
    with pytest.raises(nwc.NwcError, match="MAC"):
        nwc.nip44_decrypt(b_hex, a_pub, b64.b64encode(bytes(raw)).decode())
    with pytest.raises(nwc.NwcError, match="version"):
        nwc.nip44_decrypt(b_hex, a_pub, "#v3-payload")
    with pytest.raises(nwc.NwcError):
        nwc.nip44_encrypt(a_hex, b_pub, "")           # below 1-byte minimum
    print("✓ nip44: symmetric keys, roundtrip, MAC/version/bounds rejection")


def test_chacha20_matches_rfc7539_reference():
    """Guard the cryptography-API composition: its 16-byte ChaCha20 nonce is
    4-byte little-endian counter + RFC nonce. An independent pure-python
    RFC 7539 implementation must produce identical output, or Zeus would
    silently fail to decrypt our requests."""
    pytest.importorskip("cryptography")
    import struct

    def rotl(x, n):
        return ((x << n) | (x >> (32 - n))) & 0xffffffff

    def qr(s, a, b, c, d):
        s[a] = (s[a] + s[b]) & 0xffffffff; s[d] = rotl(s[d] ^ s[a], 16)
        s[c] = (s[c] + s[d]) & 0xffffffff; s[b] = rotl(s[b] ^ s[c], 12)
        s[a] = (s[a] + s[b]) & 0xffffffff; s[d] = rotl(s[d] ^ s[a], 8)
        s[c] = (s[c] + s[d]) & 0xffffffff; s[b] = rotl(s[b] ^ s[c], 7)

    def block(key, counter, nonce):
        init = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574,
                *struct.unpack("<8I", key), counter,
                *struct.unpack("<3I", nonce)]
        w = list(init)
        for _ in range(10):
            qr(w, 0, 4, 8, 12); qr(w, 1, 5, 9, 13)
            qr(w, 2, 6, 10, 14); qr(w, 3, 7, 11, 15)
            qr(w, 0, 5, 10, 15); qr(w, 1, 6, 11, 12)
            qr(w, 2, 7, 8, 13); qr(w, 3, 4, 9, 14)
        return struct.pack("<16I",
                           *[(w[i] + init[i]) & 0xffffffff for i in range(16)])

    def reference(key, nonce, data):
        out = bytearray()
        for i in range(0, len(data), 64):
            ks = block(key, i // 64, nonce)
            out += bytes(x ^ y for x, y in zip(data[i:i + 64], ks))
        return bytes(out)

    key, nonce = os.urandom(32), os.urandom(12)
    for size in (1, 63, 64, 65, 300):
        data = os.urandom(size)
        assert nwc._chacha20(key, nonce, data) == reference(key, nonce, data)
    print("✓ ChaCha20 counter/nonce composition matches RFC 7539 reference")


# --- encryption negotiation over a fake relay ------------------------------------

class _FakeRelay:
    """Scripted relay + wallet: serves the info event, decrypts the request
    with the WALLET's key (real interop across roles), answers encrypted."""

    def __init__(self, wallet, advertise, respond_scheme):
        self.wallet = wallet
        self.wallet_pub = wallet.public_key.format(compressed=True)[1:].hex()
        self.advertise = advertise          # info event encryption tag; None = no info event
        self.respond_scheme = respond_scheme
        self.queue, self.request_event, self.resp_sub = [], None, None

    async def send(self, raw):
        msg = json.loads(raw)
        if msg[0] == "REQ" and 13194 in msg[2].get("kinds", []):
            if self.advertise is not None:
                tags = ([["encryption", self.advertise]]
                        if self.advertise else [])
                self.queue.append(json.dumps(["EVENT", msg[1], {
                    "kind": 13194, "pubkey": self.wallet_pub, "tags": tags,
                    "content": "pay_invoice get_balance"}]))
            self.queue.append(json.dumps(["EOSE", msg[1]]))
        elif msg[0] == "REQ":
            self.resp_sub = msg[1]
        elif msg[0] == "EVENT":
            ev = self.request_event = msg[1]
            body = json.loads(nwc._decrypt_payload(
                self.wallet.secret.hex(), ev["pubkey"], ev["content"]))
            reply = json.dumps({"result_type": body["method"], "error": None,
                                "result": {"preimage": "aa" * 32,
                                           "fees_paid": 0}})
            self.queue.append(json.dumps(["OK", ev["id"], True, ""]))
            self.queue.append(json.dumps(["EVENT", self.resp_sub, {
                "kind": 23195, "pubkey": self.wallet_pub,
                "content": nwc._encrypt_payload(
                    self.respond_scheme, self.wallet.secret.hex(),
                    ev["pubkey"], reply),
                "tags": [["e", ev["id"]]]}]))

    async def recv(self):
        import asyncio
        while not self.queue:
            await asyncio.sleep(0.001)
        return self.queue.pop(0)


def _fake_wallet(monkeypatch, advertise, respond_scheme):
    coincurve = pytest.importorskip("coincurve")
    import websockets
    wallet, client = coincurve.PrivateKey(), coincurve.PrivateKey()
    relay = _FakeRelay(wallet, advertise, respond_scheme)

    class _CM:
        async def __aenter__(self):
            return relay
        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(websockets, "connect", lambda url, **kw: _CM())
    monkeypatch.setattr(nwc, "_ENC_SCHEMES", {})
    uri = (f"nostr+walletconnect://{relay.wallet_pub}"
           f"?relay=wss://fake.example.com&secret={client.secret.hex()}")
    return relay, uri


def test_session_negotiates_nip44(monkeypatch):
    relay, uri = _fake_wallet(monkeypatch, advertise="nip44_v2 nip04",
                              respond_scheme="nip44_v2")
    result = nwc.nwc_call(uri, "pay_invoice", {"invoice": "lnbc1u1p..."})
    assert result["preimage"] == "aa" * 32
    ev = relay.request_event
    assert ["encryption", "nip44_v2"] in ev["tags"]
    assert "?iv=" not in ev["content"]               # nip44 payload shape
    assert nwc._ENC_SCHEMES == {("wss://fake.example.com",
                                 relay.wallet_pub): "nip44_v2"}
    print("✓ negotiation: nip44_v2 advertised -> nip44 request+response, cached")


def test_session_falls_back_to_nip04(monkeypatch):
    # Legacy wallet: info event without an encryption tag.
    relay, uri = _fake_wallet(monkeypatch, advertise="", respond_scheme="nip04")
    assert nwc.nwc_call(uri, "get_balance", {})["preimage"] == "aa" * 32
    assert "?iv=" in relay.request_event["content"]
    assert all(t[0] != "encryption" for t in relay.request_event["tags"])

    # No info event at all: default nip04, nothing cached.
    relay, uri = _fake_wallet(monkeypatch, advertise=None,
                              respond_scheme="nip04")
    assert nwc.nwc_call(uri, "get_balance", {})["preimage"] == "aa" * 32
    assert "?iv=" in relay.request_event["content"]
    assert nwc._ENC_SCHEMES == {}

    # Config pin overrides detection entirely (no info-event roundtrip needed).
    relay, uri = _fake_wallet(monkeypatch, advertise=None,
                              respond_scheme="nip44_v2")
    cfg = config.get_config().setdefault("tools", {}).setdefault("nwc", {})
    monkeypatch.setitem(cfg, "encryption", "nip44")
    assert nwc.nwc_call(uri, "get_balance", {})["preimage"] == "aa" * 32
    assert "?iv=" not in relay.request_event["content"]
    print("✓ negotiation: legacy/no-info -> nip04; config pin -> nip44")


# --- caps + ledger (wallet mocked) -----------------------------------------------

def _mock_paid(monkeypatch, preimage="ef" * 32, fees=21):
    calls = []
    def fake_call(uri, method, params, timeout=30):
        calls.append((method, params))
        return {"preimage": preimage, "fees_paid": fees}
    monkeypatch.setattr(nwc, "nwc_call", fake_call)
    return calls


def test_pay_caps_and_ledger(monkeypatch):
    _nwc_settings(monkeypatch, max_sats_per_payment=100, max_sats_per_day=250)
    dbp = _fresh_db()
    calls = _mock_paid(monkeypatch)

    out = nwc.nwc_pay(dbp, "default", invoice="lnbc1u1p...", reason="test spend")
    assert out["status"] == "paid" and out["amount_sats"] == 100
    assert out["preimage"] == "ef" * 32 and out["spent_today_sats"] == 100
    assert calls[0][0] == "pay_invoice"

    # Over the per-payment cap: refused before the wallet is ever contacted.
    over = nwc.nwc_pay(dbp, "default", invoice="lnbc2m1p...")
    assert "per-payment cap" in over["error"] and len(calls) == 1

    # Second 100-sat payment fits; the third busts the 250/day ledger cap.
    assert nwc.nwc_pay(dbp, "default", invoice="lnbc1u1p...x")["status"] == "paid"
    daily = nwc.nwc_pay(dbp, "default", invoice="lnbc1u1p...y")
    assert "today's cap" in daily["error"] and len(calls) == 2

    conn = sqlite3.connect(dbp)
    rows = conn.execute("SELECT amount_msat, reason FROM nwc_spends").fetchall()
    conn.close()
    assert len(rows) == 2 and rows[0] == (100_000, "test spend")

    # Amountless invoices are refused (caps would be unenforceable).
    assert "no amount" in nwc.nwc_pay(dbp, "default",
                                      invoice="lnbc1pvjluez...")["error"]
    # No connection for this user -> clean error.
    assert "no NWC connection" in nwc.nwc_pay(dbp, "nobody",
                                              invoice="lnbc1u1p...")["error"]
    print("✓ nwc_pay: caps enforced app-side, every payment in the ledger")


def test_get_balance(monkeypatch):
    _nwc_settings(monkeypatch, max_sats_per_day=500)
    dbp = _fresh_db()
    monkeypatch.setattr(nwc, "nwc_call",
                        lambda uri, m, p, timeout=30: {"balance": 123_000})
    out = nwc.nwc_pay(dbp, "default", action="get_balance")
    assert out == {"balance_sats": 123, "spent_today_sats": 0,
                   "daily_cap_sats": 500, "remaining_today_sats": 500}
    print("✓ get_balance: wallet balance + remaining daily budget")


# --- the L402 loop (HTTP + wallet mocked) ----------------------------------------

class _Resp:
    def __init__(self, status_code, headers=None, payload=None):
        self.status_code = status_code
        self.headers = headers or {}
        self._payload = payload
        self.text = json.dumps(payload) if payload is not None else ""
    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def test_l402_loop_end_to_end(monkeypatch):
    """402 challenge -> parked -> paid via nwc_pay -> token minted -> results."""
    import requests
    _nwc_settings(monkeypatch, max_sats_per_payment=100, max_sats_per_day=500)
    lcfg = config.get_config()["tools"].setdefault("lethe", {})
    monkeypatch.setitem(lcfg, "url", "https://lethe.example.com")
    monkeypatch.setitem(lcfg, "results", 8)
    dbp = _fresh_db()
    invoice = "lnbc210n1p...challenge"
    seen = []

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.append({"url": url, "params": params, "headers": headers or {}})
        if "Authorization" not in (headers or {}):
            return _Resp(402, headers={
                "WWW-Authenticate":
                    f'L402 macaroon="MAC123", invoice="{invoice}"'})
        assert headers["Authorization"] == f"L402 MAC123:{'ef' * 32}"
        return _Resp(200, payload={"results": [
            {"id": "kev:CVE-2024-1", "title": "Known exploited vuln",
             "snippet": "…", "url": "https://cisa.gov/x", "source": "kev",
             "rank": 1, "scores": {"debug": 1}}]})

    monkeypatch.setattr(requests, "get", fake_get)

    # 1. Unpaid search: challenge parked, invoice handed to the model.
    first = nwc.lethe_search(dbp, "actively exploited kernel bugs")
    assert first["status"] == "payment_required"
    assert first["invoice"] == invoice.lower() and first["amount_sats"] == 21
    assert "nwc_pay" in first["note"]

    # 2. Paying that exact invoice mints the token from the parked macaroon.
    _mock_paid(monkeypatch)
    paid = nwc.nwc_pay(dbp, "default", invoice=invoice, reason="lethe access")
    assert paid["status"] == "paid" and "lethe.example.com" in paid["l402"]
    conn = sqlite3.connect(dbp)
    assert conn.execute("SELECT COUNT(*) FROM l402_challenges").fetchone()[0] == 0
    mac = conn.execute("SELECT macaroon FROM l402_tokens").fetchone()[0]
    conn.close()
    assert mac == "MAC123"

    # 3. Retried search sends the Authorization header and gets results.
    second = nwc.lethe_search(dbp, "actively exploited kernel bugs")
    assert second["count"] == 1 and second["paid_access"] is True
    assert second["results"][0]["source"] == "kev"
    assert "scores" not in second["results"][0]      # debug fields not forwarded
    assert seen[-1]["params"]["q"] == "actively exploited kernel bugs"
    print("✓ L402 loop: 402 -> pay -> minted token -> authorized search")


def test_lethe_rejected_token_reparks(monkeypatch):
    import requests
    lcfg = config.get_config()["tools"].setdefault("lethe", {})
    monkeypatch.setitem(lcfg, "url", "https://lethe.example.com")
    dbp = _fresh_db()
    conn = sqlite3.connect(dbp)
    nwc._ensure_schema(conn)
    conn.execute("INSERT INTO l402_tokens VALUES (?, ?, ?, ?)",
                 ("lethe.example.com", "STALE", "00" * 32, "2026-01-01"))
    conn.commit(); conn.close()

    monkeypatch.setattr(requests, "get", lambda *a, **k: _Resp(402, headers={
        "WWW-Authenticate": 'LSAT macaroon="NEW", invoice="lnbc10n1p...z"'}))
    out = nwc.lethe_search(dbp, "x")
    assert out["status"] == "payment_required"       # legacy LSAT header parses too
    conn = sqlite3.connect(dbp)
    assert conn.execute("SELECT COUNT(*) FROM l402_tokens").fetchone()[0] == 0
    assert conn.execute("SELECT macaroon FROM l402_challenges").fetchone()[0] == "NEW"
    conn.close()
    print("✓ rejected/stale token is dropped and the new challenge parked")


def test_lethe_input_validation(monkeypatch):
    lcfg = config.get_config()["tools"].setdefault("lethe", {})
    monkeypatch.setitem(lcfg, "url", "https://lethe.example.com")
    dbp = _fresh_db()
    assert "query is required" in nwc.lethe_search(dbp, "  ")["error"]
    assert "invalid vertical" in nwc.lethe_search(dbp, "x",
                                                  vertical="../etc")["error"]
    monkeypatch.setitem(lcfg, "url", "")
    assert "not configured" in nwc.lethe_search(dbp, "x")["error"]
    print("✓ lethe_search input validation + self-gating error")


# --- executor wiring -------------------------------------------------------------

def test_build_tools_gating_and_dispatch(monkeypatch):
    dbp = os.environ["DB_PATH"]
    # Unconfigured: neither tool registers.
    tools_cfg = config.get_config().setdefault("tools", {})
    monkeypatch.setitem(tools_cfg, "nwc", {})
    monkeypatch.setitem(tools_cfg, "lethe", {})
    schemas, _, _ = main._build_tools(dbp)
    names = {s["function"]["name"] for s in schemas}
    assert "nwc_pay" not in names and "lethe_search" not in names

    monkeypatch.setitem(tools_cfg, "nwc", {"connections": {"default": VALID_URI}})
    monkeypatch.setitem(tools_cfg, "lethe", {"url": "https://lethe.example.com"})
    schemas, execute, _ = main._build_tools(dbp)
    names = {s["function"]["name"] for s in schemas}
    assert {"nwc_pay", "lethe_search"} <= names

    monkeypatch.setattr(nwc, "nwc_pay",
                        lambda dbp, key, action="pay_invoice", invoice=None,
                        reason=None: {"echo": [key, action, invoice]})
    out = json.loads(execute("nwc_pay", {"invoice": "lnbc1u1p..."}))
    assert out["echo"] == ["default", "pay_invoice", "lnbc1u1p..."]

    monkeypatch.setattr(nwc, "lethe_search",
                        lambda dbp, q, vertical=None, mode=None, limit=None:
                        {"echo": q})
    out = json.loads(execute("lethe_search", {"query": "cve"}))
    assert out["echo"] == "cve"
    print("✓ executor: self-gating registration + argument dispatch")
