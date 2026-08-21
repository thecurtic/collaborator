"""Nostr Wallet Connect (NIP-47) spending + L402 paid search (Lethe).

Two tools live here, deliberately split so the model drives the payment loop
end to end and nwc_pay stays general:

- nwc_pay: pay a BOLT11 invoice (or read the wallet balance) through the
  user's NWC connection — e.g. a Zeus/LDK node running on their phone. The
  wallet side already enforces its own NWC budget; this module adds app-side
  caps (max sats per payment / per day) backed by a spend ledger in the
  per-user conversation DB.
- lethe_search: query an Aperture-fronted Lethe instance (paid vertical
  search). Unauthenticated requests come back HTTP 402 with an L402 challenge
  (macaroon + Lightning invoice); the challenge is parked in the DB and the
  invoice handed to the model. When nwc_pay later settles that exact invoice,
  the preimage + parked macaroon are minted into a reusable L402 token and
  the retried search goes through.

NWC connections are PER USER, keyed by identity hash (the directory name
under backend/data/users/), "default" when auth is off. Connection strings
never live in the repo — config.yaml.example documents the shape, the prod
box carries the real values.

Crypto: NIP-04 (secp256k1 ECDH -> AES-256-CBC) and NIP-44 v2 (ECDH ->
HKDF -> ChaCha20 + HMAC-SHA256) encryption, BIP-340 Schnorr event
signatures, via coincurve + cryptography. Both packages are tolerated
absent — the tools error cleanly instead of crashing the app. The scheme is
negotiated per wallet: the NIP-47 info event (kind 13194) advertises
supported encryption; nip44_v2 is preferred when listed, nip04 is the
legacy default; tools.nwc.encryption can pin either.
"""

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from urllib.parse import urlparse, parse_qs

from config import get_config


class NwcError(Exception):
    """Raised for wallet/relay failures the model should see verbatim."""


# --- config -----------------------------------------------------------------


def _nwc_cfg() -> dict:
    return (get_config().get("tools", {}) or {}).get("nwc") or {}


def _lethe_cfg() -> dict:
    return (get_config().get("tools", {}) or {}).get("lethe") or {}


def user_key_for_db(db_path: str, auth_enabled: bool) -> str:
    """The per-user key for NWC config lookup.

    Under auth, db_path is .../users/{hash}/conversations.db — the hash names
    the user (same idiom as _resolve_vault_dir). Without auth there is one
    anonymous user: "default".
    """
    if auth_enabled:
        return os.path.basename(os.path.dirname(db_path))
    return "default"


def connection_for(user_key: str) -> str:
    return ((_nwc_cfg().get("connections") or {}).get(user_key) or "").strip()


def nwc_configured(user_key: str) -> bool:
    return bool(connection_for(user_key))


def lethe_configured() -> bool:
    return bool((_lethe_cfg().get("url") or "").strip())


# --- NWC connection URI -----------------------------------------------------


def parse_nwc_uri(uri: str) -> dict:
    """nostr+walletconnect://<wallet-pubkey>?relay=wss://...&secret=<hex>."""
    uri = (uri or "").strip()
    if not uri.startswith("nostr+walletconnect://"):
        raise NwcError("not a nostr+walletconnect:// URI")
    parsed = urlparse(uri)
    wallet_pubkey = (parsed.netloc or parsed.path.lstrip("/")).lower()
    q = parse_qs(parsed.query)
    relay = (q.get("relay") or [""])[0]
    secret = ((q.get("secret") or [""])[0]).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", wallet_pubkey or ""):
        raise NwcError("connection URI has no valid wallet pubkey")
    if not relay.startswith(("ws://", "wss://")):
        raise NwcError("connection URI has no valid relay= websocket URL")
    if not re.fullmatch(r"[0-9a-f]{64}", secret or ""):
        raise NwcError("connection URI has no valid secret=")
    return {"wallet_pubkey": wallet_pubkey, "relay": relay, "secret": secret}


# --- NIP-04 encryption + NIP-01 event signing -------------------------------


def _ecdh_key(secret_hex: str, peer_pub_hex: str) -> bytes:
    """NIP-04 shared key: the raw X coordinate of the ECDH point (no hash)."""
    from coincurve import PublicKey
    point = PublicKey(bytes.fromhex("02" + peer_pub_hex)).multiply(
        bytes.fromhex(secret_hex))
    x, _y = point.point()
    return x.to_bytes(32, "big")


