"""Configuration loader for Collaborator backend.

Reads settings from config.yaml at project root, with fallback to environment variables
and hardcoded defaults.
"""

import os
import yaml


def load_config() -> dict:
    """Load configuration from config.yaml with fallback to env vars and defaults.
    
    Returns:
        dict containing all configuration values
    """
    # Default configuration
    defaults = {
        "inference": {
            "endpoint_url": "http://<inference-host>:1234/v1",
            "model_id": "qwen/qwen3-coder-next",
            "temperature": 0.7,
            "max_tokens": 2048,
            "thinking_mode": False,
            "streaming": True
        },
        "memory": {
            "default_context_window": 5,
            "db_path": "/home/chat/collaborator/backend/data/conversations.db"
        },
        "server": {
            "backend_host": "0.0.0.0",
            "backend_port": 8001,
            "cors_origins": ["http://localhost:3000"]
        },
        "authentication": {
            "enabled": False,
            "passkeys_db_path": "/home/chat/collaborator/backend/data/authentication/passkeys.db",
            "users_dir": "/home/chat/collaborator/backend/data/users"
        },
        "system_prompt": {
            "text": "You are Collaborator, a helpful assistant.",
            "file_path": None
        }
    }
    
    config = defaults.copy()
    
    # Load from config.yaml if exists
    # Search for config.yaml in common locations
    project_root = None
    
    # Try common relative paths from backend directory
    possible_paths = [
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.yaml"),
        os.path.join(os.getcwd(), "../..", "config.yaml"),  # 2 dirs up from backend
    ]
    
    for path in possible_paths:
        if os.path.exists(path):
            project_root = os.path.dirname(path)
            config_path = path
            break
    else:
        # If no config.yaml found, use the default project path
        project_root = "/home/chat/collaborator"
        config_path = os.path.join(project_root, "config.yaml")
    
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as f:
                file_config = yaml.safe_load(f)
                if file_config:
                    # Deep merge
                    config = deep_merge(config, file_config)
        except yaml.YAMLError as e:
            print(f"Warning: Failed to parse config.yaml at {config_path}: {e}")
        except IOError as e:
            print(f"Warning: Failed to read config.yaml at {config_path}: {e}")
    else:
        print(f"Warning: config.yaml not found at {config_path}, using defaults")
    
    # Load machine-specific override from .config.yaml if exists
    if project_root:
        dot_config_path = os.path.join(project_root, ".config.yaml")
        if os.path.exists(dot_config_path):
            try:
                with open(dot_config_path, 'r') as f:
                    dot_config = yaml.safe_load(f)
                    if dot_config:
                        # Deep merge .config.yaml on top of config.yaml
                        config = deep_merge(config, dot_config)
            except yaml.YAMLError as e:
                print(f"Warning: Failed to parse .config.yaml at {dot_config_path}: {e}")
            except IOError as e:
                print(f"Warning: Failed to read .config.yaml at {dot_config_path}: {e}")
    
    # Override with environment variables (highest precedence)
    _apply_env_overrides(config)
    
    return config


def deep_merge(base: dict, override: dict) -> dict:
    """Deep merge two dictionaries, with override taking precedence."""
    result = base.copy()
    
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    
    return result


def _apply_env_overrides(config: dict) -> None:
    """Override config with environment variables."""
    # Inference
    if os.environ.get("LLM_ENDPOINT"):
        config["inference"]["endpoint_url"] = os.environ["LLM_ENDPOINT"]
    if os.environ.get("LLM_MODEL"):
        config["inference"]["model_id"] = os.environ["LLM_MODEL"]
    if os.environ.get("TEMPERATURE"):
        try:
            config["inference"]["temperature"] = float(os.environ["TEMPERATURE"])
        except ValueError:
            pass
    if os.environ.get("MAX_TOKENS"):
        try:
            config["inference"]["max_tokens"] = int(os.environ["MAX_TOKENS"])
        except ValueError:
            pass
    
    # Memory
    if os.environ.get("DB_PATH"):
        config["memory"]["db_path"] = os.environ["DB_PATH"]
    if os.environ.get("DEFAULT_CONTEXT_WINDOW"):
        try:
            config["memory"]["default_context_window"] = int(os.environ["DEFAULT_CONTEXT_WINDOW"])
        except ValueError:
            pass
    
    # Server
    if os.environ.get("BACKEND_HOST"):
        config["server"]["backend_host"] = os.environ["BACKEND_HOST"]
    if os.environ.get("PORT"):
        try:
            config["server"]["backend_port"] = int(os.environ["PORT"])
        except ValueError:
            pass
    if os.environ.get("CORS_ORIGINS"):
        # Comma-separated list
        origins = [o.strip() for o in os.environ["CORS_ORIGINS"].split(",")]
        config["server"]["cors_origins"] = origins
    
    # Authentication
    if os.environ.get("AUTH_ENABLED"):
        config["authentication"]["enabled"] = os.environ["AUTH_ENABLED"].lower() == "true"


def get_config() -> dict:
    """Get cached configuration (singleton pattern)."""
    if not hasattr(get_config, "_config"):
        get_config._config = load_config()
    return get_config._config
