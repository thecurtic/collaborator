"""LLM inference proxy for Collaborator backend.

Wraps local LLM endpoint calls with retry logic, error handling,
and context-aware messaging. Supports both streaming and non-streaming modes.
"""

import os
import time
import requests
from typing import List, Dict, Optional, AsyncGenerator, Tuple
from functools import lru_cache

from config import get_config, resolve_path


def _get_config():
    """Get configuration (get_config() itself caches; never cache a second copy
    here — a stale duplicate would desync inference from live config updates
    like PUT /api/model)."""
    return get_config()


def _get_endpoint_url() -> str:
    """Get LLM endpoint URL from config."""
    return _get_config()["inference"]["endpoint_url"]


def _get_model_id() -> str:
    """Get model ID from config."""
    return _get_config()["inference"]["model_id"]


def _get_utility_model() -> str:
    """Model for UTILITY calls — ephemeral background output (titles, recall
    and tool synthesis). inference.utility_model when set, else the chat
    model. One role by design; vault-authoring calls never use this (see the
    boundary rule in config.py)."""
    return _get_config()["inference"].get("utility_model") or _get_model_id()


def _get_temperature() -> float:
    """Get temperature from config."""
    return _get_config()["inference"]["temperature"]


def _get_max_tokens() -> int:
    """Get max tokens from config."""
    return _get_config()["inference"]["max_tokens"]


class StreamingResponse:
    """Container for streaming response data."""
    def __init__(self, text: str = "", metadata: Dict = None):
        self.text = text
        self.metadata = metadata or {}


# Appended to every system prompt with {now} filled in, so the model is grounded
# in the present instead of its training cutoff (it will otherwise insist on stale
# facts — who holds an office, what year it is — and argue with the user).
DEFAULT_DATETIME_TEXT = (
    "Current date and time: {now}. Your training data predates this moment — treat "
    "this timestamp as ground truth and never dispute the user about the current "
    "date or who currently holds a position. For time-sensitive or recent facts, "
    "verify with your tools (web search) instead of relying on memory."
)


# Appended to every system prompt so distinct ideas land in separate paragraphs.
# This makes paragraph-level branching meaningful (each paragraph is a fork point).
DEFAULT_PARAGRAPH_STYLE = (
    "Structure every response as a sequence of discrete blocks separated by a blank "
    "line. Each block must contain exactly one distinct idea, point, step, or item — "
    "never more than one point per block. For lists especially: do not write bullet "
    "or numbered items one-per-line inside a single block; write each point as its "
    "own blank-line-separated block (with or without a list marker). Keep "
    "tightly-coupled content (a heading with its line, a fenced code block) together. "
    "Prefer more, smaller blocks — each is independently referenceable and branchable."
)


# Appended to the system prompt only when tools are active, so the model knows it
# must retrieve via tools rather than claim it lacks access to history.
DEFAULT_TOOLS_GUIDANCE = (
    "You have tools to search the user's past conversations and synthesize what you "
    "find:\n"
    "- recall_semantic / recall_keyword: retrieve relevant earlier turns (by meaning "
    "or by exact keyword).\n"
    "- synthesize: turn retrieved snippets into a concise first-person memory block.\n\n"
    "When the user refers to earlier discussion, past decisions, or asks what was said "
    "or decided before, FIRST call a recall tool to retrieve it (then optionally "
    "synthesize) before answering. Do not claim you lack access to history — use the "
    "tools. Pick the retrieval method that fits, and if a search returns nothing "
    "relevant, say so plainly."
)


# Appended to the system prompt for call-mode (spoken) turns. The reply is read
# aloud by TTS, so markdown/symbols read badly and should be avoided.
DEFAULT_VOICE_STYLE = (
    "You are in voice mode: the user is speaking to you and your reply will be "
    "read aloud by text-to-speech. Respond in plain, natural spoken prose. Do not "
    "use markdown, headings, bullet points, numbered lists, tables, code blocks, "
    "emoji, or symbols such as *, #, _, >, or |. Keep sentences short and easy to "
    "follow when heard. Spell out anything that would be ambiguous aloud."
)


def _extract_message_text(data: Dict, context: str = "llm call") -> str:
    """Final text from a non-streaming chat completion, reasoning-model aware.

    Reasoning models (MiniMax, qwen3-thinking) put their chain of thought in
    message.reasoning_content and the answer in message.content. When
    max_tokens is too small the whole budget goes to reasoning and content
    comes back EMPTY — the silent killer of small-budget calls like titles.
    We use content only (never leak reasoning as output), strip any inline
    <think> block, and log loudly when reasoning ate the budget so the
    failure is visible in read_logs instead of silent."""
    import re as _re
    try:
        msg = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return ""
    content = (msg.get("content") or "").strip()
    if content:
        return _re.sub(r"^\s*<think>.*?</think>\s*", "", content, flags=_re.S).strip()
    if (msg.get("reasoning_content") or "").strip():
        print(f"Warning: {context}: model spent its whole token budget on "
              "reasoning and returned no answer — raise this call's max_tokens "
              "(reasoning models need headroom beyond the answer length)")
    return ""


def resolve_prompt_layer(cfg: Dict, file_key: str, text_key: str, default: str):
    """Resolve a prompt layer and report its provenance.

    Returns (content, source, file_path) with source in {"file", "config",
    "default"}. Precedence: markdown file -> inline config string -> built-in
    default. Read fresh each call so file edits apply without a restart (the base
    system prompt is the exception — config caches it at startup).
    """
    file_path = cfg.get(file_key)
    if file_path:
        try:
            with open(resolve_path(file_path), "r", encoding="utf-8") as f:
                text = f.read().strip()
                if text:
                    return text, "file", file_path
        except IOError:
            pass
    if cfg.get(text_key):
        return cfg[text_key], "config", None
    return default, "default", None


def _load_prompt_layer(cfg: Dict, file_key: str, text_key: str, default: str) -> str:
    return resolve_prompt_layer(cfg, file_key, text_key, default)[0]


def _build_messages(
    message: str,
    context_turns: Optional[List[Dict]] = None,
    mode: Optional[str] = None,
    recall: Optional[str] = None,
    include_tools_guidance: bool = False,
    extra_system: Optional[str] = None,
) -> List[Dict]:
    """Build the OpenAI-style messages array from system prompt, context, and input.

    Context assembly order: system prompt, recall block (if any), recent window,
    current message. The system prompt is layered: the base prompt + an auditable
    paragraph-style layer (always), + a voice-style layer (mode == "voice"). Each
    layer is a markdown file (system_prompt.paragraph_file / voice_file), falling
    back to an inline config string then a built-in default.
    """
    config = _get_config()
    system_prompt = config.get("system_prompt", {})
    system_content = system_prompt.get("text", "You are Collaborator, a helpful assistant.")

    # Tell the model how to use its tools (only when tools are active this turn).
    if include_tools_guidance:
        tools_cfg = config.get("tools", {}) or {}
        guidance = _load_prompt_layer(
            tools_cfg, "guidance_file", "guidance_text", DEFAULT_TOOLS_GUIDANCE)
        system_content = f"{system_content}\n\n{guidance}"

    # Encourage one-idea-per-paragraph so paragraph-level branching is meaningful.
    paragraph_style = _load_prompt_layer(
        system_prompt, "paragraph_file", "paragraph_text", DEFAULT_PARAGRAPH_STYLE)
    system_content = f"{system_content}\n\n{paragraph_style}"

    if mode == "voice":
        voice_style = _load_prompt_layer(
            system_prompt, "voice_file", "voice_text", DEFAULT_VOICE_STYLE)
        system_content = f"{system_content}\n\n{voice_style}"

    messages = [
        {
            "role": "system",
            "content": system_content,
        }
    ]

    # Recall block (memory) enters as a system message right after the main prompt,
    # before the recent window — this is "your memory speaking" per INTENTS.md.
    if recall and recall.strip():
        messages.append({
            "role": "system",
            "content": "Relevant memory from earlier conversations (your recall):\n\n" + recall.strip(),
        })

    # Add context from previous turns, with two template-safety repairs:
    # - EMPTY turns are skipped (a failed generation once persisted ""
    #   assistant messages; some templates choke on them).
    # - LEADING assistant turns are dropped: the turns window and the token
    #   trimmer can slice the chain mid-pair, stranding an assistant reply at
    #   the front — and qwen3.6's template hard-errors ("No user query found")
    #   on any history that opens with the assistant. History always starts
    #   with a user turn.
    history = []
    for turn in (context_turns or []):
        if not (turn.get("content") or "").strip():
            continue
        if turn.get("role") in ("user", "assistant"):
            history.append({"role": turn["role"], "content": turn["content"]})
    while history and history[0]["role"] == "assistant":
        history.pop(0)
    messages.extend(history)

    # Per-turn DYNAMIC context goes LAST, not in the main system prompt: the
    # datetime line changes every minute and location every turn, and anything
    # dynamic near the prompt head invalidates LM Studio's KV/prefix cache —
    # forcing a full re-prefill of the whole history each turn. Down here the
    # static prefix (system + history) stays cacheable, and recency placement
    # grounds the model at least as well.
    datetime_text = _load_prompt_layer(
        system_prompt, "datetime_file", "datetime_text", DEFAULT_DATETIME_TEXT)
    now = time.strftime("%A, %Y-%m-%d %H:%M %Z")
    dynamic = datetime_text.replace("{now}", now)
    if extra_system and extra_system.strip():
        dynamic = f"{dynamic}\n\n{extra_system.strip()}"
    messages.append({"role": "system", "content": dynamic})

    # Add current user message
    messages.append({"role": "user", "content": message})
    return messages


