"""Collaborator's own Lightning wallet: pay, receive, and the spend ledger.

The shape copies the DITTA broker's (UX doc, Money): one LNbits wallet on the
user's LND node, funded with a working budget, with two keys scoped to that
wallet alone —

- the **invoice key** creates invoices and reads their status and the
  balance: the receive credential, which cannot move money;
- the **admin key** can also pay invoices FROM THAT WALLET ONLY: the spend
  credential, whose blast radius is the wallet's balance, not the node.

Collaborator holds no node-level credential. On top of the wallet's balance
this module enforces the local discipline the broker does: a park-before-pay
ledger, per-payment and per-day caps, amountless invoices refused, and a
lookup by payment hash so a timed-out payment is recovered rather than paid
twice.

Providers sit behind `tools.wallet.provider`: `lnbits` is what runs; `nwc`
(Nostr Wallet Connect, nwc.py) stays as a dormant alternative. Wallets are
PER USER, keyed by identity hash like every per-user setting ("default" with
auth off). Keys never live in the repo.

Callers: the `wallet` tool (the model pays, checks the balance, or mints a
top-up invoice for the user), the DITTA search tool, which pays its own
per-query invoices through `pay()` without the model ever seeing them, and
the app's Wallet screen (/api/wallet), where the user tops the wallet up and
takes money out. The caps restrain the MODEL: payments the user makes
themselves are recorded in the ledger (source 'user') but neither checked
against the caps nor counted toward them.
"""

import re
import sqlite3
import time

from config import get_config

import nwc


class WalletError(Exception):
    """A definitive failure: nothing was spent (or nothing to recover)."""


class WalletUnconfirmed(WalletError):
    """The wallet took the payment but didn't confirm it in time. It may
    still settle: the ledger row stays and counts against the daily cap,
    and paying the SAME invoice again checks before it pays."""


class WalletCapExceeded(WalletError):
    """A local spending cap (or the caller's ceiling) would be exceeded."""


_PREIMAGE_RE = re.compile(r"^[0-9a-f]{64}$")


def _cfg() -> dict:
    return (get_config().get("tools", {}) or {}).get("wallet") or {}


def user_key_for_db(db_path: str, auth_enabled: bool) -> str:
    return nwc.user_key_for_db(db_path, auth_enabled)


def _normalize_invoice(bolt11: str) -> str:
    inv = (bolt11 or "").strip().lower()
    return inv[len("lightning:"):] if inv.startswith("lightning:") else inv


# --- providers ------------------------------------------------------------------


