"""Tests for nwc (the NIP-47 wallet client) and the wallet tool's executor
wiring in main. The wallet's ledger and caps: test_wallet.py.

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
import importlib, db, main, nwc, wallet
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


def test_bolt11_payment_hash():
    # A real invoice (10 sats) paid during live testing; hash value pinned.
    inv = ("lnbc100n1p4g3t0epp5kkzr2ywh75my8cv65h06530qqcgdeu072s3f0reux0h76"
           "zfv2tkqdqqcqzzsxqrrsssp5fyp5l96z0vk8tw2dttmg5m8zu78h8w4tx678nu2j"
           "xwf0cfn3wmns9qxpqysgqksnym6lwxd9yn6myqearjkhrgh30xkcdpek2q0fwe33"
           "f4jc3cxg4l8qyrkf8c5rjw32l6qwygh8e6yle5hzxrf76slxlw2lfs3r3ccqqrmr78k")
    assert nwc.bolt11_payment_hash(inv) == \
        "b5843511d7f53643e19aa5dfaa45e00610dcf1fe5422978f3c33efed092c52ec"
    assert nwc.bolt11_amount_msat(inv) == 10_000        # 10 sats, NOT 10k
    assert nwc.bolt11_payment_hash("lnbc1u1p...") is None
    assert nwc.bolt11_payment_hash("garbage") is None
    print("✓ bolt11 payment hash extracted from tagged data (pinned vector)")


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


# --- encryption probing over a fake relay ----------------------------------------

class _FakeRelay:
    """Scripted relay + wallet in one: decrypts requests with the WALLET's key
    (real interop across roles) and answers encrypted — but ONLY for schemes
    in `supports`; requests under other schemes are silently ignored, exactly
    like a real wallet that can't decrypt them. `mute` ignores everything."""

    def __init__(self, wallet, supports=("nip44_v2", "nip04"), mute=False):
        self.wallet = wallet
        self.wallet_pub = wallet.public_key.format(compressed=True)[1:].hex()
        self.supports, self.mute = set(supports), mute
        self.queue, self.subs = [], {}
        self.methods = []                   # (method, scheme) actually served
        self.request_event = None

    async def send(self, raw):
        msg = json.loads(raw)
        if msg[0] == "REQ":
            self.subs[msg[1]] = msg[2]
            if 13194 in (msg[2].get("kinds") or []):
                self.queue.append(json.dumps(["EOSE", msg[1]]))
        elif msg[0] == "EVENT":
            ev = msg[1]
            self.queue.append(json.dumps(["OK", ev["id"], True, ""]))
            scheme = "nip04" if "?iv=" in ev["content"] else "nip44_v2"
            if self.mute or scheme not in self.supports:
                return                      # wallet can't read it: dead air
            self.request_event = ev
            body = json.loads(nwc._decrypt_payload(
                self.wallet.secret.hex(), ev["pubkey"], ev["content"]))
            self.methods.append((body["method"], scheme))
            reply = json.dumps({"result_type": body["method"], "error": None,
                                "result": {"preimage": "aa" * 32,
                                           "fees_paid": 0}})
            resp_sub = next(s for s, f in self.subs.items()
                            if ev["id"] in (f.get("#e") or []))
            self.queue.append(json.dumps(["EVENT", resp_sub, {
                "kind": 23195, "pubkey": self.wallet_pub,
                "content": nwc._encrypt_payload(
                    scheme, self.wallet.secret.hex(), ev["pubkey"], reply),
                "tags": [["e", ev["id"]]]}]))

    async def recv(self):
        import asyncio
        while not self.queue:
            await asyncio.sleep(0.001)
        return self.queue.pop(0)


def _fake_wallet(monkeypatch, tmp_path, **relay_kw):
    coincurve = pytest.importorskip("coincurve")
    import websockets
    wallet, client = coincurve.PrivateKey(), coincurve.PrivateKey()
    relay = _FakeRelay(wallet, **relay_kw)

    class _CM:
        async def __aenter__(self):
            return relay
        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(websockets, "connect", lambda url, **kw: _CM())
    monkeypatch.setattr(nwc, "_scheme_mem", {})
    monkeypatch.setattr(nwc, "_scheme_store_path",
                        lambda: str(tmp_path / "nwc_schemes.json"))
    monkeypatch.setattr(nwc, "_PROBE_WAIT", 0.3)
    uri = (f"nostr+walletconnect://{relay.wallet_pub}"
           f"?relay=wss://fake.example.com&secret={client.secret.hex()}")
    return relay, uri