def _message_shape(messages: List[Dict]) -> str:
    """Compact, content-free description of a message array for failure logs:
    role(chars)[+tool_calls][!None] per message. Lets a template failure be
    diagnosed from the journal without exposing conversation content."""
    parts = []
    for m in messages or []:
        c = m.get("content")
        desc = f"{m.get('role','?')}({'None' if c is None else len(str(c))})"
        if m.get("tool_calls"):
            desc += f"+tc{len(m['tool_calls'])}"
        parts.append(desc)
    return " ".join(parts)


def _build_payload(messages: List[Dict], stream: bool) -> Dict:
    """Build the chat/completions request payload from config."""
    inference_config = _get_config()["inference"]
    payload = {
        "model": inference_config["model_id"],
        "messages": messages,
        "temperature": inference_config.get("temperature", 0.7),
        "max_tokens": inference_config.get("max_tokens", 2048),
        "stream": stream,
    }
    if inference_config.get("thinking_mode", False):
        payload["reasoning"] = True
    return payload


def stream_llm_tokens(
    message: str,
    context_turns: Optional[List[Dict]] = None,
    mode: Optional[str] = None,
    recall: Optional[str] = None,
    extra_system: Optional[str] = None,
    include_reasoning: bool = False,
):
    """Yield tokens from the local LLM endpoint as they arrive (true streaming).

    Args:
        message: The user's input message
        context_turns: List of previous turns to include in context
        mode: Turn mode ("voice" augments the system prompt for spoken style)
        recall: Optional synthesized recall block injected as memory context

    Yields:
        Content fragments (tokens) as they are produced by the model.

    Raises:
        ConnectionError / RuntimeError on transport or unexpected errors. These
        may surface before the first token or partway through iteration.
    """
    import json

    messages = _build_messages(message, context_turns, mode=mode, recall=recall,
                               extra_system=extra_system)
    payload = _build_payload(messages, stream=True)

    emitted_any = False
    saw_reasoning = False
    hit_length = False
    try:
        response = requests.post(
            f"{_get_endpoint_url()}/chat/completions",
            json=payload,
            timeout=60,
            stream=True,
        )
        response.raise_for_status()
        # Parse the SSE stream at the BYTE level. LM Studio sends
        # "text/event-stream" with no charset, and relying on requests'
        # decode_unicode both (a) defaults to ISO-8859-1 and (b) can mangle a
        # multi-byte UTF-8 char that straddles a network chunk boundary -> mojibake
        # (e.g. an intermittent "'" -> "â"). A newline (0x0A) never appears inside
        # a UTF-8 multi-byte sequence, so splitting on bytes is always safe, and
        # json.loads decodes the complete line's bytes as UTF-8 correctly.
        for raw_line in response.iter_lines():  # bytes, split on newlines
            if not raw_line:
                continue
            if raw_line.startswith(b"data:"):
                data_bytes = raw_line[5:].strip()
                if data_bytes == b"[DONE]":
                    break
                try:
                    data = json.loads(data_bytes)  # decodes UTF-8 bytes
                except Exception:
                    # Skip malformed SSE lines
                    continue
                if isinstance(data, dict) and data.get("error"):
                    err = data["error"]
                    msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                    raise RuntimeError(f"LM Studio error: {msg}")
                if "choices" in data and len(data["choices"]) > 0:
                    choice = data["choices"][0]
                    delta = choice.get("delta", {})
                    if delta.get("reasoning_content"):
                        saw_reasoning = True
                        if include_reasoning and _stream_reasoning_enabled():
                            yield {"type": "reasoning",
                                   "content": delta["reasoning_content"]}
                    if choice.get("finish_reason") == "length":
                        hit_length = True
                    content = delta.get("content", "")
                    if content:
                        emitted_any = True
                        yield ({"type": "token", "content": content}
                               if include_reasoning else content)

        # Reasoning models can burn the entire max_tokens budget on thinking
        # and emit no answer at all — the model "works hard" and the app shows
        # nothing. Never end silently: say what happened.
        if not emitted_any and saw_reasoning:
            print("Warning: model produced reasoning but no answer "
                  f"(finish_reason=length: {hit_length}) — raise "
                  "inference.max_tokens (thinking spends the same budget)")
            fallback = ("[The model spent its entire response budget on internal "
                        "reasoning and produced no answer. Try again, or raise "
                        "inference.max_tokens — reasoning models need thinking "
                        "headroom beyond the answer length.]")
            yield ({"type": "token", "content": fallback}
                   if include_reasoning else fallback)

    except requests.exceptions.Timeout:
        raise ConnectionError("LLM endpoint timeout after 60 seconds")
    except requests.exceptions.ConnectionError as e:
        raise ConnectionError(f"Failed to connect to LLM endpoint at {_get_endpoint_url()}: {e}")
    except requests.exceptions.RequestException as e:
        raise ConnectionError(f"Request to LLM endpoint failed: {e}")
    except RuntimeError as e:
        print(f"LLM stream error: {e} — message shape: {_message_shape(messages)}")
        raise


def call_llm_streaming(
    message: str,
    context_turns: Optional[List[Dict]] = None,
    on_token: Optional[callable] = None,
    mode: Optional[str] = None,
) -> StreamingResponse:
    """
    Call the local LLM endpoint with streaming and optional token callback.

    Args:
        message: The user's input message
        context_turns: List of previous turns to include in context
        on_token: Optional callback called with each token as it arrives
        mode: Turn mode ("voice" augments the system prompt for spoken style)

    Returns:
        StreamingResponse containing text and optional metadata
    """
    try:
        full_response = ""
        for content in stream_llm_tokens(message, context_turns, mode=mode):
            full_response += content
            if on_token:
                on_token(content)
        return StreamingResponse(text=full_response)
    except ConnectionError:
        raise
    except Exception as e:
        raise RuntimeError(f"Error calling LLM: {e}")


def call_llm_non_streaming(
    message: str,
    context_turns: Optional[List[Dict]] = None
) -> str:
    """
    Call the local LLM endpoint without streaming (for backwards compatibility).
    
    Args:
        message: The user's input message
        context_turns: List of previous turns to include in context
    
    Returns:
        The complete model response as a string
    """
    config = _get_config()
    inference_config = config["inference"]
    
    # Build the prompt with context
    messages = [
        {
            "role": "system",
            "content": config.get("system_prompt", {}).get(
                "text", "You are Collaborator, a helpful assistant."
            )
        }
    ]
    
    # Add context from previous turns
    if context_turns and len(context_turns) > 0:
        for turn in context_turns:
            if turn.get("role") == "user":
                messages.append({"role": "user", "content": turn["content"]})
            elif turn.get("role") == "assistant":
                messages.append({"role": "assistant", "content": turn["content"]})
    
    # Add current user message
    messages.append({"role": "user", "content": message})
    
    # Build the request payload
    payload = {
        "model": inference_config["model_id"],
        "messages": messages,
        "temperature": inference_config.get("temperature", 0.7),
        "max_tokens": inference_config.get("max_tokens", 2048)
    }
    
    # Add thinking mode if enabled
    if inference_config.get("thinking_mode", False):
        payload["reasoning"] = True
    
    try:
        # Call the LLM endpoint
        response = requests.post(
            f"{_get_endpoint_url()}/chat/completions",
            json=payload,
            timeout=60
        )
        response.raise_for_status()
        
        # Parse the response
        data = response.json()
        
        if "choices" in data and len(data["choices"]) > 0:
            return data["choices"][0]["message"]["content"]
        else:
            raise ValueError("No response choices returned from LLM")
            
    except requests.exceptions.Timeout:
        raise ConnectionError(f"LLM endpoint timeout after 60 seconds")
    except requests.exceptions.ConnectionError as e:
        raise ConnectionError(f"Failed to connect to LLM endpoint at {_get_endpoint_url()}: {e}")
    except requests.exceptions.RequestException as e:
        raise ConnectionError(f"Request to LLM endpoint failed: {e}")
    except Exception as e:
        raise RuntimeError(f"Error calling LLM: {e}")


def call_llm(
    message: str,
    context_turns: Optional[List[Dict]] = None
) -> StreamingResponse:
    """
    Call the local LLM endpoint (default: streaming enabled).
    
    Args:
        message: The user's input message
        context_turns: List of previous turns to include in context
    
    Returns:
        StreamingResponse containing text
    """
    return call_llm_streaming(message, context_turns)