class LnbitsProvider:
    """One LNbits wallet, through its wallet-scoped keys (LNbits v0/v1 API:
    POST /api/v1/payments to mint and pay, GET /api/v1/payments/<hash> for
    status and preimage, GET /api/v1/wallet for the balance)."""

    name = "lnbits"

    def __init__(self, url: str, invoice_key: str, admin_key: str,
                 timeout: float = 30):
        self._url = url.rstrip("/")
        self._invoice_key = invoice_key
        self._admin_key = admin_key
        self._timeout = timeout

    @property
    def can_pay(self) -> bool:
        return bool(self._admin_key)

    def _get(self, path: str, key: str, timeout: float = 10):
        import requests
        r = requests.get(self._url + path, headers={"X-Api-Key": key},
                         timeout=timeout)
        return r

    @staticmethod
    def _fields(data: dict) -> dict:
        """Flatten the version-dependent shapes LNbits answers with."""
        out = dict(data.get("details") or {})
        out.update({k: v for k, v in data.items() if k != "details"})
        return out

    @classmethod
    def _settled(cls, data: dict) -> bool:
        f = cls._fields(data)
        return data.get("paid") is True or f.get("paid") is True \
            or f.get("status") == "success"

    @classmethod
    def _preimage(cls, data: dict):
        f = cls._fields(data)
        p = str(data.get("preimage") or f.get("preimage") or "").strip().lower()
        return p if _PREIMAGE_RE.match(p) and p != "0" * 64 else None

    def received(self, payment_hash: str):
        """True/False for an invoice this wallet minted; None when LNbits
        can't be asked right now."""
        import requests
        try:
            r = self._get(f"/api/v1/payments/{payment_hash}",
                          self._invoice_key or self._admin_key)
        except requests.RequestException:
            return None
        if r.status_code == 404:
            return False
        if r.status_code >= 400:
            return None
        try:
            return self._settled(r.json())
        except ValueError:
            return None

    def balance_msat(self) -> int:
        import requests
        try:
            r = self._get("/api/v1/wallet", self._invoice_key or self._admin_key)
        except requests.RequestException as e:
            raise WalletError(f"LNbits unreachable: {e}")
        if r.status_code >= 400:
            raise WalletError(f"LNbits refused the balance check (HTTP {r.status_code})")
        return int(r.json().get("balance") or 0)

    def create_invoice(self, sats: int, memo: str, expiry: int = 3600):
        import requests
        try:
            r = requests.post(
                self._url + "/api/v1/payments",
                headers={"X-Api-Key": self._invoice_key or self._admin_key},
                json={"out": False, "amount": sats, "unit": "sat",
                      "memo": memo, "expiry": expiry},
                timeout=15)
        except requests.RequestException as e:
            raise WalletError(f"LNbits unreachable: {e}")
        if r.status_code >= 400:
            raise WalletError(f"LNbits refused to mint an invoice (HTTP {r.status_code})")
        data = r.json()
        bolt11 = data.get("bolt11") or data.get("payment_request") or ""
        payment_hash = data.get("payment_hash") or ""
        if not bolt11 or not payment_hash:
            raise WalletError("LNbits minted no usable invoice")
        return payment_hash, bolt11

    def pay(self, bolt11: str, payment_hash):
        """(preimage, fees_msat). WalletUnconfirmed when it may still
        settle; WalletError when it definitively didn't."""
        import requests
        try:
            r = requests.post(
                self._url + "/api/v1/payments",
                headers={"X-Api-Key": self._admin_key},
                json={"out": True, "bolt11": bolt11}, timeout=self._timeout)
        except requests.Timeout:
            raise WalletUnconfirmed(
                "LNbits did not answer in time — the payment is UNCONFIRMED "
                "and may still settle")
        except requests.RequestException as e:
            raise WalletError(f"LNbits unreachable, nothing was sent: {e}")
        if r.status_code >= 400:
            detail = ""
            try:
                detail = str(r.json().get("detail", ""))[:200]
            except Exception:
                pass
            raise WalletError(f"LNbits refused the payment (HTTP {r.status_code})"
                              + (f": {detail}" if detail else ""))
        payment_hash = r.json().get("payment_hash") or payment_hash
        deadline = time.monotonic() + self._timeout
        while time.monotonic() < deadline:
            state, preimage, fees = self.lookup(bolt11, payment_hash)
            if state == "settled" and preimage:
                return preimage, fees
            if state == "unpaid":
                raise WalletError("LNbits reported the payment failed")
            time.sleep(0.5)
        raise WalletUnconfirmed(
            "LNbits accepted the payment but hasn't confirmed it yet — it is "
            "UNCONFIRMED and may still settle")

    def lookup(self, bolt11: str, payment_hash):
        """(state, preimage, fees_msat): settled | unpaid | pending |
        unreachable. "unpaid" means definitively not paid (failed or never
        seen), so paying again is safe."""
        import requests
        if not payment_hash:
            return "unreachable", None, None
        try:
            r = self._get(f"/api/v1/payments/{payment_hash}", self._admin_key)
        except requests.RequestException:
            return "unreachable", None, None
        if r.status_code == 404:
            return "unpaid", None, None
        if r.status_code >= 400:
            return "unreachable", None, None
        try:
            data = r.json()
        except ValueError:
            return "unreachable", None, None
        f = self._fields(data)
        if self._settled(data):
            fee = f.get("fee")
            return "settled", self._preimage(data), abs(int(fee)) if fee else None
        if f.get("status") == "failed":
            return "unpaid", None, None
        return "pending", None, None


