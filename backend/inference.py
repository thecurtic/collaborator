"""LLM inference proxy for Collaborator backend.

Wraps local LLM endpoint calls with retry logic, error handling,
and context-aware messaging. Supports both streaming and non-streaming modes.
"""

import os
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


def _load_prompt_layer(cfg: Dict, file_key: str, text_key: str, default: str) -> str:
    """Resolve a system-prompt layer: markdown file -> inline config string -> default.

    Read fresh each call so edits to the layer files take effect without a restart
    (unlike system-prompt.md, which config caches at startup).
    """
    file_path = cfg.get(file_key)
    if file_path:
        try:
            with open(resolve_path(file_path), "r", encoding="utf-8") as f:
                text = f.read().strip()
                if text:
                    return text
        except IOError:
            pass
    return cfg.get(text_key) or default


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
    return out


# --- URL fetching (read a page the user pasted) --------------------------------

class _HtmlTextExtractor:
    """Stdlib HTML -> readable text (no extra deps, per the minimal-deps principle)."""

    def __init__(self):
        from html.parser import HTMLParser

        skip_tags = {"script", "style", "noscript", "svg", "template", "iframe"}
        block_tags = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5",
                      "h6", "section", "article", "header", "footer", "ul", "ol",
                      "table", "blockquote", "pre"}

        class Parser(HTMLParser):
            def __init__(self):
                super().__init__(convert_charrefs=True)
                self.parts, self.title = [], ""
                self._skip, self._in_title = 0, False

            def handle_starttag(self, tag, attrs):
                if tag in skip_tags:
                    self._skip += 1
                elif tag == "title":
                    self._in_title = True
                elif tag in block_tags:
                    self.parts.append("\n")

            def handle_endtag(self, tag):
                if tag in skip_tags and self._skip > 0:
                    self._skip -= 1
                elif tag == "title":
                    self._in_title = False
                elif tag in block_tags:
                    self.parts.append("\n")

            def handle_data(self, data):
                if self._skip:
                    return
                if self._in_title:
                    self.title += data
                else:
                    self.parts.append(data)

        self._parser = Parser()

    def extract(self, html: str):
        import re
        self._parser.feed(html)
        text = "".join(self._parser.parts)
        lines = [" ".join(l.split()) for l in text.splitlines()]
        text = "\n".join(l for l in lines if l)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return self._parser.title.strip(), text.strip()


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
    """Fetch a URL and return readable text for the model.

    Config: tools.fetch_url {max_chars, timeout, allow_private}. Only http(s);
    private/internal hosts are refused unless allow_private is set (the user may
    want tailnet docs fetchable). Static HTML / text / JSON only — JS-rendered
    apps come back mostly empty (that would need a headless browser).
    """
    from urllib.parse import urlparse

    fcfg = (_tools_config().get("fetch_url") or {})
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        return {"error": f"only http(s) URLs can be fetched, got {url!r}"}
    if not fcfg.get("allow_private", False) and _host_is_private(parsed.hostname or ""):
        return {"error": "refusing to fetch a private/internal address "
                         "(enable tools.fetch_url.allow_private for tailnet/LAN URLs)"}

    try:
        response = requests.get(
            url,
            timeout=fcfg.get("timeout", 20),
            headers={"User-Agent": "Collaborator/0.2 (self-hosted personal assistant)"},
            stream=True,
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
    title = ""
    if ctype in ("text/html", "application/xhtml+xml", ""):
        try:
            title, body = _HtmlTextExtractor().extract(body)
        except Exception:
            pass  # fall back to the raw text

    max_chars = fcfg.get("max_chars", 8000)
    truncated = len(body) > max_chars
    return {
        "url": response.url,
        "title": title,
        "content": body[:max_chars],
        "truncated": truncated,
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

    for round_index in range(max_rounds + 1):
        # Last iteration: drop tools so the model must produce a final answer.
        use_tools = tool_schemas and round_index < max_rounds
        payload = _build_payload(messages, stream=True)
        payload["temperature"] = tools_temp
        if use_tools:
            payload["tools"] = tool_schemas
            payload["tool_choice"] = "auto"

        content_parts: List[str] = []
        tool_calls: Dict[int, Dict] = {}
        try:
            for choice, delta in _iter_stream_events(payload):
                content = delta.get("content")
                if content:
                    content_parts.append(content)
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

        if not tool_calls:
            return  # final answer already streamed as token events

        # Record the assistant's tool-call message, then execute each call.
        ordered = [tool_calls[i] for i in sorted(tool_calls)]
        messages.append({
            "role": "assistant",
            "content": "".join(content_parts) or None,
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
                yield {"type": "status", "tool": s["name"], "label": _tool_status_label(s["name"], args)}
            try:
                result = execute_tool(s["name"], args)
            except Exception as e:
                result = json.dumps({"error": str(e)})
            if not isinstance(result, str):
                result = json.dumps(result)
            if emit_results:
                yield {"type": "tool_result", "tool": s["name"], "result": result}
            messages.append({
                "role": "tool", "tool_call_id": s["id"] or str(i), "content": result,
            })

