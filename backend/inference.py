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
) -> List[Dict]:
    """Build the OpenAI-style messages array from system prompt, context, and input.

    When mode == "voice", the system prompt is augmented with a spoken-style
    instruction (configurable via system_prompt.voice_text, else a sensible default).
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
):
    """Yield tokens from the local LLM endpoint as they arrive (true streaming).

    Args:
        message: The user's input message
        context_turns: List of previous turns to include in context
        mode: Turn mode ("voice" augments the system prompt for spoken style)

    Yields:
        Content fragments (tokens) as they are produced by the model.

    Raises:
        ConnectionError / RuntimeError on transport or unexpected errors. These
        may surface before the first token or partway through iteration.
    """
    import json

    messages = _build_messages(message, context_turns, mode=mode)
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

