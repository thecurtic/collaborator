"""LLM inference proxy for Collaborator backend.

Wraps local LLM endpoint calls with retry logic, error handling,
and context-aware messaging. Supports both streaming and non-streaming modes.
"""

import os
import requests
from typing import List, Dict, Optional, AsyncGenerator, Tuple
from functools import lru_cache

from config import get_config


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
    "When your response covers more than one distinct idea, put each idea in its "
    "own paragraph separated by a blank line, so individual points can be "
    "referenced and branched from separately."
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


def _build_messages(
    message: str,
    context_turns: Optional[List[Dict]] = None,
    mode: Optional[str] = None,
    recall: Optional[str] = None,
) -> List[Dict]:
    """Build the OpenAI-style messages array from system prompt, context, and input.

    Context assembly order: system prompt, recall block (if any), recent window,
    current message. When mode == "voice", the system prompt is augmented with a
    spoken-style instruction (configurable via system_prompt.voice_text).
    """
    config = _get_config()
    system_prompt = config.get("system_prompt", {})
    system_content = system_prompt.get("text", "You are Collaborator, a helpful assistant.")

    # Encourage one-idea-per-paragraph so paragraph-level branching is meaningful.
    paragraph_style = system_prompt.get("paragraph_text") or DEFAULT_PARAGRAPH_STYLE
    system_content = f"{system_content}\n\n{paragraph_style}"

    if mode == "voice":
        voice_style = system_prompt.get("voice_text") or DEFAULT_VOICE_STYLE
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

    system_prompt = rc.get(
        "synthesis_system",
        "You are a memory synthesizer. Combine the related past turns into a concise, "
        "first-person memory block that reads like something the user would remember "
        "about earlier conversations. Be natural and conversational. Do not invent facts.",
    )

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

