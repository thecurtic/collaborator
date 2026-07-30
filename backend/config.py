"""Configuration loader for Collaborator backend.

Two files, both at the project root, both gitignored:
- config.yaml — YOUR config. Copy config.yaml.example and edit. Never committed,
  so no git operation can revert it and secrets can't leak into history.
- .config.yaml — app-written overrides (e.g. PUT /api/model persists here so it
  never has to rewrite your hand-edited file). Don't edit by hand.

Precedence: built-in defaults < config.yaml < .config.yaml < environment vars.
config.yaml.example (tracked) is the documented template for every setting.
"""

import os
import yaml


def get_project_root() -> str:
    """Get the project root directory (one level up from backend/).
    
    For a module in /repo/backend/, returns /repo.
    Uses dirname(dirname(abspath(__file__))) which goes:
      - __file__ = /repo/backend/config.py
      - dirname(__file__) = /repo/backend  
      - dirname(dirname(__file__)) = /repo
    """
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def resolve_path(path: str) -> str:
    """Resolve a path - absolute paths pass through, relative paths joined to project root.
    
    Args:
        path: Path string (absolute or relative)
        
    Returns:
        Absolute path if input was absolute, otherwise project_root + path
        
    Note: Relative paths are interpreted relative to PROJECT ROOT (repo root),
    not relative to the current working directory or the calling module.
    """
    if os.path.isabs(path):
        return path
    return os.path.join(get_project_root(), path)


