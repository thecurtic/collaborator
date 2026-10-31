"""Configuration loader for Collaborator backend.

Config is config; settings are settings:
- config.yaml (project root, gitignored) — YOUR config, the only file a human
  edits. Copy config.yaml.example (tracked template) and edit. Never committed,
  so no git operation can revert it and secrets can't leak into history.
- backend/data/app_settings.json — app STATE the app writes itself (e.g. the
  model dropdown). Lives with the other app state; never hand-edited.

Precedence: built-in defaults < config.yaml < app_settings.json < env vars.

(.config.yaml is DEPRECATED: still read, between config.yaml and app settings,
so old installs keep working — fold its values into config.yaml and delete it;
a startup warning nags while it exists.)
"""

import os
import yaml
from typing import Optional


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


def vault_dir_for(db_path: str, configured: Optional[str],
                  auth_enabled: bool) -> str:
    """The notes vault that belongs to a conversation DB (NOTES-FORMAT.md).

    Vaults are ALWAYS per-user — notes never cross passkeys, same isolation as
    the conversation DBs. notes.vault_dir (`configured`) relocates where vaults
    live, it never merges them: under auth each user's vault is
    <vault_dir>/<user-hash>; without auth (single anonymous user) vault_dir is
    the vault itself. When unset, the vault sits next to the conversation DB
    (users/{hash}/notes, else backend/data/notes).
    """
    root = resolve_path(configured) if configured else None
    if auth_enabled:
        # db_path is .../users/{hash}/conversations.db — the hash names the user.
        user_hash = os.path.basename(os.path.dirname(db_path))
        if root:
            return os.path.join(root, user_hash)
        return os.path.join(os.path.dirname(db_path), "notes")
    if root:
        return root
    return os.path.join(os.path.dirname(db_path), "notes")


