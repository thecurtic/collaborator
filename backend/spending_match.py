"""Product matching: approved receipt lines get a product (name, brand,
category) in the background, never during review.

Spec (Normalization): matching starts when a receipt is approved, so
unapproved or discarded data is never classified, and it works from the
corrected lines. For each line, in order:

1. Alias: this store has printed this exact text before → that product,
   with a plain lookup and no model.
2. Decision model: retrieval (fuzzy string + embeddings) narrows the
   products to ~10 candidates; the decision model picks one or "not in
   this list", asked twice with the list in two orders. Both answers must
   agree above the threshold.
3. Chat model: anything else. It picks a candidate or writes a new product
   (name, brand, and a category from the list, a new one only when nothing
   fits), and says whether it's sure.

Every match is applied. Unsure ones are marked (`match = 'unsure'`) for the
"check these labels" list; only confident and corrected matches become
aliases, so one bad guess can't repeat on every later receipt. A correction
remaps every line this store printed the same way, and is logged against the
decision that made the label.

Runs as one background thread: woken by an approval (`kick`), and an
hourly sweep (`spending.match_interval_seconds`) picks up whatever is still
unmatched. Labels only in logs, never receipt content.
"""

import difflib
import json
import math
import queue
import threading
from typing import Dict, List, Optional

import spending
from config import get_config

MAX_TRIES = 5          # a line the models keep failing on stops being retried
CANDIDATES = 10

# --- Text keys --------------------------------------------------------------------


def raw_key(text: str) -> str:
    """How a printed line is compared: case and spacing don't count."""
    return " ".join((text or "").upper().split())


def _product_text(p) -> str:
    return " ".join(x for x in (p["brand"], p["name"]) if x)


# --- Retrieval ----------------------------------------------------------------------


def _vectors(conn, products) -> Dict[int, List[float]]:
    """Each product's embedding, cached in product_vectors (refreshed when
    the product's text changes). Empty when embeddings are unavailable."""
    from inference import embed_texts
    have = {r["product_id"]: (r["text"], r["vector"])
            for r in conn.execute("SELECT * FROM product_vectors")}
    out, todo = {}, []
    for p in products:
        text = _product_text(p)
        cached = have.get(p["id"])
        if cached and cached[0] == text:
            out[p["id"]] = json.loads(cached[1])
        else:
            todo.append((p["id"], text))
    if todo:
        for (pid, text), vec in zip(todo, embed_texts([t for _, t in todo])):
            if vec:
                out[pid] = vec
                conn.execute("INSERT OR REPLACE INTO product_vectors (product_id, text, vector) "
                             "VALUES (?, ?, ?)", (pid, text, json.dumps(vec)))
        conn.commit()
    return out


def _cosine(a, b) -> float:
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(x * x for x in b))
    return sum(x * y for x, y in zip(a, b)) / (na * nb) if na and nb else 0.0


def candidates(conn, raw: str, limit: int = CANDIDATES) -> List[dict]:
    """The products most like this printed line, best first."""
    products = conn.execute(
        "SELECT p.id, p.name, p.brand, c.name AS category FROM products p "
        "LEFT JOIN categories c ON c.id = p.category_id").fetchall()
    if not products:
        return []
    key = raw_key(raw)
    words = set(key.split())
    vecs = _vectors(conn, products)
    line_vec = None
    if vecs:
        from inference import get_embedding
        line_vec = get_embedding(raw)
    scored = []
    for p in products:
        text = raw_key(_product_text(p))
        fuzzy = difflib.SequenceMatcher(None, key, text).ratio()
        overlap = len(words & set(text.split())) / max(len(words), 1)
        sem = _cosine(line_vec, vecs[p["id"]]) if line_vec and p["id"] in vecs else 0.0
        scored.append((max(fuzzy, overlap, sem), p))
    scored.sort(key=lambda x: -x[0])
    return [{"id": p["id"], "name": p["name"], "brand": p["brand"],
             "category": p["category"]} for _, p in scored[:limit]]


def _describe(c: dict) -> str:
    extra = ", ".join(x for x in (c["brand"] and f"brand {c['brand']}", c["category"]) if x)
    return f"{c['name']} ({extra})" if extra else c["name"]


# --- The decision model ----------------------------------------------------------