def get_available_models() -> List[str]:
    """Get list of available models from the LLM endpoint.
    
    Returns:
        List of model IDs, or single default model if fetch fails
    """
    try:
        response = requests.get(f"{_get_endpoint_url()}/models", timeout=5)
        response.raise_for_status()
        
        data = response.json()
        if "data" in data:
            models = [model["id"] for model in data["data"] if isinstance(model, dict)]
            return models if models else [_get_model_id()]
        return [_get_model_id()]
        
    except Exception as e:
        print(f"Warning: Could not fetch models from LLM endpoint: {e}")
        return [_get_model_id()]


@lru_cache(maxsize=1)
def get_cached_models() -> List[str]:
    """Get models with caching (for infrequently changing lists)."""
    return get_available_models()


def chat_with_retry(
    message: str,
    context_turns: Optional[List[Dict]] = None,
    max_retries: int = 2
) -> str:
    """
    Call LLM with automatic retry on connection errors.
    
    Args:
        message: The user's input message
        context_turns: List of previous turns for context
        max_retries: Maximum number of retry attempts
    
    Returns:
        The model's response as a string
    """
    last_error = None
    
    for attempt in range(max_retries + 1):
        try:
            response = call_llm_streaming(message, context_turns)
            return response.text
        except ConnectionError as e:
            last_error = e
            if attempt < max_retries:
                print(f"Connection failed (attempt {attempt + 1}/{max_retries}), retrying...")
                continue
            raise ConnectionError(f"Failed after {max_retries + 1} attempts: {last_error}")
        except RuntimeError as e:
            # Don't retry on runtime errors
            raise


# --- Model context length (LM Studio /api/v0/models) ---------------------------

_ctx_cache: Dict[str, tuple] = {}   # model_id -> (monotonic_ts, tokens|None)


def model_ids_match(a: Optional[str], b: Optional[str]) -> bool:
    """Loose id equality for load-state display: case-insensitive, and
    tolerant of publisher prefixes ('qwen/x' vs 'x') and instance suffixes
    LM Studio sometimes appends ('x:2'). Display logic only — requests always
    use the exact configured id."""
    if not a or not b:
        return False
    def norm(s):
        s = s.lower().split(":")[0]
        return s.rsplit("/", 1)[-1]
    return a.lower() == b.lower() or norm(a) == norm(b)


def get_models_detail() -> List[Dict]:
    """Per-model metadata from LM Studio's /api/v0/models: id, type, state
    (loaded / not-loaded), quantization, context lengths. Empty list when the
    endpoint doesn't expose it (non-LM-Studio server) — callers fall back to
    the plain /v1/models name list."""
    base = _get_endpoint_url().rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3].rstrip("/")
    try:
        r = requests.get(f"{base}/api/v0/models", timeout=5)
        r.raise_for_status()
        return [{
            "id": m.get("id"),
            "type": m.get("type"),
            "state": m.get("state"),
            "quantization": m.get("quantization"),
            "max_context_length": m.get("max_context_length"),
            "loaded_context_length": m.get("loaded_context_length"),
        } for m in r.json().get("data", []) if m.get("id")]
    except Exception as e:
        print(f"Warning: could not read model details: {e}")
        return []


def get_model_context_tokens(model_id: Optional[str] = None) -> Optional[int]:
    """The model's context window in tokens, from LM Studio's /api/v0/models
    (loaded_context_length when loaded, else max_context_length). Cached 5 min;
    None when the endpoint doesn't expose it (other OpenAI-compat servers)."""
    import time as _t
    model_id = model_id or _get_model_id()
    now = _t.monotonic()
    hit = _ctx_cache.get(model_id)
    if hit and now - hit[0] < 300:
        return hit[1]
    base = _get_endpoint_url().rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3].rstrip("/")
    tokens = None
    try:
        r = requests.get(f"{base}/api/v0/models", timeout=5)
        r.raise_for_status()
        for m in r.json().get("data", []):
            if m.get("id") == model_id:
                tokens = (m.get("loaded_context_length")
                          or m.get("max_context_length"))
                break
    except Exception as e:
        print(f"Warning: could not read model context length: {e}")
    _ctx_cache[model_id] = (now, tokens)
    return tokens


def estimate_tokens(text: str) -> int:
    """Cheap token estimate (~4 chars/token English prose). Deliberately on the
    high side of reality for code/JSON so budgeting errs toward safety."""
    return len(text or "") // 4 + 1


# --- Recall: embeddings + synthesis (both via the LM Studio endpoint) ---------

def _recall_config() -> Dict:
    return _get_config().get("recall", {}) or {}


# Fallback used only if no synthesis prompt file/string is configured.
DEFAULT_RECALL_SYNTHESIS_PROMPT = (
    "You are a memory synthesizer. Combine the related past turns into a concise, "
    "first-person memory block that reads like something the user would remember "
    "about earlier conversations. Be natural and conversational. Do not invent facts."
)


def _load_recall_synthesis_prompt(rc: Dict) -> str:
    """Load the recall synthesis system prompt.

    Precedence (mirrors the chat system prompt): a markdown file
    (recall.synthesis_prompt_file, editable/auditable) -> an inline config string
    (recall.synthesis_system) -> the built-in default.
    """
    file_path = rc.get("synthesis_prompt_file")
    if file_path:
        try:
            with open(resolve_path(file_path), "r", encoding="utf-8") as f:
                text = f.read().strip()
                if text:
                    return text
        except IOError:
            pass
    return rc.get("synthesis_system") or DEFAULT_RECALL_SYNTHESIS_PROMPT


_local_embedder = None


def _get_local_embedder():
    """Lazy-load the in-process fastembed model (ONNX, no PyTorch).

    Downloads the model once on first use, then caches it on disk and in memory.
    """
    global _local_embedder
    if _local_embedder is None:
        from fastembed import TextEmbedding
        model = _recall_config().get("embedding_model_local", "BAAI/bge-small-en-v1.5")
        _local_embedder = TextEmbedding(model_name=model)
    return _local_embedder


def _embed_texts_lmstudio(texts: List[str]) -> List[Optional[List[float]]]:
    rc = _recall_config()
    model = rc.get("embedding_model", "text-embedding-nomic-embed-text-v1.5")
    try:
        response = requests.post(
            f"{_get_endpoint_url()}/embeddings",
            json={"model": model, "input": list(texts)},
            timeout=rc.get("embedding_timeout", 30),
        )
        response.raise_for_status()
        data = sorted(response.json()["data"], key=lambda d: d.get("index", 0))
        return [d["embedding"] for d in data]
    except Exception as e:
        print(f"Warning: LM Studio embedding request failed: {e}")
        return [None] * len(texts)


def embed_texts(texts: List[str]) -> List[Optional[List[float]]]:
    """Embed a batch of texts -> list of vectors (in order; None per failed item).

    Dispatches on recall.embedding_backend: "local" (fastembed, default) runs
    in-process on this machine; "lmstudio" calls the LM Studio /v1/embeddings
    endpoint. Best-effort — recall must never break a turn.
    """
    if not texts:
        return []
    backend = _recall_config().get("embedding_backend", "local")
    if backend == "lmstudio":
        return _embed_texts_lmstudio(texts)
    try:
        embedder = _get_local_embedder()
        return [vec.tolist() for vec in embedder.embed(list(texts))]
    except Exception as e:
        print(f"Warning: local embedding failed: {e}")
        return [None] * len(texts)


def get_embedding(text: str) -> Optional[List[float]]:
    """Embed a single text. Returns the vector, or None on empty/failure."""
    if not text or not text.strip():
        return None
    out = embed_texts([text])
    return out[0] if out else None


