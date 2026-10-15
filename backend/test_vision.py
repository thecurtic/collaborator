"""vision.py: one vision path — the chat model when it reads images, the
legacy screenshot model only while it can't. No network: LM Studio's model
list and the chat endpoint are stubbed."""

import base64
import io
import os
import tempfile

os.environ["AUTH_ENABLED"] = "false"
os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(), "conversations.db"))
import config
config.get_config._config = config.load_config()
import inference
import vision


def _setup(monkeypatch, setting="auto", types=None, legacy=None):
    cfg = config.get_config()
    monkeypatch.setitem(cfg["inference"], "model_id", "qwen/qwen3.6-35b")
    monkeypatch.setitem(cfg["inference"], "vision", setting)
    monkeypatch.setitem(cfg["tools"], "screenshot",
                        {**cfg["tools"].get("screenshot", {}), "vision_model": legacy})
    monkeypatch.setattr(inference, "get_models_detail", lambda: [
        {"id": mid, "type": t} for mid, t in (types or {}).items()])
    vision._vlm_cache.clear()


def test_auto_asks_lmstudio(monkeypatch):
    _setup(monkeypatch, types={"qwen3.6-35b": "vlm"})
    assert vision.chat_model_sees() and vision.model() == "qwen/qwen3.6-35b"
    _setup(monkeypatch, types={"qwen/qwen3.6-35b": "llm"})
    assert not vision.chat_model_sees() and vision.model() is None
    _setup(monkeypatch, types={})                       # server doesn't say
    assert vision.model() is None
    print("✓ auto: LM Studio's vlm/llm type decides; unknown counts as no")


def test_explicit_setting_and_legacy_fallback(monkeypatch):
    _setup(monkeypatch, setting=True, types={"qwen/qwen3.6-35b": "llm"},
           legacy="llava")
    assert vision.model() == "qwen/qwen3.6-35b"        # chat model wins
    _setup(monkeypatch, setting=False, legacy="llava")
    assert vision.model() == "llava"                   # only while it can't see
    st = vision.status()
    assert st["legacy_fallback"] and st["chat_model_sees"] is False
    print("✓ inference.vision overrides; the legacy model only fills a gap")


def test_look_sends_image_parts(monkeypatch):
    _setup(monkeypatch, setting=True)
    seen = {}

    class R:
        def raise_for_status(self): pass
        def json(self):
            return {"choices": [{"message": {"content": "<think>hm</think>PELICAN 47"}}]}

    def fake_post(url, json=None, timeout=None, **k):
        seen.update(url=url, body=json)
        return R()
    monkeypatch.setattr(vision.requests, "post", fake_post)
    out = vision.self_test()
    assert out["ok"] is True and out["answer"] == "PELICAN 47"
    parts = seen["body"]["messages"][0]["content"]
    assert parts[0]["image_url"]["url"].startswith("data:image/png;base64,")
    assert seen["body"]["model"] == "qwen/qwen3.6-35b"
    print("✓ look(): image parts to the chat model; self-test reads the card")


def test_no_vision_is_a_readable_error(monkeypatch):
    _setup(monkeypatch, setting=False)
    out = vision.self_test()
    assert out["ok"] is False and "text-only" in out["error"]
    print("✓ no vision: a plain reason, no request made")


def test_prepare_image_downscales(monkeypatch):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (4000, 1000), "red").save(buf, format="PNG")
    mime, b64 = vision.prepare_image(buf.getvalue(), "image/png", max_side=1600)
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    assert mime == "image/jpeg" and img.size == (1600, 400)
    print("✓ images are downscaled before they reach the model")


def test_build_messages_puts_images_on_the_current_turn(monkeypatch):
    _setup(monkeypatch, setting=True)
    msgs = inference._build_messages(
        "what is this?", [{"role": "user", "content": "earlier"},
                          {"role": "assistant", "content": "reply"}],
        images=[("image/jpeg", "QUJD")])
    last = msgs[-1]
    assert last["role"] == "user" and last["content"][0] == {
        "type": "text", "text": "what is this?"}
    assert last["content"][1]["image_url"]["url"] == "data:image/jpeg;base64,QUJD"
    assert all(isinstance(m["content"], str) for m in msgs[:-1])   # history is text
    assert inference._build_messages("plain")[-1]["content"] == "plain"
    print("✓ images ride on the current user message only")
