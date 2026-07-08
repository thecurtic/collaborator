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


# Initialize from config (cached)
def _get_config():
    """Get configuration with caching."""
    if not hasattr(_get_config, "_config"):
        _get_config._config = get_config()
    return _get_config._config


def _get_endpoint_url() -> str:
    """Get LLM endpoint URL from config."""
    return _get_config()["inference"]["endpoint_url"]


def _get_model_id() -> str:
    """Get model ID from config."""
    return _get_config()["inference"]["model_id"]


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

    # Ground the model in the present — every turn, filled at send time.
    datetime_text = _load_prompt_layer(
        system_prompt, "datetime_file", "datetime_text", DEFAULT_DATETIME_TEXT)
    now = time.strftime("%A, %Y-%m-%d %H:%M %Z")
    system_content = f"{system_content}\n\n{datetime_text.replace('{now}', now)}"

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

    # Add context from previous turns
    if context_turns and len(context_turns) > 0:
        for turn in context_turns:
            if turn.get("role") == "user":
                messages.append({"role": "user", "content": turn["content"]})
            elif turn.get("role") == "assistant":
                messages.append({"role": "assistant", "content": turn["content"]})

    # Add current user message
    messages.append({"role": "user", "content": message})
    return messages


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

    messages = _build_messages(message, context_turns, mode=mode, recall=recall)
    payload = _build_payload(messages, stream=True)

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
                if "choices" in data and len(data["choices"]) > 0:
                    delta = data["choices"][0].get("delta", {})
                    content = delta.get("content", "")
                    if content:
                        yield content

    except requests.exceptions.Timeout:
        raise ConnectionError("LLM endpoint timeout after 60 seconds")
    except requests.exceptions.ConnectionError as e:
        raise ConnectionError(f"Failed to connect to LLM endpoint at {_get_endpoint_url()}: {e}")
    except requests.exceptions.RequestException as e:
        raise ConnectionError(f"Request to LLM endpoint failed: {e}")


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
        "model": inference_config["model_id"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": rc.get("synthesis_temperature", 0.3),
        "max_tokens": rc.get("synthesis_max_tokens", 256),
        "stream": False,
    }

    try:
        response = requests.post(
            f"{_get_endpoint_url()}/chat/completions",
            json=payload,
            timeout=rc.get("synthesis_timeout", 60),
        )
        response.raise_for_status()
        data = response.json()
        return (data["choices"][0]["message"]["content"] or "").strip()
    except Exception as e:
        print(f"Warning: recall synthesis failed: {e}")
        return ""


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
                        "title": {"type": "string"},
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
        "model": _get_config()["inference"]["model_id"],
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
    content = response.json()["choices"][0]["message"]["content"] or ""

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