def load_config() -> dict:
    """Load configuration from config.yaml with fallback to env vars and defaults.
    
    Returns:
        dict containing all configuration values
    """
    # Default configuration - use relative paths that work on any machine
    defaults = {
        "inference": {
            "endpoint_url": "http://localhost:1234/v1",
            "model_id": "qwen/qwen3-coder-next",
            # Optional model for UTILITY calls — ephemeral background output
            # (titles, recall/tool synthesis). A small model here is faster and
            # stops utility calls from evicting the chat model's KV cache after
            # every turn. None = chat model for everything (zero-config).
            # ONE role by design, not per-task knobs. The boundary rule:
            # anything authoring words destined for the VAULT (in-chat note
            # proposals, notes synthesis) uses the chat model; utility covers
            # ephemeral labels/summaries only.
            "utility_model": None,
            # Can the chat model read images (vision.py)? "auto" asks LM
            # Studio (type "vlm" = loaded with its vision projector); true /
            # false for servers that don't say. One vision model by design:
            # attachments, scanned-page OCR and screenshot_page all use it.
            "vision": "auto",
            # The inference gate on the Mac (gate/): the top-bar switch pauses
            # the background agents (Collaborator only) or resumes them (all
            # requests). Collaborator itself never goes through it. url None
            # = no switch shown.
            "gate": {"url": None, "token": None, "timeout": 3},
            # Stream the model's chain-of-thought to the UI as 'reasoning' SSE
            # events (display-only — never saved, never re-prompted). Also
            # keeps proxies from timing out during long thinks; when off, a
            # periodic heartbeat status covers that instead.
            "stream_reasoning": True,
            # OpenAI-style reasoning effort for models that take it (gpt-oss:
            # "low" | "medium" | "high"). None = not sent (other servers 400).
            "reasoning_effort": None,
            "temperature": 0.7,
            # Reasoning models (MiniMax) spend this same budget on thinking
            # BEFORE the answer — 2048 starves them into empty responses.
            "max_tokens": 4096,
            "thinking_mode": False,
            "streaming": True
        },
        "memory": {
            "default_context_window": 20,
            # Tokens of conversation HISTORY per prompt (prior turns only).
            # None = no cap beyond the model: the active model's context is
            # auto-detected from LM Studio (/api/v0/models), falling back to
            # 30k, and always applies. Turns select the window; tokens trim it
            # so a few very long turns can't blow past the model's context.
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
            "users_dir": resolve_path("backend/data/users"),
            # Sessions: what devices hold after one passkey login (revocable,
            # expiring). Idle = sliding window since last use; absolute = hard cap.
            "session_idle_days": 30,
            "session_absolute_days": 90,
            # Lockout: exponential backoff on consecutive failed passkey
            # attempts (new logins only — established sessions keep working).
            "lockout_threshold": 5,
            "lockout_base_seconds": 60,
            "lockout_max_seconds": 3600,
            # The lockout counts per client. Behind reverse proxies every
            # request comes from the proxy, so list them here (addresses or
            # CIDRs): only requests FROM these may name the real client via
            # CF-Connecting-IP / X-Forwarded-For. Empty = trust no header.
            "trusted_proxies": [],
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
            "synthesis_max_tokens": 768,   # reasoning models think first; thinking spends this budget
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
            # Ambient hints: on tools turns, semantic-search the vault for the
            # user's message and inject matching note TITLES (never bodies) as
            # a one-line scent trail in the dynamic system message — converts
            # "remember to search" into "look what's here". No LLM cost (local
            # embedding); the model still decides whether to read.
            "ambient_hints": True,
            "ambient_hints_limit": 3,
            "ambient_hints_threshold": 0.5,
            # Seed USER.md (the profile hub: fixed sections, app-stamped
            # frontmatter) into the vault on reindex when absent.
            "bootstrap_user_note": True,
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
                # False = no end-of-turn re-decode with the final model: the
                # partial transcript IS the message (end-of-turn cost drops to
                # one small window decode). Set when partials prove accurate
                # enough — the final pass is the round-trip's biggest chunk.
                # Batch /api/transcribe and transcribe_video still use
                # final_model regardless.
                "final_pass": True,
                "device": "cpu",             # cpu | cuda (local backend)
                "compute_type": "int8",      # int8 (cpu) | float16 (gpu) (local backend)
                "preload": False,            # True: warm-load at startup (remote: probe the server)
                "partial_interval_ms": 400,  # decode cadence (per newly received audio)
                "window_seconds": 15,        # uncommitted rolling window per partial decode
                "commit_keep_seconds": 6,    # audio kept uncommitted when the window overflows
                "final_full_pass_seconds": 90,  # sessions up to this get a full final-model re-decode
                # A streaming session keeps its audio in memory (~115 MB/hour);
                # past this it finalizes and closes as if the turn had ended.
                "max_session_minutes": 120,
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
        "scratch": {
            # Notes-to-self capture pipe. Inert by default; the LLM touches an
            # item only via POST /api/scratch/{id}/act (the hold-send gesture).
            "max_media_mb": 1024,       # per file (streamed to disk)
            "max_rounds": 4,             # tool rounds for the one-shot action
            "action_prompt_file": "scratch-action-prompt.md",  # editable layer
            # Links show their page title + favicon, YouTube links their
            # title + thumbnail, fetched once in the background on capture
            # (same exit and guards as fetch_url). False: plain URLs, no fetch.
            "link_previews": True,
        },
        "spending": {
            # Receipts held in Scratch become spending rows in spending.db
            # (spending.py): one label-only vision call per held photo.
            # False: every held photo takes the ordinary path.
            "enabled": True,
            "rounding_tolerance": 0.05,  # per arithmetic check (cash rounds to $0.05)
            "classify_max_tokens": 512,  # reasoning models need thinking headroom
            "extract_max_tokens": 4096,
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
            "max_tokens": 512,   # titles are short but reasoning models need thinking headroom
            "timeout": 30,
            # Optional dedicated model for title generation (e.g. a small qwen).
            # Recommended when the chat model is large: faster titles, and the
            # post-turn title call stops evicting the chat model's KV cache.
            "model": None,
            "prompt_file": "title-prompt.md",  # editable/auditable, like other layers
        },
        "agents": {
            # Agent endpoints (agents.py; the agent seam). Endpoints dial in
            # on their OWN listener, never the app's port, so the public
            # reverse proxy can't reach it: bind it to the tailnet address,
            # e.g. "<tailnet-ip>:8765". None = off (no agent endpoints).
            "listen": None,
            "buffer_items": 500,         # live firehose lines kept per channel (memory only)
            "record_runs": True,         # keep each project's run log (usage, firehose, timeline)
            "max_frame_bytes": 1048576,  # largest frame an endpoint may send
            "unreachable_after": 30,     # seconds without a connection before the badge says so
            # The Ed25519 private key that signs team requests (New project,
            # Merge, Withdraw). Made in Settings → Agents; a file of its own,
            # mode 0600, outside everything the model can read.
            "request_signing_key_file": "backend/data/keys/request-signing.key",
        },
        "notifications": {
            # Kinds and their on/off live in the app (settings list, per
            # user); this block is only DELIVERY. Every notification is stored
            # either way. Nothing is sent anywhere until ntfy is configured.
            "app_url": None,       # public URL of this app, for tap-to-open links
            "open_in": "browser",  # "app": taps open the Android app instead
            "ntfy": {
                "url": None,       # your own ntfy server, e.g. "https://<ntfy-host>"
                "token": None,     # access token if the server requires one
                "topics": {},      # per user: identity hash (or "default") -> topic
                "timeout": 10,
            },
        },
        "attachments": {
            # Files attached to chats (attachments.py): stored on the server,
            # content-addressed under the user's data directory; text is
            # extracted once (markitdown, pypdfium2, the chat model's vision,
            # speech-to-text) and stored with the attachment.
            "max_mb": 1024,           # per file (streamed to disk)
            "inline_chars": 12000,    # extracted text sent with the turn it's attached to
            "history_chars": 3000,    # ...and with later turns (read_attachment has the rest)
            "return_chars": 15000,    # per read_attachment part
            "max_text_chars": 500000, # stored text per attachment
            "wait_seconds": 90,       # how long a send waits for text still being read
            "ocr_max_pages": 30,      # scanned PDF pages read by the vision model, per file
            "image_max_side": 1600,   # images are downscaled to this before the model sees them
        },
        "search": {
            # What the model gets back from recall and read_turn_context
            # (search_context.py): hits as whole exchanges, grouped by branch,
            # with chat + branch context. Caps keep a search from flooding the
            # context: per exchange, per summary, and per whole result.
            "hit_chars": 900,           # one exchange (user third, reply the rest)
            "summary_chars": 700,       # a branch summary or chat overview
            "max_result_chars": 12000,  # one recall result in total
            "context_turn_chars": 1500, # one turn in read_turn_context
            "context_before": 6,
            "context_after": 6,
            "backlinks_shown": 3,       # note hits: most recent backlinks named
        },
        "summaries": {
            # Branch summaries + chat overviews (summaries.py), made ahead of
            # time by a background job in the backend process with the utility
            # model. A chat is picked up once it has been idle idle_minutes and
            # has min_exchanges exchanges; only what's stale is regenerated. The
            # chat card shows the overview (forked) or the one branch summary,
            # and the same calls propose the card's tags (never applied).
            "enabled": True,
            "idle_minutes": 15,
            "interval_seconds": 300,   # how often the job looks for work
            "min_exchanges": 2,
            "chunk_chars": 8000,       # new turns folded in per call (rolling)
            "turn_chars": 1200,        # each turn's text is cut to this
            "temperature": 0.3,
            "max_tokens": 1536,        # reasoning models spend this on thinking first
            "timeout": 120,
            "branch_prompt_file": "branch-summary-prompt.md",
            "overview_prompt_file": "chat-overview-prompt.md",
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
            # The tool-call log (tool_log.py): every call the model makes,
            # arguments in full, results as size + this many characters.
            "log": {"enabled": True, "preview_chars": 400},
            "available": {
                "recall_semantic": True,
                "recall_keyword": True,
                "read_turn_context": True,
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
                "git_issue": True,     # issue create/comment (token needs write:issue)
                "transcribe_video": True,  # yt-dlp audio -> STT (never captions)
                "list_transcripts": True,  # catalogue of stored transcripts
                "read_transcript": True,   # read one stored transcript by id
                "list_attachments": True,  # catalogue of files attached to chats
                "read_attachment": True,   # an attachment's extracted text, paged
                "read_logs": True,     # agent can read its own recent server logs
                "wallet": True,        # self-gating: needs a wallet for the user
                "ditta_search": True,  # self-gating: needs tools.ditta.url + pubkey
            },
            "git": {
                # Read-only forge access (Gitea; GitHub API-compatible for these
                # routes). The git_read tool registers only when BOTH are set.
                "api_url": None,       # e.g. "https://gitea.example.com/api/v1"
                "token": None,         # READ-ONLY token (set in .config.yaml)
                "max_chars": 20000,
                "timeout": 15,
            },
            "wallet": {
                # Collaborator's own Lightning wallet (wallet.py). provider:
                # "lnbits" (what runs) or "nwc" (dormant; tools.nwc.connections).
                # LNbits wallets are per user, keyed by identity hash:
                # {"<hash>": {"invoice_key": ..., "admin_key": ...}}.
                "provider": "lnbits",
                "max_sats_per_payment": 100,
                "max_sats_per_day": 500,
                "low_balance_sats": 0,    # >0: get_balance flags a top-up below it
                "timeout": 30,
                "lnbits": {"url": None, "wallets": {}},
            },
            "ditta": {
                # The user's DITTA broker (ditta.py). url may be a domain, an
                # IP or an onion (onion needs proxy); pubkey pins the broker's
                # signing key, so a challenge signed by anyone else is never
                # paid. Payments come from tools.wallet.
                "url": None,
                "pubkey": None,
                "max_sats_per_query": 10,
                "results": 10,
                "proxy": None,            # e.g. "socks5h://127.0.0.1:9050"
                "timeout": 30,
                "onion_timeout": 90,
            },
            "transcribe_video": {
                "sync_max_minutes": 10,   # <= this: transcript returned in-turn
                "max_minutes": 240,       # hard cap (raise if you really want more)
                "return_chars": 15000,    # transcript chars handed to the model
                "proxy": None,            # yt-dlp egress proxy (else direct)
            },
            "web_search": {
                # Provider switch: "searxng" (private instance, queries leave
                # via the search VM) or "brave" (Brave Search API, direct
                # HTTPS from this box). The tool registers only when the
                # SELECTED provider's credential below is set.
                "provider": "searxng",
                "url": None,           # searxng: base URL (e.g. tailnet IP)
                "brave_api_key": None, # brave: API key (set in config.yaml)
                "country": None,       # brave only: result country (e.g. "us", "ca")
                "results": 5,
                "timeout": 15,
                "language": "en",
                "safesearch": 0,       # 0/1/2 (brave maps to off/moderate/strict)
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
                # search VM's VPN) -> the chat model when it reads images
                # (inference.vision).
                "temperature": 0.2,
                "max_tokens": 512,
                "timeout": 180,         # headroom for on-demand model load
                "text_chars": 2000,     # page-text excerpt returned alongside
            },
            "synthesis": {
                "max_tokens": 768,   # reasoning headroom (see titles note)
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
    
    # DEPRECATED: .config.yaml (the old app-written overrides file). Still
    # honored so existing installs keep working, but its contents belong in
    # config.yaml (hand-authored values) or app_settings.json (app-written).
    if project_root:
        dot_config_path = os.path.join(project_root, ".config.yaml")
        if os.path.exists(dot_config_path):
            print("Warning: .config.yaml is deprecated — fold its values into "
                  "config.yaml and delete it (app-chosen settings now persist "
                  "to backend/data/app_settings.json)")
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
    
    # App-written settings (state, not config): backend/data/app_settings.json,
    # persisted by the app itself (e.g. PUT /api/model). Wins over both yaml
    # files; env vars still trump everything.
    settings_path = resolve_path("backend/data/app_settings.json")
    if os.path.exists(settings_path):
        try:
            import json as _json
            with open(settings_path, "r", encoding="utf-8") as f:
                app_settings = _json.load(f)
            if isinstance(app_settings, dict) and app_settings:
                config = deep_merge(config, app_settings)
        except (ValueError, IOError) as e:
            print(f"Warning: Failed to read app settings at {settings_path}: {e}")

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