def synthesize_recall(query: str, matches: List[Dict]) -> str:
    """Synthesize matched memories into a first-person recall block via the LLM.

    `matches` is a list of dicts with at least text/tags/score/branch_root_id.
    Uses a small max_tokens budget (configurable) to keep recall snappy.
    Returns "" if there is nothing to synthesize or on failure.
    """
    if not matches:
        return ""
    rc = _recall_config()
    inference_config = _get_config()["inference"]

    system_prompt = _load_recall_synthesis_prompt(rc)

    lines = []
    for m in matches:
        tags = ", ".join(m.get("tags") or []) or "none"
        lines.append(
            f"- (relevance {m.get('score', 0):.2f}, tags: {tags}) {m.get('text', '')}"
        )
    user_prompt = (
        f"Current message: {query}\n\n"
        "Relevant memories from past conversations:\n"
        + "\n".join(lines)
        + "\n\nSynthesize these into a concise first-person memory block."
    )

    payload = {
        "model": _get_utility_model(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": rc.get("synthesis_temperature", 0.3),
        "max_tokens": rc.get("synthesis_max_tokens", 768),
        "stream": False,
    }

    try:
        response = requests.post(
            f"{_get_endpoint_url()}/chat/completions",
            json=payload,
            timeout=rc.get("synthesis_timeout", 60),
        )
        response.raise_for_status()
        return _extract_message_text(response.json(), "recall synthesis")
    except Exception as e:
        print(f"Warning: recall synthesis failed: {e}")
        return ""


# --- Conversation titles --------------------------------------------------------

DEFAULT_TITLE_PROMPT = (
    "You title conversations for a chat list. Given the conversation excerpt, reply "
    "with ONLY the title: 2-6 words, plain text, no quotes, no trailing punctuation, "
    "no markdown. Name the specific subject (and intent when clear) — never generic "
    "labels like 'Chat', 'Conversation', or 'Help with a question'."
)


def generate_title(turns: List[Dict]) -> str:
    """One short LLM call: a 2-6 word title for a conversation's chat-list row.

    Config: titles {prompt_file/prompt_text, temperature, max_tokens, timeout}.
    Returns "" on empty output (callers treat that as generation failure).
    """
    tcfg = _get_config().get("titles", {}) or {}
    prompt = _load_prompt_layer(tcfg, "prompt_file", "prompt_text", DEFAULT_TITLE_PROMPT)
    # Sample the WHOLE conversation, not a recency window: the opening turns
    # define the subject; the latest turns show where it went. A small model
    # given only the tail titles the latest tangent instead of the thread.
    if len(turns) > 12:
        sampled = turns[:3] + [{"role": "...", "content":
                                f"[{len(turns) - 12} turns omitted]"}] + turns[-9:]
    else:
        sampled = turns
    excerpt = "\n".join(
        f"{t.get('role', '?')}: {(t.get('content') or '')[:400]}"
        for t in sampled)[:6000]
    payload = _build_payload(
        [{"role": "system", "content": prompt},
         {"role": "user", "content": excerpt}], stream=False)
    payload["temperature"] = tcfg.get("temperature", 0.3)
    # Titles are ~6 words, but reasoning models think before answering and the
    # thinking spends this same budget — 24 tokens starved MiniMax into
    # returning nothing at all. Keep generous; the first line is taken anyway.
    payload["max_tokens"] = tcfg.get("max_tokens", 512)
    payload["model"] = _get_utility_model()

    response = requests.post(
        f"{_get_endpoint_url()}/chat/completions",
        json=payload, timeout=tcfg.get("timeout", 30),
    )
    response.raise_for_status()
    text = _extract_message_text(response.json(), "title generation")
    first_line = text.strip().splitlines()[0] if text.strip() else ""
    title = " ".join(first_line.split()).strip(' "\'')
    return title[:80].rstrip(" .")


# --- Notes synthesis (tree -> atomic note drafts) ------------------------------

_NOTES_SCHEMA = {
    "name": "note_drafts",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "notes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string",
                                  "description": "SHORT wikilink handle: declarative "
                                                 "claim or honest question, 3-7 words, "
                                                 "never a full sentence"},
                        "body": {"type": "string"},
                        "tags": {"type": "array", "items": {"type": "string"}},
                        "links": {"type": "array", "items": {"type": "string"}},
                        "source_turns": {"type": "array", "items": {"type": "integer"}},
                    },
                    "required": ["title", "body", "tags", "links", "source_turns"],
                },
            }
        },
        "required": ["notes"],
    },
}

DEFAULT_NOTES_SYNTHESIS_PROMPT = (
    "Distill this conversation tree into atomic notes: standalone, reusable ideas "
    "phrased as declarative claims (or honest questions) in the user's first-person "
    "voice. Weigh user turns far more heavily than assistant turns. 50-200 words per "
    "note, no dialogue form, no metadata in bodies. Zero notes is valid."
)


def _notes_config() -> Dict:
    return _get_config().get("notes", {}) or {}


def synthesize_notes(tree: Dict, existing_notes: Optional[List[Dict]] = None) -> List[Dict]:
    """Distill an exported conversation tree into atomic note drafts.

    One blocking LLM call with structured (json_schema) output. existing_notes
    ([{title, tags}]) are vault notes the model must NOT duplicate — it should link
    to them with [[wikilinks]] instead. Returns a list of {title, body, tags, links,
    source_turns} dicts; invalid entries are dropped. Raises on transport/parse
    failure (the endpoint surfaces it to the user).
    """
    import json

    ncfg = _notes_config()
    system_prompt = _load_prompt_layer(
        ncfg, "synthesis_prompt_file", "synthesis_prompt_text",
        DEFAULT_NOTES_SYNTHESIS_PROMPT)

    user_content = json.dumps(tree, ensure_ascii=False)
    if existing_notes:
        listing = "\n".join(
            f"- {n['title']}" + (f" (tags: {', '.join(n['tags'])})" if n.get("tags") else "")
            for n in existing_notes)
        user_content += (
            "\n\nNOTES THAT ALREADY EXIST in the user's vault — do NOT propose a "
            "duplicate of any of these. Where one is relevant, link to it with a "
            "[[wikilink]] instead:\n" + listing)

    payload = {
        # Vault-authoring call: notes become the user's permanent knowledge, in
        # their voice — always the CHAT model, never utility (boundary rule).
        "model": _get_model_id(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": ncfg.get("synthesis_temperature", 0.3),
        "max_tokens": ncfg.get("synthesis_max_tokens", 4096),
        "stream": False,
        "response_format": {"type": "json_schema", "json_schema": _NOTES_SCHEMA},
    }

    response = requests.post(
        f"{_get_endpoint_url()}/chat/completions",
        json=payload,
        timeout=ncfg.get("synthesis_timeout", 300),
    )
    response.raise_for_status()
    content = _extract_message_text(response.json(), "notes synthesis")

    try:
        parsed = json.loads(content)
    except Exception:
        # Fallback: some models wrap JSON in prose/fences — extract the outer object.
        start, end = content.find("{"), content.rfind("}")
        if start == -1 or end <= start:
            raise ValueError(f"Notes synthesis returned unparseable output: {content[:200]!r}")
        parsed = json.loads(content[start:end + 1])

    notes = []
    for n in parsed.get("notes", []):
        if not isinstance(n, dict):
            continue
        title = str(n.get("title") or "").strip()
        body = str(n.get("body") or "").strip()
        if not title or not body:
            continue
        notes.append({
            "title": title,
            "body": body,
            "tags": [str(t) for t in (n.get("tags") or [])],
            "links": [str(l) for l in (n.get("links") or [])],
            "source_turns": [int(i) for i in (n.get("source_turns") or [])
                             if isinstance(i, (int, float))],
        })
    return notes


# --- Web search (SearXNG) ------------------------------------------------------

def web_search_searxng(query: str, limit: Optional[int] = None) -> Dict:
    """Query the configured SearXNG instance (JSON API) and return compact results.

    Config: tools.web_search {url (required to enable the tool), results, timeout,
    language, safesearch}. SearXNG must have the json format enabled in its
    settings.yml (search.formats: [html, json]). `limit` overrides the configured
    result cap per call (used by the manual GET /api/search endpoint).
    """
    wcfg = (_tools_config().get("web_search") or {})
    base = (wcfg.get("url") or "").rstrip("/")
    if not base:
        return {"error": "web search is not configured (tools.web_search.url)"}
    try:
        response = requests.get(
            f"{base}/search",
            params={
                "q": query,
                "format": "json",
                "language": wcfg.get("language", "en"),
                "safesearch": wcfg.get("safesearch", 0),
            },
            timeout=wcfg.get("timeout", 15),
        )
        response.raise_for_status()
        data = response.json()
    except Exception as e:
        return {"error": f"web search failed: {e}"}

    limit = limit or wcfg.get("results", 5)
    out = {"results": [{
        "title": r.get("title"),
        "url": strip_tracking_params(r["url"]) if r.get("url") else r.get("url"),
        "snippet": (r.get("content") or "")[:300],
        "engine": r.get("engine"),
    } for r in (data.get("results") or [])[:limit]]}
    if data.get("answers"):
        out["answers"] = [str(a) for a in data["answers"][:3]]
    if data.get("infoboxes"):
        out["infoboxes"] = [{
            "title": i.get("infobox"),
            "content": (i.get("content") or "")[:300],
        } for i in data["infoboxes"][:1]]

    # SearXNG reports per-engine failures (rate limits, CAPTCHAs) in-band with a
    # 200 and an empty results list. Zero results with every engine down is a
    # FAILURE, not "no results" — say so, or the model tells the user the web has
    # nothing on the topic.
    unresponsive = [e for e in (data.get("unresponsive_engines") or [])
                    if isinstance(e, (list, tuple)) and e]
    if unresponsive and not out["results"] and not data.get("answers"):
        detail = "; ".join(f"{e[0]}: {e[1] if len(e) > 1 else 'failed'}"
                           for e in unresponsive[:6])
        return {"error": f"web search failed — no engines responded ({detail})"}
    return out


# --- URL hygiene ----------------------------------------------------------------

# Tracking params stripped from every URL the model encounters (fetch targets,
# web-search results, links harvested from pages). Mirrors the frontend's list
# for user-pasted URLs. Conservative: known trackers only, never functional
# params.
_TRACKING_PARAMS = {
    "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid",
    "twclid", "igshid", "si", "mc_cid", "mc_eid", "_hsenc", "_hsmi",
    "mkt_tok", "vero_id", "oly_anon_id", "oly_enc_id", "s_cid",
}


def strip_tracking_params(url: str) -> str:
    """Remove known tracking query params (utm_* + click/share ids) from a URL."""
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
    if not url or "?" not in url:
        return url
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if not (k.lower().startswith("utm_") or k.lower() in _TRACKING_PARAMS)]
    return urlunsplit(parts._replace(query=urlencode(kept, doseq=True)))