def nip04_encrypt(secret_hex: str, peer_pub_hex: str, plaintext: str) -> str:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    key = _ecdh_key(secret_hex, peer_pub_hex)
    iv = os.urandom(16)
    data = plaintext.encode("utf-8")
    pad = 16 - len(data) % 16
    data += bytes([pad]) * pad
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ct = enc.update(data) + enc.finalize()
    return (base64.b64encode(ct).decode() + "?iv="
            + base64.b64encode(iv).decode())


def nip04_decrypt(secret_hex: str, peer_pub_hex: str, content: str) -> str:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    if "?iv=" not in (content or ""):
        raise NwcError("malformed NIP-04 payload (no ?iv=)")
    ct_b64, iv_b64 = content.split("?iv=", 1)
    key = _ecdh_key(secret_hex, peer_pub_hex)
    dec = Cipher(algorithms.AES(key),
                 modes.CBC(base64.b64decode(iv_b64))).decryptor()
    data = dec.update(base64.b64decode(ct_b64)) + dec.finalize()
    pad = data[-1]
    if not 1 <= pad <= 16:
        raise NwcError("malformed NIP-04 padding")
    return data[:-pad].decode("utf-8")


# --- NIP-44 v2 (ChaCha20 + HMAC-SHA256, padded) -----------------------------


def _nip44_conversation_key(secret_hex: str, peer_pub_hex: str) -> bytes:
    """HKDF-extract(salt="nip44-v2", ikm=ECDH x-coordinate)."""
    import hmac as _hmac
    return _hmac.new(b"nip44-v2", _ecdh_key(secret_hex, peer_pub_hex),
                     hashlib.sha256).digest()


def _nip44_message_keys(conversation_key: bytes, nonce: bytes):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand
    keys = HKDFExpand(algorithm=hashes.SHA256(), length=76,
                      info=nonce).derive(conversation_key)
    return keys[:32], keys[32:44], keys[44:76]   # chacha key, nonce, hmac key


