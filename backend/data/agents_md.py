"""Load AGENTS.md content for exposure to frontend."""

import os

from config import resolve_path, get_config


def load_agents_md() -> str:
    """Load the AGENTS.md content from project root."""
    try:
        # Try to load from project root
        agents_path = resolve_path("AGENTS.md")
        if os.path.exists(agents_path):
            with open(agents_path, 'r') as f:
                return f.read().strip()
    except Exception as e:
        print(f"Warning: Could not load AGENTS.md: {e}")
    
    return "AGENTS.md file not found or could not be loaded." if os.path.exists(resolve_path("AGENTS.md")) else ""


if __name__ == "__main__":
    print(load_agents_md()[:200] + "..." if len(load_agents_md()) > 200 else load_agents_md())