def test_probe_confirms_nip44_and_persists(monkeypatch, tmp_path):
    relay, uri = _fake_wallet(monkeypatch, tmp_path)
    result = nwc.nwc_call(uri, "pay_invoice", {"invoice": "lnbc1u1p..."},
                          timeout=3)
    assert result["preimage"] == "aa" * 32
    # First contact: a get_info probe under nip44, then the real request.
    assert relay.methods == [("get_info", "nip44_v2"),
                             ("pay_invoice", "nip44_v2")]
    assert ["encryption", "nip44_v2"] in relay.request_event["tags"]
    with open(nwc._scheme_store_path()) as f:
        stored = json.load(f)
    assert stored[f"wss://fake.example.com|{relay.wallet_pub}"]["scheme"] \
        == "nip44_v2"

    # Second call: confirmed scheme is reused — no probe, even across a
    # simulated restart (in-process mirror cleared, disk store kept).
    monkeypatch.setattr(nwc, "_scheme_mem", {})
    assert nwc.nwc_call(uri, "get_balance", {}, timeout=3)["preimage"]
    assert [m for m, _ in relay.methods] == ["get_info", "pay_invoice",
                                             "get_balance"]
    print("✓ probe confirms nip44, persists to disk, skipped on later calls")


def test_probe_falls_back_to_nip04_only_wallet(monkeypatch, tmp_path):
    # Wallet ignores nip44 requests entirely (dead air) but speaks nip04:
    # this is the silent-mismatch case that produced intermittent timeouts.
    relay, uri = _fake_wallet(monkeypatch, tmp_path, supports=("nip04",))
    assert nwc.nwc_call(uri, "get_balance", {}, timeout=3)["preimage"]
    assert relay.methods == [("get_info", "nip04"), ("get_balance", "nip04")]
    assert "?iv=" in relay.request_event["content"]
    assert all(t[0] != "encryption" for t in relay.request_event["tags"])
    print("✓ nip44-deaf wallet: probe falls back, request goes out as nip04")


def test_unreachable_wallet_sends_nothing(monkeypatch, tmp_path):
    relay, uri = _fake_wallet(monkeypatch, tmp_path, mute=True)
    with pytest.raises(nwc.NwcUnreachable, match="NOT sent"):
        nwc.nwc_call(uri, "pay_invoice", {"invoice": "lnbc1u1p..."}, timeout=3)
    assert relay.methods == []              # the payment never went out
    assert not os.path.exists(nwc._scheme_store_path())
    print("✓ deaf wallet: probes fail, payment is never sent (NwcUnreachable)")


def test_stale_stored_scheme_drops_on_timeout(monkeypatch, tmp_path):
    relay, uri = _fake_wallet(monkeypatch, tmp_path, mute=True)
    conn = nwc.parse_nwc_uri(uri)
    nwc._scheme_put(conn, "nip44_v2")       # confirmed in some earlier epoch
    with pytest.raises(nwc.NwcTimeout):
        nwc.nwc_call(uri, "get_balance", {}, timeout=1)
    assert nwc._scheme_get(conn) is None    # dropped -> next call re-probes
    print("✓ stored scheme that stops answering is dropped for re-probe")


def test_config_pin_skips_probe(monkeypatch, tmp_path):
    relay, uri = _fake_wallet(monkeypatch, tmp_path)
    cfg = config.get_config().setdefault("tools", {}).setdefault("nwc", {})
    monkeypatch.setitem(cfg, "encryption", "nip44")
    assert nwc.nwc_call(uri, "get_balance", {}, timeout=3)["preimage"]
    assert relay.methods == [("get_balance", "nip44_v2")]   # no get_info probe
    print("✓ pinned encryption goes straight to the request, no probe")


# --- executor wiring -------------------------------------------------------------

def test_build_tools_gating_and_dispatch(monkeypatch):
    dbp = os.environ["DB_PATH"]
    # Unconfigured: the tool doesn't register.
    tools_cfg = config.get_config().setdefault("tools", {})
    monkeypatch.setitem(tools_cfg, "nwc", {})
    monkeypatch.setitem(tools_cfg, "wallet", {"provider": "nwc"})
    schemas, _, _ = main._build_tools(dbp)
    assert "wallet" not in {s["function"]["name"] for s in schemas}

    monkeypatch.setitem(tools_cfg, "nwc", {"connections": {"default": VALID_URI}})
    schemas, execute, _ = main._build_tools(dbp)
    assert "wallet" in {s["function"]["name"] for s in schemas}

    monkeypatch.setattr(wallet, "wallet_tool",
                        lambda dbp, key, action="get_balance", invoice=None,
                        reason=None, amount_sats=None, memo=None:
                        {"echo": [key, action, invoice]})
    out = json.loads(execute("wallet", {"action": "pay_invoice",
                                        "invoice": "lnbc1u1p..."}))
    assert out["echo"] == ["default", "pay_invoice", "lnbc1u1p..."]
    print("✓ executor: self-gating registration + argument dispatch")
