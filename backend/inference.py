"""LLM inference proxy for Collaborator backend.

Wraps local LLM endpoint calls with retry logic, error handling,
and context-aware messaging.
"""

import os
import requests
from typing import List, Dict, Optional
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


def call_llm(
    message: str,
    context_turns: Optional[List[Dict]] = None,
    stream: bool = False
) -> str:
    """
    Call the local LLM endpoint with a message and optional context.
    
    Args:
        message: The user's input message
        context_turns: List of previous turns to include in context
        stream: Whether to use streaming (currently returns full response)
    
    Returns:
        The model's response as a string
    
    Raises:
        ConnectionError: If unable to connect to LLM endpoint
        RuntimeError: For other errors during LLM call
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
    
    # Add streaming if enabled
    if stream:
        payload["stream"] = True
    
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
            return call_llm(message, context_turns)
        except ConnectionError as e:
            last_error = e
            if attempt < max_retries:
                print(f"Connection failed (attempt {attempt + 1}/{max_retries}), retrying...")
                continue
            raise ConnectionError(f"Failed after {max_retries + 1} attempts: {last_error}")
        except RuntimeError as e:
            # Don't retry on runtime errors (likely not connection issues)
            raise