def load_config() -> dict:
    """Load configuration from config.yaml with fallback to env vars and defaults.
    
    Returns:
        dict containing all configuration values
    """
    # Default configuration - use relative paths that work on any machine
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
            "default_context_window": 20,
            # Token budget for the whole prompt. None = auto-detect the active
            # model's context from LM Studio (/api/v0/models), falling back to
            # a conservative 30k. Turns select the window; tokens trim it so a
            # few very long turns can't blow past the model's context.
            "context_budget_tokens": None,
            "db_path": resolve_path("backend/data/conversations.db")
        },
        "server": {
            "backend_host": "0.0.0.0",
            "backend_port": 8001,
            "cors_origins": ["http://localhost:3000"]
        },
        "authentication": {
            "enabled": True,
            "passkeys_db_path": resolve_path("backend/data/authentication/passkeys.db"),
            "users_dir": resolve_path("backend/data/users")
        },
        "system_prompt": {
            "text": "You are Collaborator, a helpful assistant.",
            "file_path": None,
            # Auditable prompt layers appended to the base prompt (markdown files,
            # read fresh each turn). paragraph_file always; voice_file in voice mode.
            "paragraph_file": "paragraph-style.md",
            "voice_file": "voice-style.md",
        },
        "recall": {
            "enabled": False,
            "embedding_backend": "local",  # "local" (fastembed) or "lmstudio"
            "embedding_model_local": "BAAI/bge-small-en-v1.5",  # used when backend=local
            "embedding_model": "text-embedding-nomic-embed-text-v1.5",  # used when backend=lmstudio
            "search_limit": 10,
            "synthesis_max_tokens": 256,
            # Editable/auditable synthesis system prompt (markdown file, like
            # system-prompt.md). Falls back to a built-in default if missing.
            "synthesis_prompt_file": "recall-synthesis-prompt.md",
            "tag_boosts": {
                "decision": 1.5,
                "open_question": 1.2,
                "concept": 1.3,
                "reference": 1.4,
                "emotion": 1.1,
            },
        },
        "notes": {
            # Where vaults of APPROVED notes live (NOTES-FORMAT.md). Vaults are
            # ALWAYS per-user: under auth each user's vault is <vault_dir>/<hash>;
            # without auth vault_dir is the (single) vault itself. When None, vaults
            # sit next to the conversation DB (users/{hash}/notes, else
            # backend/data/notes).
            "vault_dir": None,
            # Tree -> note-drafts synthesis (POST /api/notes/synthesize/{tree_id}).
            "synthesis_prompt_file": "synthesis-notes.md",  # editable/auditable
            "synthesis_max_tokens": 4096,
            "synthesis_temperature": 0.3,
            "synthesis_timeout": 300,
            # Dedupe-against-vault: existing notes shown to the synthesis LLM, and
            # candidates flagged (never dropped) when semantically near an existing
            # note. duplicate_of appears on the draft for review.
            "dedupe_threshold": 0.85,
            "dedupe_context_notes": 30,
        },
        "voice": {
            # Server voice tier (see voice.py). Advertised via GET /api/health
            # capabilities; the frontend falls back to its on-device stack per
            # engine when a capability is absent.
            "stt": {
                "enabled": True,             # False = never advertise/serve streaming STT
                # "local" runs faster-whisper in this process; "openai" delegates to
                # any OpenAI-compatible /v1/audio server (e.g. speaches on the
                # inference machine — LM Studio itself has no audio endpoints).
                "backend": "local",
                "api_url": None,             # e.g. "http://<inference-host>:8000/v1" (backend: openai)
                "api_key": None,
                "remote_partial_timeout": 15,
                "remote_final_timeout": 120,
                "partial_model": "small",    # rolling partials (speed matters); remote: the server's model id
                "final_model": "small",      # final pass (accuracy matters); remote: the server's model id
                "device": "cpu",             # cpu | cuda (local backend)
                "compute_type": "int8",      # int8 (cpu) | float16 (gpu) (local backend)
                "preload": False,            # True: warm-load at startup (remote: probe the server)
                "partial_interval_ms": 400,  # decode cadence (per newly received audio)
                "window_seconds": 15,        # uncommitted rolling window per partial decode
                "commit_keep_seconds": 6,    # audio kept uncommitted when the window overflows
                "final_full_pass_seconds": 90,  # sessions up to this get a full final-model re-decode
            },
            "phrases": {
                # In-stream phrase detection (end / interrupt). The silence gate
                # only CONFIRMS a matched phrase — it never ends a turn by itself.
                "silence_ms": 350,               # trailing quiet required to fire
                "max_word_distance": 1,          # per-word edit tolerance (words > 3 chars)
                "silence_rms_floor": 100,        # absolute int16-RMS silence threshold
                "silence_floor_multiplier": 2.5,  # x adaptive noise floor, whichever is higher
            },
            "tts": {
                "enabled": True,       # False = never advertise/serve TTS
                # "local" runs Piper in this process; "openai" proxies an
                # OpenAI-compatible /v1/audio/speech server (speaches: Kokoro/Piper).
                "backend": "local",
                "api_url": None,       # e.g. "http://<inference-host>:8000/v1" (backend: openai)
                "api_key": None,
                "model": None,         # remote TTS model id (e.g. "speaches-ai/Kokoro-82M-v1.0-ONNX")
                # Voices are DISCOVERED from the sidecar (GET /audio/voices) —
                # every voice the model ships is offered automatically.
                # remote_voices, when set, curates the picker to those names
                # (also the fallback list if discovery ever fails).
                "remote_voices": [],
                "remote_sample_rate": 24000,  # PCM rate the remote emits (Kokoro 24000, Piper 22050)
                "remote_timeout": 120,
                "engine": "piper",     # local backend engine (only piper for now)
                "voices_dir": None,    # local: dir of <voice>.onnx + .onnx.json; None = TTS off
                "default_voice": None, # local: filename stem; remote: server voice name
                "preload": False,      # local backend: warm-load the default voice at startup
            },
        },
        "location": {
            # Per-turn location context (frontend sends {lat, lon, accuracy, ts}
            # on /api/messages when granted). Raw coordinates only — no
            # geocoding, nothing leaves this machine; OSM browsing comes later.
            "store": False,   # True: also persist location on user turn rows
        },
        "titles": {
            # Auto-generated conversation titles on ROOT turns (seeds and trees
            # alike; separate from the user-set name, which always wins in the UI).
            # Generated after an exchange completes; lazily regenerated once the
            # tree has grown by regenerate_after_turns since the last title.
            "enabled": True,
            "regenerate_after_turns": 6,
            "temperature": 0.3,
            "max_tokens": 24,
            "timeout": 30,
            # Optional dedicated model for title generation (e.g. a small qwen).
            # Recommended when the chat model is large: faster titles, and the
            # post-turn title call stops evicting the chat model's KV cache.
            "model": None,
            "prompt_file": "title-prompt.md",  # editable/auditable, like other layers
        },
        "tools": {
            "enabled": False,          # master switch; false = plain chat, no tools
            "status_notes": True,      # emit a short "what it's doing" per tool step
            "show_step_results": False,  # also emit each tool's raw results
            "max_rounds": 12,
            "temperature": 0.3,        # lower temp -> more reliable tool calls
            "guidance_file": "tools-guidance.md",  # editable "when to use tools" instruction
            "spec_file": "tools-spec.md",          # editable per-tool descriptions the model sees
            "auto_recall_fallback": False,  # reserved: auto-run recall if model calls nothing
            "available": {
                "recall_semantic": True,
                "recall_keyword": True,
                "synthesize": True,
                "search_notes": True,
                "get_note": True,
                "propose_note": True,  # only ever creates PENDING drafts
                "propose_edit": True,  # edits to existing notes -> PENDING drafts too
                "web_search": True,    # self-gating: active only when web_search.url is set
                "fetch_url": True,     # read a specific page (pasted links)
                "screenshot_page": True,  # self-gating: needs webtool_url + a vision model
                "list_events": True,   # calendar window over notes tagged 'event'
                "get_notes": True,     # batch note reads (graph traversal)
                "graph_notes": True,   # BFS subgraph around a note (links+backlinks)
                "calculate": True,     # AST-whitelisted arithmetic (no eval)
                "git_read": True,      # self-gating: needs tools.git.api_url + token
                "transcribe_video": True,  # yt-dlp audio -> STT (never captions)
                "read_logs": True,     # agent can read its own recent server logs
            },
            "git": {
                # Read-only forge access (Gitea; GitHub API-compatible for these
                # routes). The git_read tool registers only when BOTH are set.
                "api_url": None,       # e.g. "http://<gitea-host>:3000/api/v1"
                "token": None,         # READ-ONLY token (set in .config.yaml)
                "max_chars": 20000,
                "timeout": 15,
            },
            "transcribe_video": {
                "sync_max_minutes": 10,   # <= this: transcript returned in-turn
                "max_minutes": 240,       # hard cap (raise if you really want more)
                "return_chars": 15000,    # transcript chars handed to the model
                "proxy": None,            # yt-dlp egress proxy (else direct)
            },
            "web_search": {
                "url": None,           # SearXNG base URL (e.g. tailnet IP); None = tool off
                "results": 5,
                "timeout": 15,
                "language": "en",
                "safesearch": 0,
            },
            "fetch_url": {
                "max_chars": 8000,     # readable text handed to the model
                "timeout": 20,
                "allow_private": False,  # True to let it fetch tailnet/LAN URLs
                "max_links": 40,       # hyperlinks returned per page (enables follow-up fetches)
                "max_per_turn": 10,    # hard fetch budget per message
                "same_domain_only": False,  # True: follow-up fetches stay on the first host
                # PREFERRED: the search VM's Playwright fetch service ("webtool").
                # When set, all page fetches go through it — headless Chromium that
                # egresses via the VM's VPN (pages never see this box's IP) and
                # renders JS-heavy pages. Fails CLOSED when unreachable (no silent
                # direct fetch). e.g. "http://<search-vm-ip>:8200"
                "webtool_url": None,
                "webtool_timeout": 60,   # >= 45s recommended (30s nav + render)
                "webtool_wait_ms": 0,    # extra JS settle time; empty pages auto-retry at 2500
                # Fallback for DIRECT fetches only (webtool_url unset): route them
                # through an HTTP/SOCKS proxy (socks needs requests[socks]).
                "proxy": None,
            },
            "screenshot": {
                # Visual page analysis: webtool /screenshot (full-page PNG via the
                # search VM's VPN) -> LM Studio vision model. The vision model is
                # loaded on demand by LM Studio (JIT) — first call is slow.
                "vision_model": None,   # e.g. "llava-v1.6-34b"; None = tool off
                "temperature": 0.2,
                "max_tokens": 512,
                "timeout": 180,         # headroom for on-demand model load
                "text_chars": 2000,     # page-text excerpt returned alongside
            },
            "synthesis": {
                "max_tokens": 256,
                "prompts": {
                    "memory": "recall-synthesis-prompt.md",
                    "web": "synthesis-web.md",
                },
            },
        }
    }
    
    config = defaults.copy()
    
    # Load from config.yaml if exists
    # Search for config.yaml in common locations
    project_root = None
    
    # Try common relative paths from backend directory
    possible_paths = [
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.yaml"),
        resolve_path("config.yaml"),
    ]
    
    for path in possible_paths:
        if os.path.exists(path):
            project_root = os.path.dirname(path)
            config_path = path
            break
    else:
        # If no config.yaml found, use the default project path
        project_root = get_project_root()
        config_path = os.path.join(project_root, "config.yaml")
    
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as f:
                file_config = yaml.safe_load(f)
                if file_config:
                    # Deep merge (config values will be relative, need to resolve after)
                    config = deep_merge(config, file_config)
                    
                    # Resolve all path values in authentication section
                    if "authentication" in config:
                        auth_section = config["authentication"]
                        for key in ["passkeys_db_path", "users_dir"]:
                            if key in auth_section and auth_section[key]:
                                auth_section[key] = resolve_path(auth_section[key])
                    
                    # Resolve path in memory section
                    if "memory" in config and "db_path" in config["memory"]:
                        config["memory"]["db_path"] = resolve_path(config["memory"]["db_path"])
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
                        
                        # Resolve path values in overriden sections
                        if "authentication" in dot_config:
                            auth_section = config.get("authentication", {})
                            for key in ["passkeys_db_path", "users_dir"]:
                                if key in auth_section and auth_section[key]:
                                    auth_section[key] = resolve_path(auth_section[key])
                        
                        if "memory" in dot_config and "db_path" in dot_config["memory"]:
                            config["memory"]["db_path"] = resolve_path(dot_config["memory"]["db_path"])
                            
            except yaml.YAMLError as e:
                print(f"Warning: Failed to parse .config.yaml at {dot_config_path}: {e}")
            except IOError as e:
                print(f"Warning: Failed to read .config.yaml at {dot_config_path}: {e}")
    
    # Override with environment variables (highest precedence)
    _apply_env_overrides(config)
    
    # Read system prompt from file if specified
    if config.get("system_prompt", {}).get("file_path"):
        try:
            file_path = resolve_path(config["system_prompt"]["file_path"])
            with open(file_path, 'r', encoding='utf-8') as f:
                config["system_prompt"]["text"] = f.read().strip()
        except IOError as e:
            print(f"Warning: Failed to read system prompt file at {file_path}: {e}")
    
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
        config["memory"]["db_path"] = resolve_path(os.environ["DB_PATH"])
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
    
    # Resolve any remaining path env vars
    if os.environ.get("AUTH_PASSKEYS_DB"):
        config["authentication"]["passkeys_db_path"] = resolve_path(os.environ["AUTH_PASSKEYS_DB"])
    if os.environ.get("AUTH_USERS_DIR"):
        config["authentication"]["users_dir"] = resolve_path(os.environ["AUTH_USERS_DIR"])


def get_config() -> dict:
    """Get cached configuration (singleton pattern)."""
    if not hasattr(get_config, "_config"):
        get_config._config = load_config()
    return get_config._config