class NwcProvider:
    """Nostr Wallet Connect, kept dormant behind the switch (UX doc, Money).
    The connection's own NWC budget is an extra wall on the wallet side."""

    name = "nwc"
    can_pay = True

    def __init__(self, uri: str, timeout: float = 30):
        self._uri = uri
        self._timeout = timeout

    def balance_msat(self) -> int:
        try:
            return int(nwc.nwc_call(self._uri, "get_balance", {},
                                    timeout=self._timeout).get("balance", 0))
        except nwc.NwcError as e:
            raise WalletError(str(e))

    def create_invoice(self, sats: int, memo: str, expiry: int = 3600):
        try:
            res = nwc.nwc_call(self._uri, "make_invoice",
                               {"amount": sats * 1000, "description": memo,
                                "expiry": expiry}, timeout=self._timeout)
        except nwc.NwcError as e:
            raise WalletError(str(e))
        bolt11 = res.get("invoice") or ""
        if not bolt11:
            raise WalletError("the wallet minted no usable invoice")
        return res.get("payment_hash") or nwc.bolt11_payment_hash(bolt11), bolt11

    def received(self, payment_hash: str):
        try:
            res = nwc.nwc_call(self._uri, "lookup_invoice",
                               {"payment_hash": payment_hash},
                               timeout=self._timeout)
        except (nwc.NwcTimeout, nwc.NwcUnreachable):
            return None
        except nwc.NwcError as e:
            return False if "not" in str(e).lower() and "found" in str(e).lower() \
                else None
        return bool(res.get("settled_at") or res.get("preimage"))

    def pay(self, bolt11: str, payment_hash):
        try:
            res = nwc.nwc_call(self._uri, "pay_invoice", {"invoice": bolt11},
                               timeout=self._timeout)
        except nwc.NwcTimeout as e:
            raise WalletUnconfirmed(str(e))
        except nwc.NwcError as e:          # incl. unreachable: nothing was sent
            raise WalletError(str(e))
        preimage = (res.get("preimage") or "").strip().lower() or None
        return preimage, res.get("fees_paid")

    def lookup(self, bolt11: str, payment_hash):
        state, preimage, fees = nwc._lookup_payment(
            self._uri, bolt11, payment_hash, self._timeout)
        # "unknown": the wallet offers no way to check — never repay blind.
        return ("unreachable" if state == "unknown" else state), preimage, fees


def provider_for(user_key: str):
    """The configured provider for this user, or None when they have no
    wallet (every tool that needs one then stays out of the tool list)."""
    cfg = _cfg()
    which = str(cfg.get("provider") or "lnbits").lower()
    timeout = cfg.get("timeout", 30)
    if which == "nwc":
        uri = nwc.connection_for(user_key)
        return NwcProvider(uri, timeout) if uri else None
    if which != "lnbits":
        return None
    lb = cfg.get("lnbits") or {}
    entry = (lb.get("wallets") or {}).get(user_key) or {}
    url = (entry.get("url") or lb.get("url") or "").strip()
    invoice_key = (entry.get("invoice_key") or "").strip()
    admin_key = (entry.get("admin_key") or "").strip()
    if not url or not (invoice_key or admin_key):
        return None
    return LnbitsProvider(url, invoice_key, admin_key, timeout)


def configured(user_key: str) -> bool:
    return provider_for(user_key) is not None


# --- the ledger (per-user conversation DB) --------------------------------------


