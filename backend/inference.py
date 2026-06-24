import os
import requests
from typing import List, Dict

LLM_ENDPOINT = os.environ.get("LLM_ENDPOINT", "http://<inference-host>:1234/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen/qwen3-coder-next")


def call_llm(message: str, context_turns: List[Dict] = None) -> str:
    """
    Call the local LLM endpoint with a message and optional context.
    
    Args:
        message: The user's input message
        context_turns: List of previous turns to include in context
    
    Returns:
        The model's response as a string
    """
    # Build the prompt with context
    if context_turns and len(context_turns) > 0:
        # Add system prompt for assistant role
        messages = [
            {"role": "system", "content": "You are Collaborator, a helpful assistant."}
        ]
        
        # Add context from previous turns
        for turn in context_turns:
            if turn.get("role") == "user":
                messages.append({"role": "user", "content": turn["content"]})
            elif turn.get("role") == "assistant":
                messages.append({"role": "assistant", "content": turn["content"]})
        
        # Add current user message
        messages.append({"role": "user", "content": message})
    else:
        # No context, just the user message
        messages = [
            {"role": "system", "content": "You are Collaborator, a helpful assistant."},
            {"role": "user", "content": message}
        ]
    
    # Build the request payload
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "temperature": 0.7
    }
    
    try:
        # Call the LLM endpoint
        response = requests.post(f"{LLM_ENDPOINT}/chat/completions", json=payload, timeout=60)
        response.raise_for_status()
        
        # Parse the response
        data = response.json()
        
        if "choices" in data and len(data["choices"]) > 0:
            return data["choices"][0]["message"]["content"]
        else:
            raise ValueError("No response choices returned from LLM")
            
    except requests.exceptions.RequestException as e:
        raise ConnectionError(f"Failed to connect to LLM endpoint: {e}")
    except Exception as e:
        raise RuntimeError(f"Error calling LLM: {e}")


def get_available_models() -> List[str]:
    """Get list of available models from the LLM endpoint."""
    try:
        response = requests.get(f"{LLM_ENDPOINT}/models", timeout=5)
        response.raise_for_status()
        
        data = response.json()
        if "data" in data:
            return [model["id"] for model in data["data"]]
        return []
        
    except Exception as e:
        print(f"Warning: Could not fetch models from LLM endpoint: {e}")
        return [LLM_MODEL]  # Return default model if fetch fails