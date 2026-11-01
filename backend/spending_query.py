"""The chat model's read-only view of spending: resolve names, then query
by ID. SQL does every sum; the model never does the math.

Spec (Conversational queries): what the user said (voice mangles names:
"Safway") never goes straight into a WHERE clause. `lookup` fuzzy-matches it
against stores, categories, tags, brands, products and the cards seen, returning real entries with IDs and an `ambiguous` flag that means
"ask which one". `query` filters by those IDs and groups by any dimension.

Disclosure is the tool's job, not the model's wording: the `summary` it
returns already says when unsure or unlabelled lines, or receipts still
awaiting approval, touch the answer.
"""

import difflib
from typing import Dict, List, Optional

import spending

GROUPS = ("none", "store", "category", "tag", "brand", "product", "payment", "card",
          "month", "week", "day")
PERIODS = ("this_week", "last_week", "this_month", "last_month", "this_year",
           "last_year", "all")
_LINE_GROUPS = ("category", "tag", "brand", "product")

_PERIOD_SQL = {
    "this_week": ("date('now','localtime','-6 days','weekday 1')", None),
    "last_week": ("date('now','localtime','-13 days','weekday 1')",
                  "date('now','localtime','-6 days','weekday 1','-1 day')"),
    "this_month": ("date('now','localtime','start of month')", None),
    "last_month": ("date('now','localtime','start of month','-1 month')",
                   "date('now','localtime','start of month','-1 day')"),
    "this_year": ("date('now','localtime','start of year')", None),
    "last_year": ("date('now','localtime','start of year','-1 year')",
                  "date('now','localtime','start of year','-1 day')"),
}

_DAY = "date(IFNULL(t.datetime, t.created_at))"


def money(cents: int, currency: Optional[str]) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}${abs(cents) / 100:,.2f}" + (f" {currency}" if currency else "")


# --- Resolve --------------------------------------------------------------------


def _score(q: str, name: str) -> float:
    q, name = q.lower().strip(), (name or "").lower().strip()
    if not q or not name:
        return 0.0
    if q == name:
        return 1.0
    if q in name or name in q:
        return 0.9
    words = set(q.split())
    overlap = len(words & set(name.split())) / len(words)
    return max(difflib.SequenceMatcher(None, q, name).ratio(), 0.85 * overlap)


def lookup(db_path: str, query: str, limit: int = 8) -> dict:
    """Real entries resembling `query`: stores, categories, tags, brands,
    products, cards. `ambiguous` when more than one fits about as well."""
    conn = spending.connect(db_path)
    try:
        entries = []
        for r in conn.execute("SELECT id, name, address FROM stores"):
            entries.append({"type": "store", "id": r["id"],
                            "name": r["name"] + (f", {r['address']}" if r["address"] else ""),
                            "_text": r["name"]})
        for r in conn.execute("SELECT id, name FROM categories"):
            entries.append({"type": "category", "id": r["id"], "name": r["name"], "_text": r["name"]})
        for r in conn.execute(
                "SELECT t.id, t.name, GROUP_CONCAT(c.name, ', ') AS cats FROM tags t "
                "LEFT JOIN category_tags ct ON ct.tag_id = t.id "
                "LEFT JOIN categories c ON c.id = ct.category_id GROUP BY t.id"):
            entries.append({"type": "tag", "id": r["id"], "_text": r["name"],
                            "name": r["name"] + (f" (covers {r['cats']})" if r["cats"] else "")})
        for r in conn.execute("SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL"):
            entries.append({"type": "brand", "id": r["brand"], "name": r["brand"], "_text": r["brand"]})
        for r in conn.execute("SELECT p.id, p.name, p.brand FROM products p"):
            label = f"{r['name']} ({r['brand']})" if r["brand"] else r["name"]
            entries.append({"type": "product", "id": r["id"], "name": label,
                            "_text": f"{r['brand'] or ''} {r['name']}".strip()})
        for r in conn.execute("SELECT DISTINCT method, card_brand, last_four FROM payments "
                              "WHERE last_four IS NOT NULL"):
            entries.append({"type": "card", "id": r["last_four"],
                            "name": f"{r['card_brand'] or 'card'} ending {r['last_four']}",
                            "_text": f"{r['card_brand'] or ''} {r['last_four']}"})
    finally:
        conn.close()
    for e in entries:
        e["score"] = round(max(_score(query, e["_text"]), _score(query, e["name"])), 2)
    hits = sorted((e for e in entries if e["score"] >= 0.6), key=lambda e: -e["score"])[:limit]
    for e in hits:
        del e["_text"]
    ambiguous = len(hits) > 1 and hits[0]["score"] - hits[1]["score"] < 0.1
    out = {"matches": hits, "ambiguous": ambiguous}
    if not hits:
        out["note"] = "Nothing in the spending data resembles that; ask the user."
    elif ambiguous:
        out["note"] = ("Several entries fit about equally: ask the user which they "
                       "mean (or, if they meant all of them, pass every id).")
    return out