# --- URL fetching (read a page the user pasted) --------------------------------

class _HtmlTextExtractor:
    """Stdlib HTML -> readable text + hyperlinks (no extra deps)."""

    def __init__(self):
        from html.parser import HTMLParser

        skip_tags = {"script", "style", "noscript", "svg", "template", "iframe"}
        block_tags = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5",
                      "h6", "section", "article", "header", "footer", "ul", "ol",
                      "table", "blockquote", "pre"}

        class Parser(HTMLParser):
            def __init__(self):
                super().__init__(convert_charrefs=True)
                self.parts, self.title, self.raw_links = [], "", []
                self._skip, self._in_title = 0, False
                self._href, self._anchor = None, []

            def handle_starttag(self, tag, attrs):
                if tag in skip_tags:
                    self._skip += 1
                elif tag == "title":
                    self._in_title = True
                elif tag == "a" and not self._skip:
                    self._href = dict(attrs).get("href")
                    self._anchor = []
                elif tag in block_tags:
                    self.parts.append("\n")

            def handle_endtag(self, tag):
                if tag in skip_tags and self._skip > 0:
                    self._skip -= 1
                elif tag == "title":
                    self._in_title = False
                elif tag == "a":
                    if self._href:
                        self.raw_links.append(
                            (" ".join("".join(self._anchor).split()), self._href))
                    self._href, self._anchor = None, []
                elif tag in block_tags:
                    self.parts.append("\n")

            def handle_data(self, data):
                if self._skip:
                    return
                if self._in_title:
                    self.title += data
                else:
                    if self._href is not None:
                        self._anchor.append(data)
                    self.parts.append(data)

        self._parser = Parser()

    def extract(self, html: str, base_url: str = None, max_links: int = 40):
        """Return (title, text, links). links = [{text, url}], absolute http(s)
        only, deduped, capped at max_links."""
        import re
        from urllib.parse import urljoin, urldefrag

        self._parser.feed(html)
        text = "".join(self._parser.parts)
        lines = [" ".join(l.split()) for l in text.splitlines()]
        text = "\n".join(l for l in lines if l)
        text = re.sub(r"\n{3,}", "\n\n", text)

        links, seen = [], set()
        for anchor, href in self._parser.raw_links:
            if not href or href.startswith("#"):
                continue
            absolute = urldefrag(urljoin(base_url, href) if base_url else href)[0]
            if not absolute.startswith(("http://", "https://")):
                continue  # drops javascript:, mailto:, tel:, data:, relative w/o base
            absolute = strip_tracking_params(absolute)
            if absolute in seen:
                continue
            seen.add(absolute)
            links.append({"text": anchor[:80], "url": absolute})
            if len(links) >= max_links:
                break
        return self._parser.title.strip(), text.strip(), links


def _host_is_private(host: str) -> bool:
    """True when the host resolves to a private/loopback/link-local address."""
    import ipaddress
    import socket
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError):
        return False  # unresolvable: let the HTTP layer fail with its own error
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return True
    return False


def _fetch_via_webtool(url: str, fcfg: Dict) -> Dict:
    """Fetch through the search VM's Playwright service (headless Chromium that
    egresses via the VM's VPN — the page never sees this machine's IP, and
    JS-rendered pages actually render).

    Asks for raw HTML (text_only: false) so our own extractor still harvests the
    hyperlinks that power link-following. FAILS CLOSED: if the webtool is down we
    return an error — never a silent direct (clearnet) fetch.
    """
    base = fcfg["webtool_url"].rstrip("/")
    timeout = fcfg.get("webtool_timeout", 60)
    max_chars = fcfg.get("max_chars", 8000)

    def one_fetch(wait_ms):
        response = requests.post(
            f"{base}/fetch",
            json={"url": url, "text_only": False, "wait_ms": wait_ms},
            timeout=timeout,
        )
        response.raise_for_status()
        data = response.json()
        html = data.get("content") or ""
        final_url = data.get("url") or url
        title, body, links = "", html, []
        try:
            title, body, links = _HtmlTextExtractor().extract(
                html, base_url=final_url, max_links=fcfg.get("max_links", 40))
        except Exception:
            pass  # fall back to the raw content
        return final_url, title, body, links

    wait_ms = fcfg.get("webtool_wait_ms", 0)
    try:
        final_url, title, body, links = one_fetch(wait_ms)
        # SPAs often render after DOM load; one retry with settle time when the
        # first pass came back (near-)empty.
        if len(body.strip()) < 200 and wait_ms < 2500:
            final_url, title, body, links = one_fetch(2500)
    except requests.exceptions.RequestException as e:
        return {"error": f"fetch failed (webtool at {base}): {e}"}

    truncated = len(body) > max_chars
    return {
        "url": final_url,
        "title": title,
        "content": body[:max_chars],
        "truncated": truncated,
        "links": links,
        "via": "webtool",
    }


def screenshot_page(url: str, question: Optional[str] = None) -> Dict:
    """Screenshot a page via the webtool and analyze it with the local vision model.

    Two hops, both self-hosted: the search VM's Playwright service renders the
    page (VPN egress, JS executed, full-page PNG) and LM Studio's vision model
    (tools.screenshot.vision_model, loaded on demand) describes it / answers the
    model's question about it. Returns {url, visual, page_text_excerpt?}.
    Reuses fetch_url's URL guards; fails closed like _fetch_via_webtool.
    """
    from urllib.parse import urlparse

    fcfg = (_tools_config().get("fetch_url") or {})
    scfg = (_tools_config().get("screenshot") or {})
    url = strip_tracking_params((url or "").strip())
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return {"error": f"only http(s) URLs can be screenshotted, got {url!r}"}
    if not fcfg.get("allow_private", False) and _host_is_private(parsed.hostname or ""):
        return {"error": "refusing to screenshot a private/internal address "
                         "(enable tools.fetch_url.allow_private for tailnet/LAN URLs)"}
    base = (fcfg.get("webtool_url") or "").rstrip("/")
    if not base:
        return {"error": "screenshots need the webtool (tools.fetch_url.webtool_url)"}
    vision_model = scfg.get("vision_model")
    if not vision_model:
        return {"error": "no vision model configured (tools.screenshot.vision_model)"}

    try:
        response = requests.post(
            f"{base}/screenshot",
            json={"url": url, "text_only": True,
                  "wait_ms": fcfg.get("webtool_wait_ms", 0)},
            timeout=fcfg.get("webtool_timeout", 60),
        )
        response.raise_for_status()
        data = response.json()
    except requests.exceptions.RequestException as e:
        return {"error": f"screenshot failed (webtool at {base}): {e}"}
    png_b64 = data.get("screenshot_b64") or ""
    if not png_b64:
        return {"error": "webtool returned no screenshot"}

    prompt = (question or "").strip() or (
        "Describe this web page screenshot for someone who cannot see it: the "
        "layout, the main content, and any text that matters. Transcribe important "
        "text accurately; say so when text is too small to read.")
    payload = {
        "model": vision_model,
        "messages": [{"role": "user", "content": [
            {"type": "image_url",
             "image_url": {"url": f"data:image/png;base64,{png_b64}"}},
            {"type": "text", "text": prompt},
        ]}],
        "temperature": scfg.get("temperature", 0.2),
        "max_tokens": scfg.get("max_tokens", 512),
        "stream": False,
    }
    try:
        # Generous timeout: LM Studio JIT-loads the vision model on first use.
        vr = requests.post(f"{_get_endpoint_url()}/chat/completions",
                           json=payload, timeout=scfg.get("timeout", 180))
        vr.raise_for_status()
        visual = (vr.json()["choices"][0]["message"]["content"] or "").strip()
    except requests.exceptions.RequestException as e:
        detail = ""
        body = getattr(getattr(e, "response", None), "text", "") or ""
        if body:
            detail = f" — {body[:200]}"
        return {"error": f"vision analysis failed ({vision_model}): {e}{detail}"}
    if not visual:
        return {"error": f"vision model {vision_model} returned no analysis"}

    out = {"url": data.get("url") or url, "visual": visual, "via": "webtool"}
    text = (data.get("text") or "").strip()
    if text:
        out["page_text_excerpt"] = text[:scfg.get("text_chars", 2000)]
    return out