def web_search_searxng(query: str) -> Dict:
    """Query the configured SearXNG instance (JSON API) and return compact results.

    Config: tools.web_search {url (required to enable the tool), results, timeout,
    language, safesearch}. SearXNG must have the json format enabled in its
    settings.yml (search.formats: [html, json]).
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

    limit = wcfg.get("results", 5)
    out = {"results": [{
        "title": r.get("title"),
        "url": r.get("url"),
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


def fetch_url(url: str) -> Dict:
    """Fetch a URL and return readable text + hyperlinks for the model.

    Config: tools.fetch_url {max_chars, timeout, allow_private, max_links, proxy}.
    Only http(s); private/internal hosts are refused unless allow_private is set
    (the user may want tailnet docs fetchable). Static HTML / text / JSON only —
    JS-rendered apps come back mostly empty (that would need a headless browser).

    PRIVACY NOTE: unlike web_search (whose SearXNG instance routes outbound through
    WireGuard), fetches go DIRECT from this machine by default — every fetched page
    sees this box's IP. Set tools.fetch_url.proxy (http:// or socks5h://, e.g. Tor
    on the search box or this host) to route fetches through a VPN/Tor instead.
    SOCKS proxies need the 'requests[socks]' extra (PySocks).
    """
    from urllib.parse import urlparse

    fcfg = (_tools_config().get("fetch_url") or {})
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        return {"error": f"only http(s) URLs can be fetched, got {url!r}"}
    if not fcfg.get("allow_private", False) and _host_is_private(parsed.hostname or ""):
        return {"error": "refusing to fetch a private/internal address "
                         "(enable tools.fetch_url.allow_private for tailnet/LAN URLs)"}

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
        "model": inference_config["model_id"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": tcfg.get("temperature", 0.3),
        "max_tokens": tcfg.get("max_tokens", 256),
        "stream": False,
    }
    try:
        response = requests.post(
            f"{_get_endpoint_url()}/chat/completions",
            json=payload, timeout=tcfg.get("timeout", 60),
        )
        response.raise_for_status()
        return (response.json()["choices"][0]["message"]["content"] or "").strip()
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
    if name == "web_search":
        return f"Searching the web{f' for “{q[:40]}”' if q else ''}…"
    if name == "fetch_url":
        u = (args.get("url") or "").strip()
        return f"Reading {u[:60]}…" if u else "Reading a page…"
    return f"Running {name}…"


def _tool_status_fields(name: str, args: Dict) -> Dict:
    """Structured fields for the status SSE event (frontend renders these directly,
    instead of parsing the human-readable label)."""
    fields = {}
    q = (args.get("query") or "").strip()
    if q:
        fields["query"] = q
    if name == "fetch_url" and (args.get("url") or "").strip():
        fields["url"] = args["url"].strip()
    if name == "get_note" and (args.get("title") or "").strip():
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
        n = len(data.get("results") or [])
        if n == 0:
            return {"type": "status", "tool": name, "outcome": "empty", "count": 0,
                    "label": "Web search returned no results."}
        return {"type": "status", "tool": name, "outcome": "ok", "count": n,
                "label": f"Web search returned {n} result{'s' if n != 1 else ''}."}
    if name == "fetch_url":
        title = (data.get("title") or "").strip()
        return {"type": "status", "tool": name, "outcome": "ok",
                "label": f"Read page{f': “{title[:60]}”' if title else ''}."}
    return None


def _parse_textual_tool_calls(text: str, known_names) -> List[Dict]:
    """Recover tool calls the model wrote as plain text instead of structured
    tool_calls deltas (some models occasionally do this). Accepts bare JSON,
    ```json fences, <tool_call> wrappers, and qwen's XML-style
    <function=name><parameter=key>value</parameter></function> format. Returns
    [{"name", "args"}, ...] or [] when the text is not a recognizable tool call."""
    import json as _json
    import re as _re
    s = (text or "").strip()
    s = _re.sub(r"^```(?:json)?\s*|\s*```$", "", s).strip()
    s = _re.sub(r"^<tool_call>\s*|\s*</tool_call>$", "", s).strip()

    # qwen3-style XML tool call.
    if s.startswith("<function="):
        calls = []
        for m in _re.finditer(r"<function=([\w.-]+)>(.*?)(?:</function>|$)", s, _re.S):
            name = m.group(1)
            if name not in known_names:
                return []
            args = {k: v.strip() for k, v in
                    _re.findall(r"<parameter=([\w.-]+)>\s*(.*?)\s*</parameter>",
                                m.group(2), _re.S)}
            calls.append({"name": name, "args": args})
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
        if obj.get("choices"):
            choice = obj["choices"][0]
            yield choice, (choice.get("delta") or {})


def generate_with_tools(
    message: str,
    context_turns: Optional[List[Dict]],
    mode: Optional[str],
    tool_schemas: List[Dict],
    execute_tool,
    max_rounds: int = 5,
    emit_status: bool = True,
    emit_results: bool = False,
):
    """Run the tool-calling loop and yield event dicts.

    Yields {"type": "token"|"status"|"tool_result"|"error", ...}. The model may
    call tools (executed via execute_tool(name, args) -> str, fed back, repeat);
    the final answer streams as token events. Capped at max_rounds, after which a
    tools-off round forces an answer.
    """
    import json
    messages = _build_messages(message, context_turns, mode=mode,
                               include_tools_guidance=bool(tool_schemas))

    # Tool-calling is more reliable at a lower temperature than the conversational
    # default, so run the loop at a configurable tools temperature.
    tools_temp = _tools_config().get("temperature", 0.3)

    known_names = {s["function"]["name"] for s in tool_schemas}

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

        # Some models occasionally write their tool call as plain text ("{...}")
        # instead of a structured tool_calls delta. Streaming that JSON to the user
        # is the "reply is one raw JSON blob" bug — so hold back content that looks
        # like it might be one, and decide at end of round: execute it as a tool
        # call if it parses as one, otherwise flush it as normal tokens.
        content_parts: List[str] = []
        held: List[str] = []          # tokens held back pending the JSON check
        holding = None                # None = undecided, True = holding, False = passthrough
        tool_calls: Dict[int, Dict] = {}
        try:
            for choice, delta in _iter_stream_events(payload):
                content = delta.get("content")
                if content:
                    content_parts.append(content)
                    if holding is None:
                        lead = ("".join(held) + content).lstrip()
                        if not lead:
                            held.append(content)
                            continue
                        holding = lead.startswith(("{", "[", "```", "<tool_call", "<function"))
                        if not holding:
                            for h in held:
                                yield {"type": "token", "content": h}
                            held = []
                    if holding:
                        held.append(content)
                    else:
                        yield {"type": "token", "content": content}
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
            yield {"type": "error", "detail": f"LLM request failed: {e}"}
            return
        except Exception as e:
            yield {"type": "error", "detail": f"Error during generation: {e}"}
            return

        held_text = "".join(held)
        recovered = (_parse_textual_tool_calls(held_text, known_names)
                     if (holding and held_text) else [])

        if not tool_calls and recovered and not use_tools:
            # Final forced round and the model STILL answered with a tool call.
            # Never show the raw blob; admit the situation honestly instead.
            yield {"type": "token", "content": (
                "I ran out of tool calls this turn before reaching a definitive "
                "answer. Ask me to continue and I'll pick up from here.")}
            return

        if not tool_calls and not recovered:
            if held_text:
                # Held-back content turned out not to be a tool call — deliver it.
                yield {"type": "token", "content": held_text}
            return  # final answer already streamed as token events

        if tool_calls:
            if held_text and not recovered:
                yield {"type": "token", "content": held_text}
            ordered = [tool_calls[i] for i in sorted(tool_calls)]
            assistant_content = "".join(content_parts) or None
        else:
            # The model wrote its tool call as plain text; execute it instead of
            # showing the raw JSON to the user.
            ordered = [{"id": None, "name": c["name"], "args": json.dumps(c["args"])}
                       for c in recovered]
            assistant_content = None

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

