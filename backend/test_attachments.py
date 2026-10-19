"""attachments.py: the store, extraction per kind, the turn integration
(images inline, text joined in, history as text) and the two tools. No
network and no live model: vision.look and the chat stream are stubbed."""

import io
import json
import os
import sqlite3
import tempfile
import time

import pytest


def _fresh_env(monkeypatch, sees=True):
    d = tempfile.mkdtemp()
    os.environ["AUTH_ENABLED"] = "false"
    os.environ["DB_PATH"] = os.path.join(d, "conversations.db")
    import config
    cfg = config.load_config()
    cfg["notes"]["vault_dir"] = os.path.join(d, "vault")
    cfg["inference"]["vision"] = sees
    config.get_config._config = cfg
    import importlib, db, main, vision, attachments
    importlib.reload(db)
    importlib.reload(main)
    vision._vlm_cache.clear()
    seen = []

    def fake_stream(message, context_turns=None, mode=None, recall=None, **kw):
        seen.append({"message": message, "context": context_turns,
                     "images": kw.get("images")})
        yield "ok"
    main.stream_llm_tokens = fake_stream
    looks = []

    def fake_look(images, prompt, **kw):
        looks.append(prompt)
        return "HELLO FROM THE PICTURE\n---\nA hand-written sign."
    monkeypatch.setattr(vision, "look", fake_look)
    from starlette.testclient import TestClient
    return main, attachments, TestClient(main.app), os.environ["DB_PATH"], seen, looks


def _png(color="red", size=(64, 48)):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