def _ensure_schema(conn) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS wallet_spends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            day TEXT NOT NULL,
            provider TEXT NOT NULL,
            amount_msat INTEGER NOT NULL,
            fees_msat INTEGER,
            invoice TEXT NOT NULL,
            payment_hash TEXT,
            preimage TEXT,
            reason TEXT,
            status TEXT NOT NULL,     -- 'paid' | 'unconfirmed'
            source TEXT NOT NULL DEFAULT 'model'   -- 'model' | 'user'
        );
        CREATE INDEX IF NOT EXISTS idx_wallet_spends_day ON wallet_spends(day);
        CREATE INDEX IF NOT EXISTS idx_wallet_spends_invoice
            ON wallet_spends(invoice);
    """)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(wallet_spends)")}
    if "source" not in cols:
        conn.execute("ALTER TABLE wallet_spends ADD COLUMN source TEXT "
                     "NOT NULL DEFAULT 'model'")
    conn.commit()


def spent_today_msat(conn, provider: str = None) -> int:
    """The MODEL's spending today (the user's own sends don't count against
    its caps). Paid AND unconfirmed: an unconfirmed payment may have spent
    the money, so it counts until it's known not to have. With `provider`,
    only that wallet's spending: NWC and LNbits can draw on different nodes,
    each with its own budget."""
    _ensure_schema(conn)
    sql = ("SELECT COALESCE(SUM(amount_msat), 0) FROM wallet_spends "
           "WHERE day = ? AND source = 'model'")
    params = [time.strftime("%Y-%m-%d")]
    if provider:
        sql += " AND provider = ?"
        params.append(provider)
    row = conn.execute(sql, params).fetchone()
    return int(row[0] or 0)


def _caps():
    cfg = _cfg()
    return (int(cfg.get("max_sats_per_payment", 100)) * 1000,
            int(cfg.get("max_sats_per_day", 500)) * 1000)


def pay(db_path: str, user_key: str, bolt11: str, reason: str = None,
        max_msat: int = None, source: str = "model") -> dict:
    """Pay one BOLT11 invoice from the user's wallet, within the caps.

    Returns {status: "paid", preimage, amount_msat, fees_msat, recovered?}.
    Raises WalletCapExceeded, WalletUnconfirmed (retry the SAME invoice
    later: it's checked before anything is paid again) or WalletError.
    `max_msat` is the caller's own ceiling for this one payment (the DITTA
    tool's per-query cap), applied on top of the configured caps.
    `source="user"` is the user paying from the Wallet screen: the configured
    caps don't apply and it isn't counted toward them; everything else (the
    ledger, recovery, never paying an invoice twice) does.
    """
    provider = provider_for(user_key)
    if provider is None:
        raise WalletError("no wallet is configured for this user (tools.wallet)")
    if not provider.can_pay:
        raise WalletError("this wallet has no spend key (admin_key) configured")
    inv = _normalize_invoice(bolt11)
    try:
        amount = nwc.bolt11_amount_msat(inv)
    except nwc.NwcError as e:
        raise WalletError(str(e))
    if amount is None:
        raise WalletError("amountless invoice refused: spending caps can't be "
                          "enforced")
    payment_hash = nwc.bolt11_payment_hash(inv)
    cap_payment, cap_day = _caps()

    conn = sqlite3.connect(db_path)
    try:
        _ensure_schema(conn)
        prior = conn.execute(
            "SELECT id, status, preimage, fees_msat, provider, payment_hash "
            "FROM wallet_spends WHERE invoice = ? ORDER BY id DESC LIMIT 1",
            (inv,)).fetchone()
        if prior and prior[1] == "paid":
            return {"status": "paid", "already_paid": True, "preimage": prior[2],
                    "amount_msat": amount, "fees_msat": prior[3]}
        if prior and prior[4] != provider.name:
            # Attempted through the OTHER wallet (they can sit on different
            # nodes): this one can't know whether it settled, and answering
            # "never seen it" would pay twice.
            raise WalletUnconfirmed(
                f"an earlier attempt to pay this invoice through the {prior[4]} "
                "wallet is still unconfirmed, and only that wallet can say "
                "whether it settled — nothing was paid; switch back to check it")
        if prior:
            # RECOVERY: an earlier attempt didn't confirm. Ask the wallet what
            # happened before anything else — including the caps, since a
            # settled payment already spent the money.
            state, preimage, fees = provider.lookup(inv, prior[5] or payment_hash)
            if state == "settled":
                conn.execute("UPDATE wallet_spends SET status = 'paid', "
                             "preimage = ?, fees_msat = ? WHERE id = ?",
                             (preimage, fees, prior[0]))
                conn.commit()
                return {"status": "paid", "recovered": True, "preimage": preimage,
                        "amount_msat": amount, "fees_msat": fees}
            if state in ("pending", "unreachable"):
                raise WalletUnconfirmed(
                    "an earlier attempt to pay this invoice is still unconfirmed "
                    + ("(the wallet says it's in flight)" if state == "pending"
                       else "and the wallet can't be checked right now")
                    + " — nothing new was paid; try the same invoice again later")
            # "unpaid": definitively never settled; safe to try again.
            conn.execute("DELETE FROM wallet_spends WHERE id = ?", (prior[0],))
            conn.commit()

        if max_msat is not None and amount > max_msat:
            raise WalletCapExceeded(f"invoice is {amount // 1000} sats, over the "
                                    f"{max_msat // 1000}-sat ceiling for this payment")
        if source == "model" and amount > cap_payment:
            raise WalletCapExceeded(f"invoice is {amount // 1000} sats, over the "
                                    f"per-payment cap of {cap_payment // 1000} sats "
                                    "(tools.wallet.max_sats_per_payment)")
        spent = spent_today_msat(conn, provider.name)
        if source == "model" and spent + amount > cap_day:
            raise WalletCapExceeded(f"paying {amount // 1000} sats would exceed "
                                    f"today's cap of {cap_day // 1000} sats "
                                    f"({spent // 1000} already spent)")

        # Park the attempt BEFORE contacting the wallet, so a timeout or a
        # crash always leaves a trace that counts against the daily cap.
        cur = conn.execute(
            "INSERT INTO wallet_spends (created_at, day, provider, amount_msat, "
            "invoice, payment_hash, reason, status, source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'unconfirmed', ?)",
            (time.strftime("%Y-%m-%dT%H:%M:%S"), time.strftime("%Y-%m-%d"),
             provider.name, amount, inv, payment_hash, reason,
             "user" if source == "user" else "model"))
        row_id = cur.lastrowid
        conn.commit()
        try:
            preimage, fees = provider.pay(inv, payment_hash)
        except WalletUnconfirmed:
            raise                                   # the row stays, parked
        except WalletError:
            conn.execute("DELETE FROM wallet_spends WHERE id = ?", (row_id,))
            conn.commit()
            raise
        conn.execute("UPDATE wallet_spends SET status = 'paid', preimage = ?, "
                     "fees_msat = ? WHERE id = ?", (preimage, fees, row_id))
        conn.commit()
        return {"status": "paid", "preimage": preimage, "amount_msat": amount,
                "fees_msat": fees}
    finally:
        conn.close()


# --- the Wallet screen (/api/wallet) ----------------------------------------------


def decode_invoice(bolt11: str) -> dict:
    """What the user is about to pay: amount, description, expiry. Raises
    WalletError on anything that isn't a BOLT11 invoice."""
    inv = _normalize_invoice(bolt11)
    try:
        amount = nwc.bolt11_amount_msat(inv)
    except nwc.NwcError as e:
        raise WalletError(str(e))
    fields = nwc.bolt11_decode(inv) or {}
    out = {"invoice": inv,
           "amount_sats": None if amount is None else amount // 1000,
           "amount_msat": amount,
           "description": fields.get("description"),
           "payment_hash": fields.get("payment_hash")}
    if fields.get("timestamp"):
        expires = fields["timestamp"] + int(fields.get("expiry") or 3600)
        out["expires_at"] = expires
        out["expired"] = expires < time.time()
    return out


def recent_spends(db_path: str, limit: int = 20) -> list:
    conn = sqlite3.connect(db_path)
    try:
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT created_at, provider, amount_msat, fees_msat, reason, "
            "status, source FROM wallet_spends ORDER BY id DESC LIMIT ?",
            (limit,)).fetchall()
    finally:
        conn.close()
    return [{"created_at": r[0], "provider": r[1],
             "amount_sats": r[2] // 1000, "fees_sats": (r[3] or 0) // 1000,
             "reason": r[4], "status": r[5], "source": r[6]} for r in rows]