def fetch_url(url: str) -> Dict:
    """Fetch a URL and return readable text + hyperlinks for the model.

    Config: tools.fetch_url {max_chars, timeout, allow_private, max_links,
    webtool_url, proxy}. Only http(s); private/internal hosts are refused unless
    allow_private is set (the user may want tailnet docs fetchable).

    PRIVACY: when tools.fetch_url.webtool_url is set, fetches go through the
    search VM's Playwright service and exit via its VPN (this also renders
    JS-heavy pages). Without it, fetches go DIRECT from this machine — every
    fetched page sees this box's IP (tools.fetch_url.proxy can route the direct
    path through an HTTP/SOCKS proxy; SOCKS needs the 'requests[socks]' extra).
    """
    from urllib.parse import urlparse

    fcfg = (_tools_config().get("fetch_url") or {})
    url = strip_tracking_params((url or "").strip())
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return {"error": f"only http(s) URLs can be fetched, got {url!r}"}
    if not fcfg.get("allow_private", False) and _host_is_private(parsed.hostname or ""):
        return {"error": "refusing to fetch a private/internal address "
                         "(enable tools.fetch_url.allow_private for tailnet/LAN URLs)"}

    if fcfg.get("webtool_url"):
        return _fetch_via_webtool(url, fcfg)

    proxy = fcfg.get("proxy")
    try:
        response = requests.get(
            url,
            timeout=fcfg.get("timeout", 20),
            headers={"User-Agent": "Collaborator/0.2 (self-hosted personal assistant)"},
            stream=True,
            proxies={"http": proxy, "https": proxy} if proxy else None,
        )
        response.raise_for_status()

        max_bytes = fcfg.get("max_bytes", 2_000_000)
        chunks, size = [], 0
        for chunk in response.iter_content(65536):
            chunks.append(chunk)
            size += len(chunk)
            if size > max_bytes:
                break
        raw = b"".join(chunks)
    except requests.exceptions.RequestException as e:
        return {"error": f"fetch failed: {e}"}

    ctype = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
    text_types = ctype.startswith("text/") or ctype in (
        "application/json", "application/xml", "application/xhtml+xml", "")
    if not text_types:
        return {"error": f"unsupported content type {ctype!r} (only html/text/json)"}

    body = raw.decode(response.encoding or "utf-8", errors="replace")
    title, links = "", []
    if ctype in ("text/html", "application/xhtml+xml", ""):
        try:
            title, body, links = _HtmlTextExtractor().extract(
                body, base_url=response.url, max_links=fcfg.get("max_links", 40))
        except Exception:
            pass  # fall back to the raw text

    max_chars = fcfg.get("max_chars", 8000)
    truncated = len(body) > max_chars
    return {
        "url": response.url,
        "title": title,
        "content": body[:max_chars],
        "truncated": truncated,
        "links": links,
    }


# --- Tool-calling loop -------------------------------------------------------

def _tools_config() -> Dict:
    return _get_config().get("tools", {}) or {}


def _load_synthesis_prompt(kind: str) -> str:
    """Load the synthesis system prompt for a given kind (markdown file per kind)."""
    prompts = (_tools_config().get("synthesis") or {}).get("prompts", {}) or {}
    file_path = prompts.get(kind)
    if file_path:
        try:
            with open(resolve_path(file_path), "r", encoding="utf-8") as f:
                text = f.read().strip()
                if text:
                    return text
        except IOError:
            pass
    if kind == "memory":
        return DEFAULT_RECALL_SYNTHESIS_PROMPT
    return (f"You synthesize {kind} results into a concise, well-organized block. "
            "Use only the provided items; do not invent facts.")