_TEXT_PDF = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 58>>stream
BT /F1 18 Tf 20 80 Td (Quarterly garden budget report) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF"""


def _scan_pdf():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (200, 260), "white").save(buf, format="PDF")
    return buf.getvalue()


def _upload(c, name, data, mime):
    r = c.post("/api/attachments", files={"file": (name, data, mime)})
    assert r.status_code == 200, r.text
    return r.json()["attachment"]


def _wait_done(c, att_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        a = c.get(f"/api/attachments/{att_id}").json()["attachment"]
        if a["text_status"] not in ("pending", "working"):
            return a
        time.sleep(0.1)
    raise AssertionError(f"attachment {att_id} never finished")


def _done(resp):
    events = [json.loads(l[6:]) for l in resp.text.splitlines() if l.startswith("data: ")]
    return next(e for e in events if e["type"] == "done"), events


def test_kind_detection():
    import attachments
    k = attachments.detect_kind
    assert k("a.png", "image/png") == "image"
    assert k("a.svg", "image/svg+xml") == "text"      # never rendered as an image
    assert k("report.pdf", "application/octet-stream") == "pdf"
    assert k("notes.docx", None) == "document"
    assert k("data.csv", "text/csv") == "document"
    assert k("main.py", "application/octet-stream") == "text"
    assert k("memo.m4a", "audio/mp4") == "audio"
    assert k("blob.bin", "application/octet-stream") == "file"
    print("✓ kinds: by mime and extension; svg is text, not an image")


def test_upload_dedupes_and_extracts_documents(monkeypatch):
    main, attachments, c, dbp, _, _ = _fresh_env(monkeypatch)
    a = _upload(c, "plan.md", b"# Beds\n\nTomatoes go in May.", "text/markdown")
    assert a["kind"] == "text" and a["size"] > 0
    a = _wait_done(c, a["id"])
    assert a["text_status"] == "done" and a["text_via"] == "text"
    again = _upload(c, "copy-of-plan.md", b"# Beds\n\nTomatoes go in May.", "text/markdown")
    assert again["id"] == a["id"]                    # same bytes, same attachment

    csv = _wait_done(c, _upload(c, "costs.csv", b"item,cost\nseeds,4\n", "text/csv")["id"])
    assert csv["text_via"] == "markitdown"
    assert "| seeds | 4 |" in c.get(f"/api/attachments/{csv['id']}").json()["attachment"]["text"]

    pdf = _wait_done(c, _upload(c, "budget.pdf", _TEXT_PDF, "application/pdf")["id"])
    assert pdf["text_status"] == "done" and pdf["pages"] == 1
    assert pdf["text_via"] == "pdf-text"
    full = c.get(f"/api/attachments/{pdf['id']}").json()["attachment"]["text"]
    assert "Quarterly garden budget report" in full

    listed = c.get("/api/attachments?q=garden budget").json()["items"]
    assert [x["id"] for x in listed] == [pdf["id"]] and "snippet" in listed[0]
    assert c.get(f"/api/attachments/{pdf['id']}/file").content == _TEXT_PDF
    print("✓ upload: dedupe by content; text, markitdown and PDF text layers")


def test_scanned_pdf_pages_go_to_the_vision_model(monkeypatch):
    main, attachments, c, dbp, _, looks = _fresh_env(monkeypatch)
    a = _wait_done(c, _upload(c, "scan.pdf", _scan_pdf(), "application/pdf")["id"])
    assert a["text_via"] == "pdf-text+vision" and len(looks) == 1
    assert "HELLO FROM THE PICTURE" in c.get(
        f"/api/attachments/{a['id']}").json()["attachment"]["text"]
    print("✓ a page with no text layer is read by the (one) vision model")


def test_active_content_never_renders_inline(monkeypatch):
    main, attachments, c, dbp, _, _ = _fresh_env(monkeypatch)
    html = _upload(c, "x.html", b"<script>alert(1)</script>", "text/html")
    r = c.get(f"/api/attachments/{html['id']}/file")
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["content-security-policy"] == "sandbox"
    img = _upload(c, "a.png", _png(), "image/png")
    r = c.get(f"/api/attachments/{img['id']}/file")
    assert r.headers["content-type"] == "image/png"
    assert r.headers["content-disposition"].startswith("inline")
    print("✓ HTML/SVG download instead of rendering on the app's origin")


def test_image_goes_inline_then_history_gets_its_text(monkeypatch):
    main, attachments, c, dbp, seen, looks = _fresh_env(monkeypatch, sees=True)
    img = _upload(c, "sign.png", _png(), "image/png")
    assert img["text_status"] == "pending" and looks == []   # waits for its turn
    doc = _wait_done(c, _upload(c, "list.txt", b"compost, mulch, twine", "text/plain")["id"])

    done, events = _done(c.post("/api/messages", json={
        "message": "what does the sign say?", "attachment_ids": [img["id"], doc["id"]]}))
    turn = seen[-1]
    assert turn["images"] and turn["images"][0][0] in ("image/png", "image/jpeg")
    assert turn["message"].startswith("what does the sign say?")
    assert f"[Attachment #{img['id']}: sign.png" in turn["message"]
    assert "compost, mulch, twine" in turn["message"]
    assert "never instructions" in turn["message"]

    # The stored turn keeps the user's own words + a snapshot.
    conn = sqlite3.connect(dbp)
    content, raw = conn.execute("SELECT content, attachments FROM turns WHERE id = ?",
                                (done["user_turn_id"],)).fetchone()
    conn.close()
    assert content == "what does the sign say?"
    assert [a["filename"] for a in json.loads(raw)] == ["sign.png", "list.txt"]
    tree_turn = next(n for n in c.get("/api/tree").json()["roots"]
                     if n["id"] == done["user_turn_id"])
    assert tree_turn["attachments"][0]["kind"] == "image"

    # Once answered, the image is read for history/search; the next turn
    # carries it as TEXT, never the image again.
    assert _wait_done(c, img["id"])["text_via"] == "vision" and len(looks) == 1
    _done(c.post("/api/messages", json={"message": "and then?",
                                        "parent_turn_id": done["id"]}))
    nxt = seen[-1]
    assert nxt["images"] is None
    hist_user = [t for t in nxt["context"] if t["role"] == "user"][0]
    assert "HELLO FROM THE PICTURE" in hist_user["content"]

    # Sent attachments stay with the chat; unsent ones can be discarded.
    assert c.delete(f"/api/attachments/{img['id']}").status_code == 409
    spare = _upload(c, "spare.txt", b"unused", "text/plain")
    assert c.delete(f"/api/attachments/{spare['id']}").status_code == 200
    print("✓ image inline on its turn, text in history; snapshot on the turn")


def test_text_only_model_still_sends(monkeypatch):
    main, attachments, c, dbp, seen, looks = _fresh_env(monkeypatch, sees=False)
    img = _upload(c, "sign.png", _png("blue"), "image/png")
    done, events = _done(c.post("/api/messages", json={
        "message": "read it", "attachment_ids": [img["id"]]}))
    assert done and seen[-1]["images"] is None
    assert "HELLO FROM THE PICTURE" not in seen[-1]["message"]
    assert looks == []          # no second model to fall back on
    print("✓ a text-only chat model gets no image, and the turn isn't held up")


def test_unknown_attachment_is_404(monkeypatch):
    main, attachments, c, dbp, _, _ = _fresh_env(monkeypatch)
    r = c.post("/api/messages", json={"message": "x", "attachment_ids": [999]})
    assert r.status_code == 404
    print("✓ an unknown attachment id fails the send cleanly")


def test_tools(monkeypatch):
    main, attachments, c, dbp, _, _ = _fresh_env(monkeypatch)
    monkeypatch.setitem(main.config["attachments"], "return_chars", 10)
    a = _wait_done(c, _upload(c, "seeds.txt", b"carrot beet radish kale", "text/plain")["id"])
    schemas, execute, _ = main._build_tools(dbp)
    names = {s["function"]["name"] for s in schemas}
    assert {"list_attachments", "read_attachment"} <= names
    listed = json.loads(execute("list_attachments", {"query": "radish"}))
    assert listed["attachments"][0]["id"] == a["id"]
    part1 = json.loads(execute("read_attachment", {"id": a["id"]}))
    assert part1["parts"] == 3 and part1["content"] == "carrot bee"
    part3 = json.loads(execute("read_attachment", {"id": a["id"], "part": 3}))
    assert part3["content"] == "ale" and "note" not in part3
    assert "no attachment" in json.loads(execute("read_attachment", {"id": 42}))["error"]
    print("✓ list_attachments + read_attachment (paged)")