def _nip44_padded_len(unpadded_len: int) -> int:
    if unpadded_len <= 32:
        return 32
    next_power = 1 << (unpadded_len - 1).bit_length()
    chunk = 32 if next_power <= 256 else next_power // 8
    return chunk * ((unpadded_len - 1) // chunk + 1)


def _chacha20(key: bytes, nonce12: bytes, data: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms
    # cryptography's ChaCha20 nonce is 16 bytes: 4-byte little-endian initial
    # counter + the RFC 7539 12-byte nonce. NIP-44 uses counter 0.
    enc = Cipher(algorithms.ChaCha20(key, b"\x00" * 4 + nonce12),
                 mode=None).encryptor()
    return enc.update(data)


def nip44_encrypt(secret_hex: str, peer_pub_hex: str, plaintext: str,
                  nonce: bytes = None) -> str:
    import hmac as _hmac
    data = plaintext.encode("utf-8")
    if not 1 <= len(data) <= 65535:
        raise NwcError("nip44 plaintext must be 1..65535 bytes")
    nonce = nonce or os.urandom(32)
    ck = _nip44_conversation_key(secret_hex, peer_pub_hex)
    chacha_key, chacha_nonce, hmac_key = _nip44_message_keys(ck, nonce)
    padded = (len(data).to_bytes(2, "big") + data
              + b"\x00" * (_nip44_padded_len(len(data)) - len(data)))
    ct = _chacha20(chacha_key, chacha_nonce, padded)
    mac = _hmac.new(hmac_key, nonce + ct, hashlib.sha256).digest()
    return base64.b64encode(b"\x02" + nonce + ct + mac).decode()


def nip44_decrypt(secret_hex: str, peer_pub_hex: str, payload: str) -> str:
    import hmac as _hmac
    payload = payload or ""
    if payload.startswith("#"):
        raise NwcError("peer used an unsupported nip44 version")
    try:
        data = base64.b64decode(payload, validate=True)
    except Exception:
        raise NwcError("malformed nip44 payload (bad base64)")
    if len(data) < 1 + 32 + 32 + 32 or data[0] != 2:
        raise NwcError("malformed nip44 payload")
    nonce, ct, mac = data[1:33], data[33:-32], data[-32:]
    ck = _nip44_conversation_key(secret_hex, peer_pub_hex)
    chacha_key, chacha_nonce, hmac_key = _nip44_message_keys(ck, nonce)
    if not _hmac.compare_digest(
            _hmac.new(hmac_key, nonce + ct, hashlib.sha256).digest(), mac):
        raise NwcError("nip44 MAC check failed")
    padded = _chacha20(chacha_key, chacha_nonce, ct)
    unpadded_len = int.from_bytes(padded[:2], "big")
    if not 1 <= unpadded_len <= len(padded) - 2 \
            or len(padded) != 2 + _nip44_padded_len(unpadded_len):
        raise NwcError("nip44 padding check failed")
    return padded[2:2 + unpadded_len].decode("utf-8")


def _encrypt_payload(scheme: str, secret_hex: str, peer_pub_hex: str,
                     plaintext: str) -> str:
    if scheme == "nip44_v2":
        return nip44_encrypt(secret_hex, peer_pub_hex, plaintext)
    return nip04_encrypt(secret_hex, peer_pub_hex, plaintext)


def _decrypt_payload(secret_hex: str, peer_pub_hex: str, content: str) -> str:
    # The payload shape identifies the scheme ("?iv=" is nip04-only), so a
    # wallet answering in either encryption decrypts correctly.
    if "?iv=" in (content or ""):
        return nip04_decrypt(secret_hex, peer_pub_hex, content)
    return nip44_decrypt(secret_hex, peer_pub_hex, content)


def _signed_event(secret_hex: str, kind: int, tags: list, content: str) -> dict:
    from coincurve import PrivateKey
    priv = PrivateKey(bytes.fromhex(secret_hex))
    pubkey = priv.public_key.format(compressed=True)[1:].hex()
    created_at = int(time.time())
    payload = json.dumps([0, pubkey, created_at, kind, tags, content],
                         separators=(",", ":"), ensure_ascii=False)
    event_id = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    sig = priv.sign_schnorr(bytes.fromhex(event_id)).hex()
    return {"id": event_id, "pubkey": pubkey, "created_at": created_at,
            "kind": kind, "tags": tags, "content": content, "sig": sig}


# --- NIP-47 request/response over the relay ---------------------------------

_KIND_INFO = 13194
_KIND_REQUEST = 23194
_KIND_RESPONSE = 23195

# Detected encryption per (relay, wallet_pubkey) — positive results only, so a
# transient relay miss never sticks as "nip04 forever".
_ENC_SCHEMES = {}


async def _detect_scheme(ws, conn: dict, loop, deadline: float):
    """Read the wallet's NIP-47 info event and pick the encryption scheme.

    Returns "nip44_v2" when advertised, "nip04" when the info event exists
    without it (legacy wallet), None when no info event was found in time.
    """
    sub_id = secrets.token_hex(8)
    await ws.send(json.dumps(["REQ", sub_id, {
        "kinds": [_KIND_INFO], "authors": [conn["wallet_pubkey"]],
        "limit": 1}]))
    scheme = None
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(msg, list) or len(msg) < 2 or msg[1] != sub_id:
                continue
            if msg[0] == "EVENT" and len(msg) >= 3:
                advertised = []
                for tag in (msg[2].get("tags") or []):
                    if tag and tag[0] == "encryption":
                        advertised += " ".join(tag[1:]).split()
                scheme = "nip44_v2" if "nip44_v2" in advertised else "nip04"
                break
            if msg[0] in ("EOSE", "CLOSED"):
                break
    except asyncio.TimeoutError:
        pass
    await ws.send(json.dumps(["CLOSE", sub_id]))
    return scheme


async def _session(conn: dict, method: str, params: dict, pref: str,
                   timeout: float):
    """One NIP-47 exchange on one websocket: negotiate encryption, publish
    the encrypted request, await the response event. Returns the raw event."""
    import websockets
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    cache_key = (conn["relay"], conn["wallet_pubkey"])
    async with websockets.connect(conn["relay"], open_timeout=min(timeout, 10),
                                  close_timeout=3) as ws:
        if pref in ("nip04", "nip44", "nip44_v2"):
            scheme = "nip44_v2" if pref.startswith("nip44") else "nip04"
        else:   # auto: info event, cached per connection; nip04 is the default
            scheme = _ENC_SCHEMES.get(cache_key)
            if scheme is None:
                scheme = await _detect_scheme(
                    ws, conn, loop, min(deadline, loop.time() + 4))
                if scheme:
                    _ENC_SCHEMES[cache_key] = scheme
                scheme = scheme or "nip04"

        body = json.dumps({"method": method, "params": params or {}})
        content = _encrypt_payload(scheme, conn["secret"],
                                   conn["wallet_pubkey"], body)
        tags = [["p", conn["wallet_pubkey"]]]
        if scheme == "nip44_v2":
            tags.append(["encryption", "nip44_v2"])
        event = _signed_event(conn["secret"], _KIND_REQUEST, tags, content)

        sub_id = secrets.token_hex(8)
        # Subscribe for the response BEFORE publishing, so it can't be missed.
        await ws.send(json.dumps(["REQ", sub_id, {
            "kinds": [_KIND_RESPONSE], "#e": [event["id"]],
            "authors": [conn["wallet_pubkey"]]}]))
        await ws.send(json.dumps(["EVENT", event]))
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise NwcError("timed out waiting for the wallet — is the "
                               "Zeus node online and connected to its relay?")
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                continue
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(msg, list) or not msg:
                continue
            if msg[0] == "OK" and len(msg) >= 4 and msg[1] == event["id"] \
                    and not msg[2]:
                raise NwcError(f"relay rejected the request: {msg[3]}")
            if msg[0] == "EVENT" and len(msg) >= 3 and msg[1] == sub_id:
                return msg[2]
            if msg[0] == "CLOSED" and len(msg) >= 2 and msg[1] == sub_id:
                raise NwcError("relay closed the subscription before the "
                               "wallet answered")


def nwc_call(uri: str, method: str, params: dict, timeout: float = 30) -> dict:
    """One NIP-47 request: negotiate encryption, publish, await, decrypt.

    Returns the wallet's `result` dict; raises NwcError on any failure
    (including a structured NIP-47 error response).
    """
    conn = parse_nwc_uri(uri)
    pref = str(_nwc_cfg().get("encryption") or "auto").lower()
    try:
        resp = asyncio.run(_session(conn, method, params, pref, timeout))
    except NwcError:
        raise
    except ImportError:
        raise NwcError("NWC crypto unavailable — install coincurve + "
                       "cryptography (see requirements.txt)")
    except Exception as e:  # websocket/DNS/TLS failures, all model-relevant
        raise NwcError(f"relay connection failed: {e}")
    try:
        plain = _decrypt_payload(conn["secret"], resp.get("pubkey", ""),
                                 resp.get("content", ""))
        data = json.loads(plain)
    except NwcError:
        raise
    except Exception:
        raise NwcError("could not decrypt/parse the wallet's response")
    err = data.get("error")
    if err:
        raise NwcError(f"wallet error {err.get('code', '?')}: "
                       f"{err.get('message', '')}")
    return data.get("result") or {}


# --- BOLT11 amount (hrp only — enough for cap enforcement) ------------------

_BOLT11_RE = re.compile(r"^ln(bcrt|tbs|tb|bc)(\d+)?([munp])?1", re.IGNORECASE)
_MULTIPLIER = {"": 1, "m": 10 ** 3, "u": 10 ** 6, "n": 10 ** 9, "p": 10 ** 12}


def bolt11_amount_msat(invoice: str):
    """Amount in msat from the invoice's human-readable part, or None when the
    invoice carries no amount. Raises NwcError on non-bolt11 input."""
    inv = (invoice or "").strip().lower()
    m = _BOLT11_RE.match(inv)
    if not m:
        raise NwcError("not a BOLT11 invoice")
    if not m.group(2):
        return None
    amount, unit = int(m.group(2)), (m.group(3) or "")
    # 1 BTC = 10^11 msat; unit divides the BTC amount.
    msat_times_div = amount * 10 ** 11
    div = _MULTIPLIER[unit]
    if msat_times_div % div:
        raise NwcError("invoice amount is not an integer msat value")
    return msat_times_div // div


# --- spend ledger + L402 storage (per-user conversation DB) -----------------


def _ensure_schema(conn) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS nwc_spends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            day TEXT NOT NULL,
            amount_msat INTEGER NOT NULL,
            fees_msat INTEGER,
            invoice TEXT NOT NULL,
            preimage TEXT,
            reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_nwc_spends_day ON nwc_spends(day);
        CREATE TABLE IF NOT EXISTS l402_challenges (
            invoice TEXT PRIMARY KEY,
            macaroon TEXT NOT NULL,
            host TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS l402_tokens (
            host TEXT PRIMARY KEY,
            macaroon TEXT NOT NULL,
            preimage TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
    """)
    conn.commit()


def _spent_today_msat(conn) -> int:
    row = conn.execute("SELECT COALESCE(SUM(amount_msat), 0) FROM nwc_spends "
                       "WHERE day = ?", (time.strftime("%Y-%m-%d"),)).fetchone()
    return int(row[0] or 0)


def _record_spend(conn, amount_msat: int, fees_msat, invoice: str,
                  preimage, reason) -> None:
    conn.execute(
        "INSERT INTO nwc_spends (created_at, day, amount_msat, fees_msat, "
        "invoice, preimage, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (time.strftime("%Y-%m-%dT%H:%M:%S"), time.strftime("%Y-%m-%d"),
         amount_msat, fees_msat, invoice, preimage, reason))
    conn.commit()


# --- the tools --------------------------------------------------------------


def nwc_pay(db_path: str, user_key: str, action: str = "pay_invoice",
            invoice: str = None, reason: str = None) -> dict:
    """Pay a BOLT11 invoice (or read the balance) via the user's NWC wallet.

    App-side caps on top of the wallet's own NWC budget:
    tools.nwc.max_sats_per_payment and max_sats_per_day (spend ledger in the
    per-user DB). Paying an invoice that matches a parked L402 challenge mints
    a reusable access token for that host.
    """
    uri = connection_for(user_key)
    if not uri:
        return {"error": "no NWC connection configured for this user "
                         "(tools.nwc.connections)"}
    cfg = _nwc_cfg()
    timeout = cfg.get("timeout", 30)
    action = (action or "pay_invoice").strip()

    if action == "get_balance":
        try:
            result = nwc_call(uri, "get_balance", {}, timeout=timeout)
        except NwcError as e:
            return {"error": str(e)}
        out = {"balance_sats": int(result.get("balance", 0)) // 1000}
        conn = sqlite3.connect(db_path)
        try:
            _ensure_schema(conn)
            spent = _spent_today_msat(conn) // 1000
        finally:
            conn.close()
        cap_day = cfg.get("max_sats_per_day", 500)
        out.update({"spent_today_sats": spent, "daily_cap_sats": cap_day,
                    "remaining_today_sats": max(0, cap_day - spent)})
        return out

    if action != "pay_invoice":
        return {"error": f"unknown action {action!r} (pay_invoice | get_balance)"}
    inv = (invoice or "").strip().lower()
    if not inv:
        return {"error": "invoice is required for pay_invoice"}
    try:
        amount_msat = bolt11_amount_msat(inv)
    except NwcError as e:
        return {"error": str(e)}
    if amount_msat is None:
        return {"error": "invoice has no amount — amountless invoices are "
                         "refused because spending caps can't be enforced"}
    amount_sats = amount_msat // 1000
    cap_pay = cfg.get("max_sats_per_payment", 100)
    cap_day = cfg.get("max_sats_per_day", 500)

    conn = sqlite3.connect(db_path)
    try:
        _ensure_schema(conn)
        spent_msat = _spent_today_msat(conn)
        if amount_msat > cap_pay * 1000:
            return {"error": f"invoice is {amount_sats} sats — over the "
                             f"per-payment cap of {cap_pay} sats "
                             "(tools.nwc.max_sats_per_payment)"}
        if spent_msat + amount_msat > cap_day * 1000:
            return {"error": f"paying {amount_sats} sats would exceed today's "
                             f"cap of {cap_day} sats "
                             f"({spent_msat // 1000} already spent)"}
        try:
            result = nwc_call(uri, "pay_invoice", {"invoice": inv},
                              timeout=timeout)
        except NwcError as e:
            return {"error": str(e)}
        preimage = result.get("preimage")
        fees_msat = result.get("fees_paid")
        _record_spend(conn, amount_msat, fees_msat, inv, preimage, reason)
        out = {"status": "paid", "amount_sats": amount_sats,
               "fees_msat": fees_msat, "preimage": preimage,
               "spent_today_sats": (spent_msat + amount_msat) // 1000,
               "daily_cap_sats": cap_day}
        # L402: settling a parked challenge mints the access token.
        row = conn.execute("SELECT macaroon, host FROM l402_challenges "
                           "WHERE invoice = ?", (inv,)).fetchone()
        if row and preimage:
            macaroon, host = row
            conn.execute("INSERT OR REPLACE INTO l402_tokens "
                         "(host, macaroon, preimage, created_at) "
                         "VALUES (?, ?, ?, ?)",
                         (host, macaroon, preimage,
                          time.strftime("%Y-%m-%dT%H:%M:%S")))
            conn.execute("DELETE FROM l402_challenges WHERE invoice = ?",
                         (inv,))
            conn.commit()
            out["l402"] = (f"access token minted for {host} — call "
                           "lethe_search again to run the paid search")
        return out
    finally:
        conn.close()


_L402_CHALLENGE_RE = re.compile(
    r'(?:L402|LSAT)\s+macaroon="([^"]+)",\s*invoice="([^"]+)"')


def lethe_search(db_path: str, query: str, vertical: str = None,
                 mode: str = None, limit: int = None) -> dict:
    """Search the Aperture-fronted Lethe API, driving the L402 loop.

    With a stored token: authorized request. Without one (or when the token is
    rejected): park the 402 challenge and hand the invoice to the model, which
    pays it via nwc_pay and retries.
    """
    import requests
    cfg = _lethe_cfg()
    base = (cfg.get("url") or "").strip().rstrip("/")
    if not base:
        return {"error": "lethe search is not configured (tools.lethe.url)"}
    if not (query or "").strip():
        return {"error": "query is required"}
    vertical = (vertical or cfg.get("vertical") or "cybersec").strip()
    if not re.fullmatch(r"[a-z0-9_-]+", vertical):
        return {"error": f"invalid vertical {vertical!r}"}
    max_results = cfg.get("results", 8)
    try:
        limit = max(1, min(int(limit), max_results)) if limit else max_results
    except (TypeError, ValueError):
        limit = max_results
    host = urlparse(base).netloc
    url = f"{base}/v1/{vertical}/search"
    params = {"q": query, "limit": limit}
    if mode in ("hybrid", "lexical", "semantic"):
        params["mode"] = mode

    conn = sqlite3.connect(db_path)
    try:
        _ensure_schema(conn)
        token = conn.execute("SELECT macaroon, preimage FROM l402_tokens "
                             "WHERE host = ?", (host,)).fetchone()
        headers = {}
        if token:
            headers["Authorization"] = f"L402 {token[0]}:{token[1]}"
        try:
            r = requests.get(url, params=params, headers=headers,
                             timeout=cfg.get("timeout", 20))
        except requests.RequestException as e:
            return {"error": f"lethe request failed: {e}"}

        if r.status_code == 402:
            challenge = _L402_CHALLENGE_RE.search(
                r.headers.get("WWW-Authenticate", ""))
            if not challenge:
                return {"error": "got HTTP 402 but no parseable L402 "
                                 "challenge in WWW-Authenticate"}
            macaroon, invoice = challenge.group(1), challenge.group(2).lower()
            if token:
                # The stored token no longer opens the door; drop it.
                conn.execute("DELETE FROM l402_tokens WHERE host = ?", (host,))
            conn.execute("INSERT OR REPLACE INTO l402_challenges "
                         "(invoice, macaroon, host, created_at) "
                         "VALUES (?, ?, ?, ?)",
                         (invoice, macaroon, host,
                          time.strftime("%Y-%m-%dT%H:%M:%S")))
            conn.commit()
            try:
                amount_msat = bolt11_amount_msat(invoice)
            except NwcError:
                amount_msat = None
            return {"status": "payment_required",
                    "amount_sats": (amount_msat // 1000)
                    if amount_msat is not None else None,
                    "invoice": invoice,
                    "note": "access to this search requires an L402 payment: "
                            "pay this exact invoice with nwc_pay, then call "
                            "lethe_search again — the access token is minted "
                            "automatically and reused for future searches"}

        if r.status_code != 200:
            return {"error": f"lethe returned HTTP {r.status_code}: "
                             f"{r.text[:200]}"}
        try:
            data = r.json()
        except ValueError:
            return {"error": "lethe returned non-JSON"}
    finally:
        conn.close()

    results = (data.get("results") or [])[:limit]
    return {"vertical": vertical, "query": query, "count": len(results),
            "paid_access": bool(token),
            "results": [{"title": x.get("title"), "snippet": x.get("snippet"),
                         "url": x.get("url"), "source": x.get("source"),
                         "id": x.get("id"), "rank": x.get("rank")}
                        for x in results]}