def synthesize(kind: str, items: List, query: str = "") -> str:
    """Synthesize a list of items into a block using the prompt for `kind`.

    A single tool parameterized by kind (memory/web/notes/...), each backed by its
    own editable prompt file. Runs one non-streaming LLM call with a token budget.
    """
    system_prompt = _load_synthesis_prompt(kind)
    tcfg = _tools_config().get("synthesis", {}) or {}
    inference_config = _get_config()["inference"]

    body = "\n".join(f"- {it}" for it in (items or []))
    user_prompt = (
        (f"Current message: {query}\n\n" if query else "")
        + f"Items to synthesize:\n{body}\n\nSynthesize these into a concise block."
    )
    payload = {
        "model": _get_utility_model(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": tcfg.get("temperature", 0.3),
        "max_tokens": tcfg.get("max_tokens", 768),
        "stream": False,
    }
    try:
        response = requests.post(
            f"{_get_endpoint_url()}/chat/completions",
            json=payload, timeout=tcfg.get("timeout", 60),
        )
        response.raise_for_status()
        return _extract_message_text(response.json(), f"synthesize({kind})")
    except Exception as e:
        print(f"Warning: synthesize({kind}) failed: {e}")
        return ""


def _tool_status_label(name: str, args: Dict) -> str:
    q = (args.get("query") or "").strip()
    if name == "recall_semantic":
        return f"Searching memory (semantic){f' for “{q[:40]}”' if q else ''}…"
    if name == "recall_keyword":
        return f"Searching memory (keyword){f' for “{q[:40]}”' if q else ''}…"
    if name == "synthesize":
        return f"Synthesizing {args.get('kind', 'results')}…"
    if name == "search_notes":
        return f"Searching notes{f' for “{q[:40]}”' if q else ''}…"
    if name == "get_note":
        t = (args.get("title") or "").strip()
        return f"Reading note{f' “{t[:40]}”' if t else ''}…"
    if name == "propose_note":
        t = (args.get("title") or "").strip()
        return f"Proposing note{f' “{t[:40]}”' if t else ''} (draft for your review)…"
    if name == "propose_edit":
        t = (args.get("title") or "").strip()
        return f"Proposing edit to{f' “{t[:40]}”' if t else ' a note'} (draft for your review)…"
    if name == "web_search":
        return f"Searching the web{f' for “{q[:40]}”' if q else ''}…"
    if name == "fetch_url":
        u = (args.get("url") or "").strip()
        return f"Reading {u[:60]}…" if u else "Reading a page…"
    if name == "screenshot_page":
        u = (args.get("url") or "").strip()
        return f"Screenshotting {u[:60]}…" if u else "Taking a screenshot…"
    if name == "list_events":
        return "Checking your calendar…"
    if name == "get_notes":
        n = len(args.get("titles") or [])
        return f"Reading {n} note{'s' if n != 1 else ''}…"
    if name == "graph_notes":
        t = (args.get("title") or "").strip()
        return f"Mapping the note graph{f' around “{t[:40]}”' if t else ''}…"
    if name == "calculate":
        expr = (args.get("expression") or "").strip()
        return f"Calculating {expr[:40]}…" if expr else "Calculating…"
    if name == "git_read":
        action = args.get("action", "")
        target = (args.get("repo") or "") + ("/" + args.get("path", "") if args.get("path") else "")
        return f"Reading git ({action}){f': {target[:50]}' if target else ''}…"
    if name == "git_issue":
        repo = (args.get("repo") or "").strip()
        verb = "Commenting on issue" if args.get("action") == "comment" else "Filing issue"
        return f"{verb}{f' in {repo[:40]}' if repo else ''}…"
    if name == "transcribe_video":
        u = (args.get("url") or "").strip()
        if not u:
            q = (args.get("query") or "").strip()
            return f"Searching saved transcripts{f' for “{q[:40]}”' if q else ''}…"
        return f"Transcribing video {u[:50]}…"
    if name == "read_logs":
        g = (args.get("grep") or "").strip()
        return f"Checking my logs{f' for “{g[:40]}”' if g else ''}…"
    return f"Running {name}…"


def _tool_status_fields(name: str, args: Dict) -> Dict:
    """Structured fields for the status SSE event (frontend renders these directly,
    instead of parsing the human-readable label)."""
    fields = {}
    q = (args.get("query") or "").strip()
    if q:
        fields["query"] = q
    if name in ("fetch_url", "screenshot_page") and (args.get("url") or "").strip():
        fields["url"] = args["url"].strip()
    if name in ("get_note", "propose_note", "propose_edit") and (args.get("title") or "").strip():
        fields["title"] = args["title"].strip()
    return fields


def _tool_outcome_event(name: str, result: str) -> Optional[Dict]:
    """A follow-up status event reporting what a tool call actually produced, so
    the user can tell 'searched and found nothing' from 'search failed' from
    'never searched'. Returns None for tools where an outcome note adds nothing."""
    import json as _json
    try:
        data = _json.loads(result)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if data.get("error"):
        return {"type": "status", "tool": name, "outcome": "error",
                "error": str(data["error"])[:200],
                "label": f"{name} failed: {str(data['error'])[:120]}"}
    if name == "web_search":
        results = data.get("results") or []
        n = len(results)
        if n == 0:
            return {"type": "status", "tool": name, "outcome": "empty", "count": 0,
                    "label": "Web search returned no results."}
        return {"type": "status", "tool": name, "outcome": "ok", "count": n,
                "urls": [r.get("url") for r in results if r.get("url")],
                "label": f"Web search returned {n} result{'s' if n != 1 else ''}."}
    if name == "fetch_url":
        title = (data.get("title") or "").strip()
        return {"type": "status", "tool": name, "outcome": "ok",
                "label": f"Read page{f': “{title[:60]}”' if title else ''}."}
    if name == "screenshot_page":
        return {"type": "status", "tool": name, "outcome": "ok",
                "label": "Screenshot captured and analyzed."}
    return None


# When a textual tool call passes ONE positional argument — web_search("...") —
# this maps it onto the tool's primary parameter.
_POSITIONAL_ARG_KEY = {
    "web_search": "query", "recall_semantic": "query", "recall_keyword": "query",
    "search_notes": "query", "fetch_url": "url", "screenshot_page": "url",
    "get_note": "title",
}


def _normalize_recovered_args(name: str, args) -> Dict:
    """Repair a recovered call's argument names: a single argument under an
    invented key ("input_string") maps onto the tool's primary parameter."""
    if not isinstance(args, dict):
        return {}
    key = _POSITIONAL_ARG_KEY.get(name)
    if key and key not in args and len(args) == 1:
        return {key: next(iter(args.values()))}
    return args


def _parse_textual_tool_calls(text: str, known_names) -> List[Dict]:
    """Recover tool calls the model wrote as plain text instead of structured
    tool_calls deltas (quantized models especially do this). Accepted dialects:
    bare/fenced JSON ({"name": ..., "arguments": ...}, lists, {"tool_calls": []}),
    qwen's XML style (<function=name><parameter=key>value</parameter></function>),
    call style (<function=name("arg")> / <function=name(key="v")>), and a JSON or
    quoted body inside function tags — all tolerant of missing closing tags.
    Returns [{"name", "args"}, ...] or [] when nothing recognizable."""
    import json as _json
    import re as _re
    s = (text or "").strip()
    s = _re.sub(r"^```(?:json)?\s*|\s*```$", "", s).strip()
    s = _re.sub(r"^<tool_call>\s*|\s*</tool_call>\s*$", "", s).strip()

    def _positional(name, value):
        key = _POSITIONAL_ARG_KEY.get(name)
        return {key: value} if key else None

    # MiniMax-style XML (its native training format, seen when the runtime's tool
    # parser misses): <minimax:tool_call> <invoke name="x"> <parameter name="k">v
    # </parameter> </invoke> </minimax:tool_call> — tolerant of missing closers.
    # Unlike the other dialects, unknown tool names are RETURNED (not treated as
    # prose): this shape is unambiguously a tool call, and the caller uses the
    # name to correct the model instead of showing the blob to the user.
    if _re.search(r'<invoke\s+name="', s):
        calls = []
        for m in _re.finditer(r'<invoke\s+name="([\w.:-]+)"\s*>(.*?)(?:</invoke>|$)',
                              s, _re.S):
            body = m.group(2)
            args = {k: v.strip() for k, v in _re.findall(
                r'<parameter\s+name="([\w.:-]+)"\s*>(.*?)(?:</parameter>|$)',
                body, _re.S)}
            calls.append({"name": m.group(1), "args": args})
        return calls

    # Call style: <function=name("arg")> / <function=name(key="v", k2="v2")>.
    if _re.match(r"<function=[\w.-]+\s*\(", s):
        calls = []
        for m in _re.finditer(r"<function=([\w.-]+)\s*\((.*?)\)\s*>?", s, _re.S):
            name = m.group(1)
            if name not in known_names:
                return []
            inner = m.group(2).strip()
            kwargs = _re.findall(r"""([\w.-]+)\s*=\s*(['"])(.*?)\2""", inner, _re.S)
            if kwargs:
                args = {k: v for k, _q, v in kwargs}
            elif not inner:
                args = {}
            elif inner.startswith("{"):
                try:
                    args = _json.loads(inner)
                except Exception:
                    return []
            else:
                quoted = _re.match(r"""^(['"])(.*)\1$""", inner, _re.S)
                args = _positional(name, (quoted.group(2) if quoted else inner).strip())
                if args is None:
                    return []
            calls.append({"name": name, "args": args if isinstance(args, dict) else {}})
        return calls

    # qwen3-style XML tool call: parameter tags, or a JSON/quoted positional body.
    if s.startswith("<function="):
        calls = []
        for m in _re.finditer(r"<function=([\w.-]+)>\s*(.*?)\s*(?:</function>|$)", s, _re.S):
            name = m.group(1)
            if name not in known_names:
                return []
            body = m.group(2).strip()
            args = {k: v.strip() for k, v in
                    _re.findall(r"<parameter=([\w.-]+)>\s*(.*?)\s*</parameter>",
                                body, _re.S)}
            if not args and body:
                if body.startswith("{"):
                    try:
                        args = _json.loads(body)
                    except Exception:
                        return []
                else:
                    quoted = _re.match(r"""^(['"])(.*)\1$""", body, _re.S)
                    args = _positional(name, (quoted.group(2) if quoted else body).strip())
                    if args is None:
                        return []
            calls.append({"name": name, "args": args if isinstance(args, dict) else {}})
        return calls

    if not s.startswith(("{", "[")):
        return []
    try:
        obj = _json.loads(s)
    except Exception:
        return []
    if isinstance(obj, list):
        candidates = obj
    elif isinstance(obj, dict):
        candidates = obj["tool_calls"] if isinstance(obj.get("tool_calls"), list) else [obj]
    else:
        return []
    calls = []
    for c in candidates:
        if not isinstance(c, dict):
            return []
        fn = c.get("function") if isinstance(c.get("function"), dict) else c
        name = fn.get("name")
        if name not in known_names:
            return []
        args = fn.get("arguments") or fn.get("parameters") or fn.get("args") or {}
        if isinstance(args, str):
            try:
                args = _json.loads(args)
            except Exception:
                args = {}
        calls.append({"name": name, "args": args if isinstance(args, dict) else {}})
    return calls


class _StreamGuard:
    """Withholds streamed text that looks like a textual tool-call blob.

    At message start, any blob-ish opener ({, [, ```, <tool_call, <function) is
    held back. Mid-prose, explicit call markers (<tool_call, <function=) arm the
    guard — "I'll check that.\\n<tool_call>…" is the common failure shape of
    quantized models, and a start-only guard streams the blob to the user. A
    small tail is withheld from passthrough so a marker split across stream
    chunks is still caught. Held text that turns out NOT to be a tool call is
    delivered at end of round — nothing is ever dropped.
    """
    _START = ("{", "[", "```", "<tool_call", "<function", "<minimax", "<invoke")
    _MID = ("<tool_call", "<function=", "<minimax:", "<invoke ")
    _TAIL = max(len(m) for m in _MID) - 1

    def __init__(self):
        self.pending = ""     # passthrough text not yet emitted (marker-tail guard)
        self.held = ""        # suspected blob, from its marker onward
        self._started = False

    def feed(self, content: str) -> str:
        """Add streamed content; return whatever is safe to emit right now."""
        if self.held:
            self.held += content
            return ""
        self.pending += content
        if not self._started:
            lead = self.pending.lstrip()
            if not lead:
                return ""
            self._started = True
            if lead.startswith(self._START):
                self.held, self.pending = self.pending, ""
                return ""
        hits = [i for i in (self.pending.find(m) for m in self._MID) if i != -1]
        if hits:
            cut = min(hits)
            out, self.held, self.pending = self.pending[:cut], self.pending[cut:], ""
            return out
        if len(self.pending) > self._TAIL:
            out, self.pending = self.pending[:-self._TAIL], self.pending[-self._TAIL:]
            return out
        return ""

    def flush_pending(self) -> str:
        """End of round: any withheld ordinary prose (always emit this)."""
        out, self.pending = self.pending, ""
        return out


def _iter_stream_events(payload: Dict):
    """Yield (choice, delta) pairs from a streaming chat completion (byte-safe)."""
    import json
    response = requests.post(
        f"{_get_endpoint_url()}/chat/completions", json=payload, timeout=120, stream=True)
    response.raise_for_status()
    for raw in response.iter_lines():  # bytes; json.loads decodes UTF-8 correctly
        if not raw or not raw.startswith(b"data:"):
            continue
        data_bytes = raw[5:].strip()
        if data_bytes == b"[DONE]":
            break
        try:
            obj = json.loads(data_bytes)
        except Exception:
            continue
        if isinstance(obj, dict) and obj.get("error"):
            err = obj["error"]
            msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            raise RuntimeError(f"LM Studio error: {msg}")
        if obj.get("choices"):
            choice = obj["choices"][0]
            yield choice, (choice.get("delta") or {})


# Reasoning streaming: forwarded as its own event type so the UI can show a
# live "thinking" pane. NEVER accumulated into saved content and never fed
# back into any prompt — display-only. Also keeps bytes flowing during long
# thinks (Cloudflare kills byte-silent connections at ~100s -> 524); when
# disabled, a periodic heartbeat status covers that instead.
_REASONING_FLUSH_CHARS = 80
_HEARTBEAT_SECONDS = 15


def _stream_reasoning_enabled() -> bool:
    return bool(_get_config().get("inference", {}).get("stream_reasoning", True))


def generate_with_tools(
    message: str,
    context_turns: Optional[List[Dict]],
    mode: Optional[str],
    tool_schemas: List[Dict],
    execute_tool,
    max_rounds: int = 5,
    emit_status: bool = True,
    emit_results: bool = False,
    extra_system: Optional[str] = None,
):
    """Run the tool-calling loop and yield event dicts.

    Yields {"type": "token"|"status"|"tool_result"|"error", ...}. The model may
    call tools (executed via execute_tool(name, args) -> str, fed back, repeat);
    the final answer streams as token events. Capped at max_rounds, after which a
    tools-off round forces an answer.
    """
    import json
    messages = _build_messages(message, context_turns, mode=mode,
                               include_tools_guidance=bool(tool_schemas),
                               extra_system=extra_system)

    # Tool-calling is more reliable at a lower temperature than the conversational
    # default, so run the loop at a configurable tools temperature.
    tools_temp = _tools_config().get("temperature", 0.3)

    known_names = {s["function"]["name"] for s in tool_schemas}
    nudged_about_textual_calls = False

    for round_index in range(max_rounds + 1):
        # Last iteration: drop tools so the model must produce a final answer.
        use_tools = tool_schemas and round_index < max_rounds
        if tool_schemas and not use_tools:
            # The model can no longer call tools this turn; without this nudge it
            # tends to emit the tool-call JSON it *wanted* to send as its answer.
            messages.append({"role": "system", "content": (
                "Tool calls are no longer available this turn. Answer the user now "
                "in plain prose from the information already gathered. Do not "
                "output JSON or tool-call syntax.")})
        payload = _build_payload(messages, stream=True)
        payload["temperature"] = tools_temp
        if use_tools:
            payload["tools"] = tool_schemas
            payload["tool_choice"] = "auto"

        # Some models — quantized ones especially — write tool calls as plain text
        # (JSON or <tool_call>/<function=…> markup) instead of structured
        # tool_calls deltas, often after a line of prose. The guard withholds
        # anything blob-shaped (start-of-message or mid-prose) and we decide at
        # end of round: execute it as a tool call if it parses as one, otherwise
        # deliver it as normal text.
        content_parts: List[str] = []
        emitted_parts: List[str] = []   # what actually reached the user this round
        guard = _StreamGuard()
        tool_calls: Dict[int, Dict] = {}
        round_started = time.monotonic()
        first_delta_at = None
        saw_reasoning = False
        hit_length = False
        stream_reasoning = _stream_reasoning_enabled()
        reasoning_buf = ""
        last_heartbeat = time.monotonic()
        try:
            for choice, delta in _iter_stream_events(payload):
                if first_delta_at is None:
                    first_delta_at = time.monotonic()
                    print(f"timing: LLM first delta after "
                          f"{first_delta_at - round_started:.2f}s "
                          f"(round {round_index}, ~{sum(len(str(m.get('content') or '')) for m in messages) // 4} prompt tokens est)")
                if delta.get("reasoning_content"):
                    saw_reasoning = True
                    if stream_reasoning:
                        reasoning_buf += delta["reasoning_content"]
                        if len(reasoning_buf) >= _REASONING_FLUSH_CHARS:
                            yield {"type": "reasoning", "content": reasoning_buf}
                            reasoning_buf = ""
                    else:
                        now = time.monotonic()
                        if emit_status and now - last_heartbeat > _HEARTBEAT_SECONDS:
                            last_heartbeat = now
                            yield {"type": "status", "label": "Thinking…",
                                   "heartbeat": True}
                if choice.get("finish_reason") == "length":
                    hit_length = True
                content = delta.get("content")
                if content:
                    content_parts.append(content)
                    out = guard.feed(content)
                    if out:
                        emitted_parts.append(out)
                        yield {"type": "token", "content": out}
                for tc in (delta.get("tool_calls") or []):
                    slot = tool_calls.setdefault(tc.get("index", 0), {"id": None, "name": "", "args": ""})
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        slot["name"] = fn["name"]
                    if fn.get("arguments"):
                        slot["args"] += fn["arguments"]
        except requests.exceptions.RequestException as e:
            print(f"LLM request failed: {e} — message shape: {_message_shape(messages)}")
            yield {"type": "error", "detail": f"LLM request failed: {e}"}
            return
        except Exception as e:
            import traceback
            print(f"LLM round error: {e} — message shape: {_message_shape(messages)}")
            traceback.print_exc()
            yield {"type": "error", "detail": f"Error during generation: {e}"}
            return

        if reasoning_buf:
            yield {"type": "reasoning", "content": reasoning_buf}
        # Withheld ordinary prose (pre-marker text, or a short whole message) is
        # always delivered.
        tail = guard.flush_pending()
        if tail:
            emitted_parts.append(tail)
            yield {"type": "token", "content": tail}

        held_text = guard.held
        recovered = _parse_textual_tool_calls(held_text, known_names) if held_text else []
        recovered_known = [c for c in recovered if c["name"] in known_names]

        if not tool_calls and recovered and not use_tools:
            # Final forced round and the model STILL answered with a tool call.
            # Never show the raw blob; admit the situation honestly instead.
            yield {"type": "token", "content": (
                "I ran out of tool calls this turn before reaching a definitive "
                "answer. Ask me to continue and I'll pick up from here.")}
            return

        if not tool_calls and recovered and not recovered_known:
            # Structurally a tool call, but no such tool exists (a hallucinated
            # name like "memoryrecall" — typically a model that learned about its
            # tools from prose without seeing the schemas). Never show the blob;
            # tell the model the real tool list and let it retry next round.
            names = ", ".join(sorted({c["name"] for c in recovered}))
            print(f"Warning: model called unknown tool(s) as text: {names}")
            if emit_status:
                yield {"type": "status",
                       "label": f"Model called an unknown tool ({names}); correcting…"}
            messages.append({"role": "assistant", "content": held_text})
            messages.append({"role": "system", "content": (
                f"The tool(s) [{names}] do not exist. The ONLY available tools are: "
                + ", ".join(sorted(known_names)) + ". Invoke one of them through "
                "the native tool-calling interface with its exact name and "
                "parameters, or answer the user in plain prose.")})
            continue

        if not tool_calls and not recovered:
            if held_text:
                # Held-back content turned out not to be a tool call — deliver it.
                yield {"type": "token", "content": held_text}
            elif not emitted_parts and saw_reasoning:
                # Reasoning ate the whole budget: nothing but chain-of-thought
                # was produced. Never end the turn silently.
                print("Warning: model produced reasoning but no answer "
                      f"(finish_reason=length: {hit_length}) — raise "
                      "inference.max_tokens")
                yield {"type": "token", "content": (
                    "[The model spent its entire response budget on internal "
                    "reasoning and produced no answer. Try again, or raise "
                    "inference.max_tokens — reasoning models need thinking "
                    "headroom beyond the answer length.]")}
            return  # final answer already streamed as token events

        if tool_calls:
            if held_text and not recovered:
                yield {"type": "token", "content": held_text}
            ordered = [tool_calls[i] for i in sorted(tool_calls)]
            assistant_content = "".join(content_parts) or None
        else:
            # The model wrote its tool call as plain text; execute it instead of
            # showing the blob to the user. History gets the STRUCTURED form (plus
            # any prose that was streamed) — in-context teaching by example, which
            # matters more than instructions for weaker/quantized models. The
            # warning lands in the ring buffer, so read_logs can reveal how often
            # a model misfires this way. Argument keys are repaired en route
            # ("input_string" -> the tool's real primary parameter).
            print("Warning: recovered textual tool call(s) from model output: "
                  + ", ".join(c["name"] for c in recovered_known))
            ordered = [{"id": None, "name": c["name"],
                        "args": json.dumps(_normalize_recovered_args(c["name"], c["args"]))}
                       for c in recovered_known]
            assistant_content = "".join(emitted_parts).strip() or None

        # Record the assistant's tool-call message, then execute each call.
        messages.append({
            "role": "assistant",
            "content": assistant_content,
            "tool_calls": [{
                "id": s["id"] or str(i), "type": "function",
                "function": {"name": s["name"], "arguments": s["args"]},
            } for i, s in enumerate(ordered)],
        })
        for i, s in enumerate(ordered):
            try:
                args = json.loads(s["args"]) if s["args"].strip() else {}
            except Exception:
                args = {}
            if emit_status:
                yield {"type": "status", "tool": s["name"],
                       "label": _tool_status_label(s["name"], args),
                       **_tool_status_fields(s["name"], args)}
            try:
                result = execute_tool(s["name"], args)
            except Exception as e:
                result = json.dumps({"error": str(e)})
            if not isinstance(result, str):
                result = json.dumps(result)
            if emit_results:
                yield {"type": "tool_result", "tool": s["name"], "result": result}
            if emit_status:
                outcome = _tool_outcome_event(s["name"], result)
                if outcome:
                    yield outcome
            messages.append({
                "role": "tool", "tool_call_id": s["id"] or str(i), "content": result,
            })

        # One corrective nudge per turn when a textual call had to be recovered —
        # the rewritten history shows the right form; this says so explicitly.
        if not tool_calls and not nudged_about_textual_calls:
            nudged_about_textual_calls = True
            messages.append({"role": "system", "content": (
                "Reminder: your previous tool call was written as plain text in "
                "your reply and had to be recovered. Invoke tools only through "
                "the tool-calling interface — reply text never executes.")})

