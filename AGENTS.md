# Project Context

Collaborator is a self-hosted personal chat interface backed by local LLM inference.

## Architecture

This is a monorepo with two runtime contexts:

- **backend/** — runs on this VM. Manages SQLite conversation persistence, context assembly, and proxies inference to the local LLM endpoint. Exposes a simple HTTP API.
- **frontend/** — served from a separate machine on the tailnet. Web UI for sending messages, viewing responses, editing or discarding turns before they commit to memory.

They are loosely coupled. The frontend talks to the backend over HTTP. Either side can be swapped without breaking the other.

## Inference

All inference is local. Use the same endpoint and model that Pi itself is using for this session (`qwen/qwen3-coder-next` via LM Studio at `http://<inference-host>:1234/v1`).

## Networking

The web UI must be accessible from any network via the tailnet. The frontend is served from a machine on the tailnet. The backend API on this VM is also reachable via its tailnet IP. No public internet exposure. All communication stays within the tailnet.

## Memory Model

Conversations are stored in SQLite. Each turn records the user message and the final model response (not intermediate tool calls). The user can discard any turn before it commits — discarded turns never enter memory or future context. Context for each new turn is assembled from the last N committed turns.

## Principles
- Minimal dependencies
- Privacy-first, no external services unless explicitly requested
- Self-hosted everything
- Local inference only
