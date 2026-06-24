## Project Context

Collaborator is a self-hosted personal chat interface backed by local LLM inference.

### Current Phase: Conversation Branching (Phase 1)

We're implementing conversation branching as a tree structure built on top of SQLite. The implementation is staged in phases:

1. **Phase 1 (Current)**: Core linear system with SQLite persistence and discard mechanism
2. **Phase 2**: Branching foundation (branch_id, turn_index columns)
3. **Phase 3**: PWA UI for branching (vertical tree visualization)
4. **Phase 4**: Synthesis turns combining multiple branches

### Architecture

This is a monorepo with two runtime contexts:

- **backend/** — runs on this VM. Manages SQLite conversation persistence (with tree-structured branching), context assembly, and proxies inference to the local LLM endpoint. Exposes a simple HTTP API.
- **frontend/** — served from a separate machine on the tailnet. Web UI (PWA) for sending messages, viewing responses, editing or discarding turns before they commit to memory. Supports conversation branching with a vertical tree visualization optimized for mobile devices.

They are loosely coupled. The frontend talks to the backend over HTTP. Either side can be swapped without breaking the other.

## Inference

All inference is local. Use the same endpoint and model that Pi itself is using for this session (`qwen/qwen3-coder-next` via LM Studio at `http://<inference-host>:1234/v1`).

## Networking

The web UI must be accessible from any network via the tailnet. The frontend is served from a machine on the tailnet. The backend API on this VM is also reachable via its tailnet IP. No public internet exposure. All communication stays within the tailnet.

## Memory Model

Conversations are stored as a tree structure in SQLite. Each turn records the user message and the final model response (not intermediate tool calls). The user can discard any turn before it commits — discarded turns never enter memory or future context. Context for each new turn is assembled from the active branch (path from root to current turn).

### Conversation Branching

Conversations form a tree, not a linear list. This is a core architectural feature:
- **Forking** — Users can fork at any point to explore alternative threads
- **Branch switching** — When exhausted, users return to the fork point and switch to another branch
- **Synthesis** — Users can combine insights from multiple branches into a unified response

## Principles
- Minimal dependencies
- Privacy-first, no external services unless explicitly requested
- Self-hosted everything
- Local inference only