def summary(db_path: str, user_key: str) -> dict:
    """The Wallet screen: balance, the model's budget today, recent spends.
    {configured: false} when this user has no wallet."""
    provider = provider_for(user_key)
    if provider is None:
        return {"configured": False}
    out = {"configured": True, "provider": provider.name,
           "can_pay": bool(provider.can_pay),
           "recent": recent_spends(db_path)}
    try:
        out.update(_balance(db_path, provider))
        out.pop("note", None)
    except WalletError as e:
        out["error"] = str(e)
    return out


def receive(user_key: str, amount_sats, memo: str = None) -> dict:
    provider = provider_for(user_key)
    if provider is None:
        raise WalletError("no wallet is configured for this user (tools.wallet)")
    try:
        sats = int(amount_sats)
    except (TypeError, ValueError):
        raise WalletError("amount_sats must be a whole number")
    if not 1 <= sats <= 10_000_000:
        raise WalletError("amount_sats must be between 1 and 10,000,000")
    memo = (memo or "Top up Collaborator's wallet").strip()[:200]
    payment_hash, bolt11 = provider.create_invoice(sats, memo)
    return {"amount_sats": sats, "invoice": bolt11,
            "payment_hash": payment_hash, "memo": memo}


def invoice_paid(user_key: str, payment_hash: str):
    """Whether an invoice from `receive` has been paid: True, False, or None
    when the wallet can't be asked right now."""
    provider = provider_for(user_key)
    if provider is None:
        raise WalletError("no wallet is configured for this user (tools.wallet)")
    if not re.fullmatch(r"[0-9a-f]{64}", payment_hash or ""):
        raise WalletError("payment_hash must be 64 hex characters")
    return provider.received(payment_hash)