def decide(db_path: str, line_id: int, store: Optional[str], raw: str,
           cands: List[dict]) -> Optional[int]:
    """A product id when the decision model picks the same candidate, above
    the threshold, with the list in both orders; else None."""
    import decision
    who = decision.model()
    if not who or not cands:
        return None
    text = (f"Store: {store}\n" if store else "") + f"Receipt line: {raw}"
    picks = []
    for order in (cands, cands[::-1]):
        options = {f"p{c['id']}": _describe(c) for c in order}
        options["new"] = "A product not in this list"
        try:
            a = decision.ask([decision.choice("m", "Which product is this receipt line?",
                                              options)], text=text)["m"]
        except decision.DecisionError as e:
            print(f"Warning: spending match: decision model unavailable ({e})")
            return None
        picks.append(a)
    agree = picks[0]["choice"] == picks[1]["choice"]
    p = min(a["probability"] for a in picks)
    used = (agree and p >= decision.threshold("match")
            and picks[0]["choice"] not in (None, "new"))
    spending.log_decision(db_path, "match", who, f"line:{line_id}", picks[0]["choice"],
                          p, picks[0]["probabilities"], used)
    return int(picks[0]["choice"][1:]) if used else None


# --- The chat model ----------------------------------------------------------------

MATCH_PROMPT = (
    "You label one line printed on a store receipt with the product it is.\n"
    "Known products (id: description) that might be it:\n{candidates}\n\n"
    "Categories in use: {categories}\n\n"
    "If the line is one of the known products, give its product_id and leave "
    "name, brand and category null. Otherwise give product_id null and write "
    "the product: a short canonical name (what it is, e.g. \"coffee beans\", "
    "not the printed abbreviation), its brand if the line shows one (null for "
    "none or a store's own unbranded item), and its category: one from the "
    "list when any fits, a new short lowercase category only when none does. "
    "sure is false when the printed text leaves real doubt about what it is. "
    'Reply with JSON only: {{"product_id": <id or null>, "name": <string or null>, '
    '"brand": <string or null>, "category": <string or null>, "sure": true|false}}.'
)

def ask_chat(store: Optional[str], raw: str, cands: List[dict], categories: List[str]) -> dict:
    """The chat model's label. Raises RuntimeError when it can't answer."""
    from inference import _get_model_id
    prompt = MATCH_PROMPT.format(
        candidates="\n".join(f"{c['id']}: {_describe(c)}" for c in cands) or "(none yet)",
        categories=", ".join(categories) or "(none yet)")
    messages = [{"role": "system", "content": prompt},
                {"role": "user", "content": (f"Store: {store}\n" if store else "")
                                            + f"Line: {raw}"}]
    # A plain JSON reply, not structured output: on LM Studio's MLX engine a
    # json_schema request skips the model's thinking and returns its JSON in
    # the reasoning field, so it reads as empty (and labels worse).
    reply = spending._complete(messages, None)
    data = spending._parse_json(reply)
    if not isinstance(data, dict):
        raise RuntimeError("the chat model's label wasn't JSON")
    data["_model"] = _get_model_id()
    return data


# --- Writing -----------------------------------------------------------------------