# --- Query ----------------------------------------------------------------------


def _label_categories(conn, category_ids: List[int], tag_ids: List[int]) -> List[int]:
    """Every category named, or carrying a named tag: one set, so a line
    under several of them is counted once."""
    cats = set(category_ids)
    if tag_ids:
        cats |= {r[0] for r in conn.execute(
            f"SELECT category_id FROM category_tags WHERE tag_id IN ({','.join('?' * len(tag_ids))})",
            tag_ids)}
    return sorted(cats) or [-1]


def _ints(values) -> List[int]:
    out = []
    for v in values or []:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            raise ValueError(f"not an id: {v!r} (use spending_lookup first)")
    return out


def query(db_path: str, *, period: Optional[str] = None, since: Optional[str] = None,
          until: Optional[str] = None, store_ids=None, category_ids=None, tag_ids=None, brands=None,
          product_ids=None, payment_method: Optional[str] = None,
          card_last_four: Optional[str] = None, group_by: str = "none",
          list_items: bool = False) -> dict:
    """Committed spending matching the filters, grouped. Line-level (line
    totals before tax and charges) whenever a category, tag, brand or
    product is involved; receipt totals otherwise. Categories and tags are
    one filter (a line under any of them, counted once); the other filters
    narrow it."""
    group_by = group_by or "none"
    if group_by not in GROUPS:
        raise ValueError(f"group_by must be one of {', '.join(GROUPS)}")
    if period and period not in PERIODS:
        raise ValueError(f"period must be one of {', '.join(PERIODS)}")
    store_ids, category_ids, product_ids = _ints(store_ids), _ints(category_ids), _ints(product_ids)
    tag_ids = _ints(tag_ids)
    brands = [str(b) for b in brands or [] if str(b).strip()]
    labelled = bool(category_ids or tag_ids or brands or product_ids)
    lines = labelled or group_by in _LINE_GROUPS

    conn = spending.connect(db_path)
    try:
        lo, hi = since, until
        if period and period != "all" and not (since or until):
            a, b = _PERIOD_SQL[period]
            lo = conn.execute(f"SELECT {a}").fetchone()[0]
            hi = conn.execute(f"SELECT {b}").fetchone()[0] if b else None

        where, args = ["t.status = 'committed'"], []
        if lo:
            where.append(f"{_DAY} >= ?"); args.append(lo)
        if hi:
            where.append(f"{_DAY} <= ?"); args.append(hi)
        if store_ids:
            where.append(f"t.store_id IN ({','.join('?' * len(store_ids))})"); args += store_ids
        if payment_method:
            where.append("p.method = ?"); args.append(payment_method.lower())
        if card_last_four:
            where.append("p.last_four = ?"); args.append(str(card_last_four)[-4:])
        scope_where, scope_args = list(where), list(args)    # before label filters
        if category_ids or tag_ids:
            cats = _label_categories(conn, category_ids, tag_ids)
            where.append(f"pr.category_id IN ({','.join('?' * len(cats))})"); args += cats
        if brands:
            where.append(f"pr.brand COLLATE NOCASE IN ({','.join('?' * len(brands))})"); args += brands
        if product_ids:
            where.append(f"l.product_id IN ({','.join('?' * len(product_ids))})"); args += product_ids

        key = {
            "none": "'all'", "store": "IFNULL(s.name, '(no store)')",
            "category": "IFNULL(c.name, '(not labelled yet)')",
            "tag": "IFNULL(tg.name, '(no tag)')",
            "brand": "IFNULL(pr.brand, '(no brand)')",
            "product": "IFNULL(pr.name || IFNULL(' (' || pr.brand || ')', ''), '(not labelled yet)')",
            "payment": "IFNULL(p.method, '(unknown)')",
            "card": "IFNULL(IFNULL(p.card_brand, 'card') || ' ending ' || p.last_four, '(no card)')",
            "month": f"strftime('%Y-%m', {_DAY})", "week": f"strftime('%Y-W%W', {_DAY})",
            "day": _DAY,
        }[group_by]
        joins = ("FROM transactions t LEFT JOIN stores s ON s.id = t.store_id "
                 "LEFT JOIN payments p ON p.transaction_id = t.id ")
        if lines:
            joins += ("JOIN line_items l ON l.transaction_id = t.id "
                      "LEFT JOIN products pr ON pr.id = l.product_id "
                      "LEFT JOIN categories c ON c.id = pr.category_id ")
            amount, unit = "l.line_total_cents", "line"
        else:
            amount, unit = "t.amount_cents", "purchase"
        sql_where = " WHERE " + " AND ".join(where)
        # The total, each line once; the groups may count a line in several
        # tags, and say so.
        total_rows = conn.execute(
            f"SELECT t.currency AS cur, SUM({amount}) AS total, COUNT(*) AS n "
            f"{joins}{sql_where} GROUP BY cur ORDER BY total DESC", args).fetchall()
        group_joins, group_where, group_args = joins, sql_where, list(args)
        if group_by == "tag":
            group_joins += ("LEFT JOIN category_tags ct ON ct.category_id = pr.category_id "
                            "LEFT JOIN tags tg ON tg.id = ct.tag_id ")
            if tag_ids:     # only the tags asked about
                group_where += f" AND (tg.id IN ({','.join('?' * len(tag_ids))}))"
                group_args += tag_ids
        rows = conn.execute(
            f"SELECT {key} AS k, t.currency AS cur, SUM({amount}) AS total, COUNT(*) AS n "
            f"{group_joins}{group_where} GROUP BY k, cur ORDER BY total DESC", group_args).fetchall()

        notes = []
        if lines:
            u = conn.execute(f"SELECT COUNT(*), IFNULL(SUM(l.line_total_cents), 0) {joins}"
                             f"{sql_where} AND l.match = 'unsure'", args).fetchone()
            if u[0]:
                notes.append(f"{u[0]} of these lines ({money(u[1], None)}) "
                             f"{'are' if u[0] != 1 else 'is'} labelled but marked unsure")
            if labelled:
                pending_lines = conn.execute(
                    "SELECT COUNT(*) FROM transactions t LEFT JOIN payments p ON p.transaction_id = t.id "
                    "JOIN line_items l ON l.transaction_id = t.id WHERE "
                    + " AND ".join(scope_where) + " AND l.product_id IS NULL", scope_args).fetchone()[0]
                if pending_lines:
                    one = pending_lines == 1
                    notes.append(f"{pending_lines} line{'' if one else 's'} in this range "
                                 f"{'isn' if one else 'aren'}'t labelled yet, so "
                                 f"{'it' if one else 'they'} may be missing from this answer")
        pend_where = [w for w in scope_where if w != "t.status = 'committed'"] + ["t.status = 'pending'"]
        pend = conn.execute(
            "SELECT COUNT(*), IFNULL(SUM(t.amount_cents), 0) FROM transactions t "
            "LEFT JOIN payments p ON p.transaction_id = t.id WHERE " + " AND ".join(pend_where),
            scope_args).fetchone()
        if pend[0]:
            one = pend[0] == 1
            notes.append(f"{pend[0]} receipt{'' if one else 's'} ({money(pend[1], None)}) "
                         f"still await{'s' if one else ''} approval and "
                         f"{'isn' if one else 'aren'}'t counted")

        items = []
        if list_items:
            if lines:
                items = [{"date": r["d"], "store": r["store"], "printed": r["raw_text"],
                          "product": r["product"], "amount": money(r["amt"], r["cur"]),
                          "unsure": r["match"] == "unsure", "transaction_id": r["tid"]}
                         for r in conn.execute(
                             f"SELECT {_DAY} AS d, s.name AS store, l.raw_text, l.match, "
                             "pr.name || IFNULL(' (' || pr.brand || ')', '') AS product, "
                             f"l.line_total_cents AS amt, t.currency AS cur, t.id AS tid {joins}"
                             f"{sql_where} ORDER BY d DESC LIMIT 30", args)]
            else:
                items = [{"date": r["d"], "store": r["store"], "amount": money(r["amt"], r["cur"]),
                          "transaction_id": r["tid"]}
                         for r in conn.execute(
                             f"SELECT {_DAY} AS d, s.name AS store, t.amount_cents AS amt, "
                             f"t.currency AS cur, t.id AS tid {joins}{sql_where} "
                             "ORDER BY d DESC LIMIT 30", args)]
    finally:
        conn.close()

    totals: Dict[Optional[str], List[int]] = {r["cur"]: [r["total"], r["n"]] for r in total_rows}
    if group_by == "tag":
        for cur, (total, _) in totals.items():
            over = sum(r["total"] for r in rows if r["cur"] == cur) - total
            if over > 0:
                notes.append(f"the tag groups overlap: {money(over, None)} is counted in more than "
                             "one tag, so the groups add up to more than the total")
    if totals:
        summary = "; ".join(f"{money(c, cur)} across {n} {unit}{'s' if n != 1 else ''}"
                            for cur, (c, n) in totals.items())
    else:
        summary = "Nothing recorded matches"
    summary += f" ({'from ' + lo if lo else 'all time'}{' to ' + hi if hi else ''})"
    if lines:
        summary += "; line totals before tax and other charges"
    # The caveats travel twice, in the summary and as their own list, so a
    # model relaying the answer has a harder time dropping one.
    if notes:
        summary += ". Note: " + "; ".join(notes)
    out = {"summary": summary + ".", "caveats": notes,
           "must_mention": bool(notes), "range": {"since": lo, "until": hi},
           "basis": "line items" if lines else "receipt totals",
           "groups": [{"key": r["k"], "currency": r["cur"], "total": money(r["total"], r["cur"]),
                       "total_cents": r["total"], "count": r["n"]} for r in rows]
           if group_by != "none" else []}
    if list_items:
        out["items"] = items
    return out