# --- the model's tool -----------------------------------------------------------


def _balance(db_path: str, provider) -> dict:
    balance = provider.balance_msat()
    conn = sqlite3.connect(db_path)
    try:
        spent = spent_today_msat(conn, provider.name)
    finally:
        conn.close()
    _, cap_day = _caps()
    out = {"balance_sats": balance // 1000, "spent_today_sats": spent // 1000,
           "daily_cap_sats": cap_day // 1000,
           "remaining_today_sats": max(0, cap_day - spent) // 1000}
    low = int(_cfg().get("low_balance_sats", 0) or 0)
    if low and balance // 1000 < low:
        out["low_balance"] = True
        out["note"] = ("the wallet is running low — offer the user a top-up: "
                       "call wallet with action create_invoice")
    return out


def wallet_tool(db_path: str, user_key: str, action: str = "get_balance",
                invoice: str = None, reason: str = None, amount_sats=None,
                memo: str = None) -> dict:
    """get_balance | pay_invoice | create_invoice, as the model calls them."""
    provider = provider_for(user_key)
    if provider is None:
        return {"error": "no wallet is configured for this user (tools.wallet)"}
    action = (action or "get_balance").strip()
    try:
        if action == "get_balance":
            return _balance(db_path, provider)
        if action == "create_invoice":
            inv = receive(user_key, amount_sats, memo)
            sats, bolt11 = inv["amount_sats"], inv["invoice"]
            return {"status": "invoice_created", "amount_sats": sats,
                    "invoice": bolt11, "payment_hash": inv["payment_hash"],
                    "instruction": (
                        "Show the user this as a markdown link they can tap, "
                        f"[Pay {sats} sats](lightning:{bolt11}), and the invoice "
                        "itself in a code block so it can be copied. Paying it "
                        "moves money INTO Collaborator's wallet from theirs.")}
        if action != "pay_invoice":
            return {"error": f"unknown action {action!r} "
                             "(get_balance | pay_invoice | create_invoice)"}
        if not (invoice or "").strip():
            return {"error": "invoice is required for pay_invoice"}
        res = pay(db_path, user_key, invoice, reason=reason)
    except WalletUnconfirmed as e:
        return {"status": "unconfirmed", "error": str(e),
                "note": "the payment may still settle. Retry pay_invoice with "
                        "this SAME invoice later — it checks the wallet first "
                        "and never pays twice. Do NOT pay a fresh invoice for "
                        "the same purchase."}
    except WalletError as e:
        out = {"error": str(e)}
        if "balance" in str(e).lower():
            out["note"] = ("the wallet may be short of funds — offer the user "
                           "a top-up invoice (action create_invoice)")
        return out
    out = {"status": "paid", "amount_sats": res["amount_msat"] // 1000,
           "fees_msat": res.get("fees_msat"), "preimage": res.get("preimage")}
    if res.get("recovered"):
        out["recovered"] = True
        out["note"] = ("this payment had already settled after the earlier "
                       "unconfirmed attempt — recovered, NOT paid twice")
    if res.get("already_paid"):
        out["already_paid"] = True
        out["note"] = "this invoice was already paid — nothing was paid again"
    conn = sqlite3.connect(db_path)
    try:
        out["spent_today_sats"] = spent_today_msat(
            conn, provider_for(user_key).name) // 1000
    finally:
        conn.close()
    out["daily_cap_sats"] = _caps()[1] // 1000
    return out