def category_id(conn, name: str) -> int:
    """An existing category by name (any case), else a new top-level one."""
    name = " ".join((name or "").lower().split())[:60] or "other"
    r = conn.execute("SELECT id FROM categories WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
    if r:
        return r["id"]
    return conn.execute("INSERT INTO categories (name) VALUES (?)", (name,)).lastrowid


def new_product(conn, name: str, brand: Optional[str], category: Optional[str]) -> int:
    """A product by name and brand (reused when one exists), in `category`."""
    name = (spending._text(name, 120) or "unknown item").strip()
    brand = spending._text(brand, 80)
    r = conn.execute("SELECT id FROM products WHERE name = ? COLLATE NOCASE AND "
                     "IFNULL(brand, '') = IFNULL(?, '') COLLATE NOCASE",
                     (name, brand)).fetchone()
    if r:
        return r["id"]
    return conn.execute("INSERT INTO products (name, brand, category_id) VALUES (?, ?, ?)",
                        (name, brand, category_id(conn, category))).lastrowid


def _set(conn, line_id: int, product_id: int, how: str) -> None:
    conn.execute("UPDATE line_items SET product_id = ?, match = ?, matched_at = datetime('now') "
                 "WHERE id = ?", (product_id, how, line_id))


def _alias(conn, store_id: Optional[int], raw: str, product_id: int, source: str) -> None:
    if store_id is None:
        return
    conn.execute("INSERT INTO aliases (store_id, raw_text, product_id, source) VALUES (?, ?, ?, ?) "
                 "ON CONFLICT (store_id, raw_text) DO UPDATE SET product_id = excluded.product_id, "
                 "source = excluded.source", (store_id, raw_key(raw), product_id, source))


# --- One line, one pass ----------------------------------------------------------


def match_line(db_path: str, line_id: int) -> Optional[str]:
    """Label one approved line. Returns how ('alias', 'model', 'chat',
    'unsure'), or None when no model could answer (the sweep retries)."""
    conn = spending.connect(db_path)
    try:
        line = conn.execute(
            "SELECT l.id, l.raw_text, l.match, t.store_id, s.name AS store FROM line_items l "
            "JOIN transactions t ON t.id = l.transaction_id LEFT JOIN stores s ON s.id = t.store_id "
            "WHERE l.id = ? AND t.status = 'committed'", (line_id,)).fetchone()
        if not line or line["match"]:
            return None
        raw, store_id = line["raw_text"], line["store_id"]
        alias = conn.execute("SELECT product_id FROM aliases WHERE store_id = ? AND raw_text = ?",
                             (store_id, raw_key(raw))).fetchone() if store_id is not None else None
        if alias:
            _set(conn, line_id, alias["product_id"], "alias")
            conn.commit()
            return "alias"
        cands = candidates(conn, raw)
        categories = [r["name"] for r in conn.execute("SELECT name FROM categories ORDER BY name")]
    finally:
        conn.close()

    picked = decide(db_path, line_id, line["store"], raw, cands)
    conn = spending.connect(db_path)
    try:
        if picked is not None:
            _set(conn, line_id, picked, "model")
            _alias(conn, store_id, raw, picked, "model")
            conn.commit()
            return "model"
    finally:
        conn.close()

    try:
        data = ask_chat(line["store"], raw, cands, categories)
    except (RuntimeError, ValueError) as e:
        print(f"Warning: spending match: chat model couldn't label a line ({e})")
        conn = spending.connect(db_path)
        try:
            conn.execute("UPDATE line_items SET match_tries = match_tries + 1 WHERE id = ?",
                         (line_id,))
            conn.commit()
        finally:
            conn.close()
        return None
    conn = spending.connect(db_path)
    try:
        known = {c["id"] for c in cands}
        pid = data.get("product_id")
        if not (isinstance(pid, int) and pid in known):
            pid = new_product(conn, data.get("name") or raw, data.get("brand"), data.get("category"))
        sure = bool(data.get("sure"))
        how = "chat" if sure else "unsure"
        _set(conn, line_id, pid, how)
        if sure:
            _alias(conn, store_id, raw, pid, "model")
        conn.commit()
    finally:
        conn.close()
    spending.log_decision(db_path, "match", data["_model"], f"line:{line_id}",
                          str(pid), None, None, True)
    return how


def unmatched_lines(db_path: str, limit: int = 200) -> List[int]:
    conn = spending.connect(db_path)
    try:
        return [r["id"] for r in conn.execute(
            "SELECT l.id FROM line_items l JOIN transactions t ON t.id = l.transaction_id "
            "WHERE t.status = 'committed' AND l.match IS NULL AND l.match_tries < ? "
            "ORDER BY l.id LIMIT ?", (MAX_TRIES, limit))]
    finally:
        conn.close()


def run_once(db_path: str) -> Dict[str, int]:
    """Match every approved line still unmatched in one user's spending.db."""
    stats: Dict[str, int] = {}
    for line_id in unmatched_lines(db_path):
        how = match_line(db_path, line_id) or "failed"
        stats[how] = stats.get(how, 0) + 1
        if how == "failed":
            break           # the models are down: the next sweep tries again
    return stats


# --- Corrections -------------------------------------------------------------------


def correct(db_path: str, line_id: int, product_id: Optional[int] = None,
            new: Optional[dict] = None) -> Optional[dict]:
    """The user's label for a line: an existing product, or a new one
    ({name, brand, category}). It becomes this store's alias for the
    printed text, every line printed the same way follows, and the decision
    that labelled it is marked corrected. None when there's no such line."""
    conn = spending.connect(db_path)
    try:
        line = conn.execute(
            "SELECT l.id, l.raw_text, l.product_id, t.store_id FROM line_items l "
            "JOIN transactions t ON t.id = l.transaction_id "
            "WHERE l.id = ? AND t.status = 'committed'", (line_id,)).fetchone()
        if not line:
            return None
        if product_id is not None:
            if not conn.execute("SELECT 1 FROM products WHERE id = ?", (product_id,)).fetchone():
                raise ValueError("no such product")
            pid = product_id
        elif new and (new.get("name") or "").strip():
            pid = new_product(conn, new["name"], new.get("brand"), new.get("category"))
        else:
            raise ValueError("a product or a new product's name is needed")
        same = [line_id]
        if line["store_id"] is not None:
            key = raw_key(line["raw_text"])
            same = [r["id"] for r in conn.execute(
                "SELECT l.id, l.raw_text FROM line_items l JOIN transactions t "
                "ON t.id = l.transaction_id WHERE t.status = 'committed' AND t.store_id = ?",
                (line["store_id"],)) if raw_key(r["raw_text"]) == key] or [line_id]
            _alias(conn, line["store_id"], line["raw_text"], pid, "user")
        for lid in same:
            _set(conn, lid, pid, "user")
            last = conn.execute("SELECT id FROM decision_log WHERE subject = ? AND task = 'match' "
                                "ORDER BY id DESC LIMIT 1", (f"line:{lid}",)).fetchone()
            if last:
                conn.execute("UPDATE decision_log SET corrected_to = ? WHERE id = ?",
                             (str(pid), last["id"]))
        conn.commit()
    finally:
        conn.close()
    return {"product_id": pid, "lines": same}


def unsure_lines(db_path: str, limit: int = 100) -> List[dict]:
    """Labels worth a second look, newest first (the "check these labels"
    list; clearing it is optional)."""
    conn = spending.connect(db_path)
    try:
        return [dict(r) for r in conn.execute(
            "SELECT l.id, l.raw_text, l.line_total_cents, l.transaction_id, t.datetime, "
            "s.name AS store, p.id AS product_id, p.name AS product, p.brand, c.name AS category "
            "FROM line_items l JOIN transactions t ON t.id = l.transaction_id "
            "LEFT JOIN stores s ON s.id = t.store_id LEFT JOIN products p ON p.id = l.product_id "
            "LEFT JOIN categories c ON c.id = p.category_id "
            "WHERE t.status = 'committed' AND l.match = 'unsure' "
            "ORDER BY t.datetime DESC, l.position LIMIT ?", (limit,))]
    finally:
        conn.close()


def search_products(db_path: str, q: str = "", limit: int = 20) -> List[dict]:
    """Products for the correction picker: name, brand or category matching."""
    conn = spending.connect(db_path)
    try:
        like = f"%{q.strip()}%"
        return [dict(r) for r in conn.execute(
            "SELECT p.id, p.name, p.brand, c.name AS category FROM products p "
            "LEFT JOIN categories c ON c.id = p.category_id "
            "WHERE p.name LIKE ? OR IFNULL(p.brand, '') LIKE ? OR IFNULL(c.name, '') LIKE ? "
            "ORDER BY p.name LIMIT ?", (like, like, like, limit))]
    finally:
        conn.close()


# --- The background job ------------------------------------------------------------

_kicks: "queue.Queue[Optional[str]]" = queue.Queue()
_thread: Optional[threading.Thread] = None


def kick(db_path: str) -> None:
    """Match this user's new approvals soon (no-op when the job isn't running)."""
    if _thread and _thread.is_alive():
        _kicks.put(db_path)


def _sweep() -> None:
    from summaries import conversation_dbs
    import os
    for path in conversation_dbs():
        if os.path.exists(spending.db_path_for(path)):
            _run_logged(path)


def _run_logged(db_path: str) -> None:
    try:
        stats = run_once(db_path)
        if stats:
            import live
            live.publish(db_path, ["spending"])
            print("Spending match: " + ", ".join(f"{n} {k}" for k, n in sorted(stats.items())))
    except Exception as e:
        print(f"Warning: spending match pass failed: {e}")


def start(first_delay: float = 60.0) -> bool:
    """Start the job (once per process). False when spending is disabled."""
    global _thread
    if not spending.enabled() or (_thread and _thread.is_alive()):
        return False

    def loop():
        delay = first_delay
        while True:
            try:
                path = _kicks.get(timeout=delay)
            except queue.Empty:
                _sweep()
                delay = float(spending._cfg().get("match_interval_seconds", 3600))
                continue
            if path is None:
                return
            _run_logged(path)

    _thread = threading.Thread(target=loop, name="spending-match", daemon=True)
    _thread.start()
    return True


def stop() -> None:
    _kicks.put(None)
