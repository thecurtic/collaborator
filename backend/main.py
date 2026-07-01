from fastapi import (
    FastAPI, HTTPException, Header, UploadFile, Form, Request, File,
    WebSocket, WebSocketDisconnect, Query,
)
from fastapi.middleware.cors import CORSMiddleware
import os
import sqlite3
import asyncio
import json
from typing import List, Optional
from starlette.responses import StreamingResponse

from pydantic import BaseModel
from config import get_config, resolve_path
from data.agents_md import load_agents_md
from db import (
    init_db, create_turn, get_recent_turns, get_turn_by_id, delete_turn,
    get_ancestor_chain, get_turn_tree,
    search_similar_turns, search_keyword_turns, set_turn_embedding, update_turn_tags,
    update_turn_name, set_current_recall, get_current_recall, set_turn_recall,
    get_turns_missing_embeddings,
)
from inference import (
    call_llm_streaming, call_llm_non_streaming, stream_llm_tokens,
    get_embedding, embed_texts, synthesize_recall,
    generate_with_tools, synthesize,
)
from auth import validate_passkey, create_user_db

app = FastAPI()

# Initialize config
config = get_config()

# Check if authentication is enabled
auth_enabled = config.get("authentication", {}).get("enabled", False)

# Enable CORS so the frontend (served from a different origin/host on the tailnet)
# can read API responses. Without this, browsers block the response even though
# the request reaches the backend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.get("server", {}).get("cors_origins", ["http://localhost:3000"]),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Initialize database on startup
init_db()


class UserMessage(BaseModel):
    message: str
    # The active leaf to continue from. Context is built from this turn's ancestor
    # chain and the new turns chain off it. Omitted/None = start a fresh root
    # conversation (no prior context).
    parent_turn_id: Optional[int] = None
    # None = use the configured default window; 0 = fresh context (no history).
    context_turns: Optional[int] = None
    commit: Optional[bool] = True
    user_id: Optional[str] = None
    # Run recall for this turn. None = use config default (recall.enabled).
    recall: Optional[bool] = None
    # "voice" = turn came from call mode (spoken); absent/"text" = normal chat.
    # On voice turns the system prompt is augmented for spoken-style output.
    mode: Optional[str] = None


class MessageResponse(BaseModel):
    id: int
    user_id: Optional[str]
    message: str
    response: str
    committed: bool
    context_turns_used: List[dict]
    system_prompt: str


class MessagesListResponse(BaseModel):
    turns: List[dict]
    count: int
    context_turns_used: Optional[int] = None


class DeleteTurnResponse(BaseModel):
    id: int
    deleted: bool
    removed_turn_ids: List[int]
    removed_count: int
    reparented_children: List[int] = []
    reparented_to: Optional[int] = None


class BranchRequest(BaseModel):
    message: str
    paragraph_index: Optional[int] = None
    # None = configured default window; 0 = "branch without context" (fresh).
    context_turns: Optional[int] = None
    commit: Optional[bool] = True
    user_id: Optional[str] = None
    mode: Optional[str] = None
    recall: Optional[bool] = None


class TagsRequest(BaseModel):
    add_tags: List[str] = []
    remove_tags: List[str] = []


class NameRequest(BaseModel):
    name: Optional[str] = None


def get_passkey_from_header(passkey: Optional[str] = Header(None, alias="X-Passkey")) -> str:
    """Extract passkey from header or query param."""
    return passkey


SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
}


def _require_auth(passkey: Optional[str]) -> None:
    """Raise 403 if auth is enabled and the passkey is missing/invalid."""
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")


def _default_context_window() -> int:
    return config.get("memory", {}).get("default_context_window", 5)


def _effective_context_turns(value: Optional[int]) -> int:
    """Resolve a request's context_turns: None -> configured default; 0 -> fresh."""
    return _default_context_window() if value is None else value


def _recall_config() -> dict:
    return config.get("recall", {}) or {}


def _recall_enabled(value: Optional[bool]) -> bool:
    """Resolve whether recall runs: request flag overrides config default."""
    if value is not None:
        return value
    return bool(_recall_config().get("enabled", False))


def _tools_settings() -> dict:
    return config.get("tools", {}) or {}


def _tools_enabled(value: Optional[bool]) -> bool:
    """Whether to offer tools to the model: request flag overrides config default."""
    if value is not None:
        return value
    return bool(_tools_settings().get("enabled", False))


def _synthesis_kinds() -> List[str]:
    prompts = (_tools_settings().get("synthesis") or {}).get("prompts") or {"memory": None}
    return list(prompts.keys()) or ["memory"]


def _tool_matches_payload(matches: List[dict]) -> List[dict]:
    """Compact match list handed to the model (keep text, trim length)."""
    return [{
        "turn_id": m["turn_id"],
        "role": m["role"],
        "text": (m.get("text") or "")[:600],
        "tags": m.get("tags") or [],
        "branch_root_id": m.get("branch_root_id"),
        "score": round(m.get("score", 0), 4),
    } for m in matches]


def _recall_sources(matches: List[dict]) -> List[dict]:
    """Source metadata persisted with a synthesized recall block (for display)."""
    return [{
        "turn_id": m["turn_id"],
        "role": m["role"],
        "tags": m.get("tags") or [],
        "branch_root_id": m.get("branch_root_id"),
        "score": round(m.get("score", 0), 4),
        "preview": (m.get("text") or "")[:160],
    } for m in matches]


def _build_tools(db_path: str):
    """Assemble enabled tool schemas + an executor + shared state for one turn."""
    tcfg = _tools_settings()
    avail = tcfg.get("available", {}) or {}
    rc = _recall_config()
    state = {"last_matches": [], "synthesis": None, "synthesis_kind": None}

    def _search_schema(name, desc):
        return {"type": "function", "function": {
            "name": name, "description": desc,
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string", "description": "what to search for"}},
                "required": ["query"]}}}

    schemas = []
    if avail.get("recall_semantic", True):
        schemas.append(_search_schema(
            "recall_semantic",
            "Search the user's past conversation turns by meaning (semantic similarity). "
            "Use when the user refers to earlier discussion or ideas."))
    if avail.get("recall_keyword", True):
        schemas.append(_search_schema(
            "recall_keyword",
            "Search the user's past conversation turns by exact keywords/terms. Use for "
            "names, specific words, or when semantic search might miss a literal match."))
    if avail.get("synthesize", True):
        schemas.append({"type": "function", "function": {
            "name": "synthesize",
            "description": "Synthesize retrieved items into a concise block. Call after a "
                           "search tool to produce a memory block for the user.",
            "parameters": {"type": "object", "properties": {
                "kind": {"type": "string", "enum": _synthesis_kinds(),
                         "description": "kind of synthesis / source type"},
                "items": {"type": "array", "items": {"type": "string"},
                          "description": "the text snippets to synthesize"}},
                "required": ["kind", "items"]}}})

    def execute(name, args):
        if name in ("recall_semantic", "recall_keyword"):
            query = args.get("query", "")
            conn = sqlite3.connect(db_path)
            try:
                if name == "recall_semantic":
                    vec = get_embedding(query)
                    matches = search_similar_turns(
                        conn, vec, limit=rc.get("search_limit", 10),
                        tag_boosts=rc.get("tag_boosts", {})) if vec else []
                else:
                    matches = search_keyword_turns(
                        conn, query, limit=rc.get("search_limit", 10),
                        tag_boosts=rc.get("tag_boosts", {}))
            finally:
                conn.close()
            state["last_matches"] = matches
            return json.dumps(_tool_matches_payload(matches))
        if name == "synthesize":
            block = synthesize(args.get("kind", "memory"), args.get("items", []), args.get("query", ""))
            state["synthesis"] = block
            state["synthesis_kind"] = args.get("kind", "memory")
            return block or "(no synthesis produced)"
        return json.dumps({"error": f"unknown tool {name}"})

    return schemas, execute, state


def _resolve_db_path(passkey: Optional[str]) -> str:
    """Resolve the conversation DB path (per-user when auth is enabled)."""
    if auth_enabled:
        return create_user_db(passkey)
    db_path_config = config.get("memory", {}).get("db_path")
    if db_path_config and not os.path.isabs(db_path_config):
        return resolve_path(db_path_config)
    return db_path_config


def _split_paragraphs(text: str) -> List[str]:
    """Split text into paragraphs on blank lines (the branchable unit)."""
    if not text:
        return []
    import re
    parts = re.split(r"\n\s*\n", text.strip())
    return [p.strip() for p in parts if p.strip()]


def _preview(text: str, length: int = 80) -> str:
    """Single-line preview for tree/metro-map node labels."""
    collapsed = " ".join((text or "").split())
    return collapsed[:length] + ("…" if len(collapsed) > length else "")


def _enrich_turn(turn: dict) -> dict:
    """Add a derived paragraphs[] array to assistant turns."""
    turn = dict(turn)
    if turn.get("role") == "assistant":
        turn["paragraphs"] = _split_paragraphs(turn.get("content", ""))
    return turn


def _enrich_tree_node(node: dict) -> dict:
    """Recursively add preview + paragraphs to tree nodes for the metro map."""
    node = dict(node)
    node["preview"] = _preview(node.get("content", ""))
    # A turn generated with context_turns == 0 reset the context window ("branch
    # without context"). The frontend should stop shading the in-context window at
    # this boundary when walking back the active path.
    node["context_boundary"] = (node.get("context_turns") == 0)
    # True only for turns created via POST /api/branches (an explicit fork), so a
    # with-context branch is distinguishable from a normal continuation.
    node["branched"] = bool(node.get("branched"))
    if node.get("role") == "assistant":
        node["paragraphs"] = _split_paragraphs(node.get("content", ""))
    node["children"] = [_enrich_tree_node(c) for c in node.get("children", [])]
    return node


def _count_nodes(nodes: List[dict]) -> int:
    return sum(1 + _count_nodes(n.get("children", [])) for n in nodes)


def _sse_error(detail: str):
    """Return a StreamingResponse that emits a single SSE error event."""
    def gen():
        yield f"data: {json.dumps({'type': 'error', 'detail': detail})}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


def _run_recall(db_path: str, message: str):
    """Compute the recall block for `message`: embed -> search -> synthesize.

    Best-effort: returns (recall_text, sources). On any failure returns ("", []).
    Stores the block as the current (ephemeral) recall, overwriting the previous.
    """
    rc = _recall_config()
    try:
        query_vec = get_embedding(message)
        if not query_vec:
            return "", []
        conn = sqlite3.connect(db_path)
        try:
            matches = search_similar_turns(
                conn, query_vec,
                limit=rc.get("search_limit", 10),
                tag_boosts=rc.get("tag_boosts", {}),
            )
            if not matches:
                return "", []
            recall_text = synthesize_recall(message, matches)
            sources = [{
                "turn_id": m["turn_id"],
                "role": m["role"],
                "tags": m["tags"],
                "branch_root_id": m["branch_root_id"],
                "similarity": round(m["similarity"], 4),
                "score": round(m["score"], 4),
                "preview": (m["text"] or "")[:160],
            } for m in matches]
            if recall_text:
                set_current_recall(conn, recall_text, sources, query=message)
            return recall_text, sources
        finally:
            conn.close()
    except Exception as e:
        print(f"Warning: recall failed: {e}")
        return "", []


def _stream_turn_response(
    db_path: str,
    *,
    message: str,
    context_list: List[dict],
    context_turns: int,
    commit: bool,
    user_id: Optional[str],
    mode: Optional[str],
    user_parent_id: Optional[int],
    paragraph_index: Optional[int],
    tools_enabled: bool = False,
    branched: bool = False,
):
    """Build the SSE generator that streams the reply and persists both turns.

    When tools are enabled, the model drives retrieval/synthesis via the tool loop
    (emitting `status` / `tool_result` / `token` events); a `synthesize` result is
    persisted as the turn's recall block. Otherwise a plain streamed reply. The DB
    connection is opened INSIDE the generator (worker thread) to avoid cross-thread
    SQLite use.
    """
    def event_generator():
        full_response = ""
        synthesis_block = None
        synthesis_sources = []

        if tools_enabled:
            schemas, execute, state = _build_tools(db_path)
            tcfg = _tools_settings()
            try:
                for ev in generate_with_tools(
                    message, context_list, mode,
                    tool_schemas=schemas, execute_tool=execute,
                    max_rounds=tcfg.get("max_rounds", 5),
                    emit_status=tcfg.get("status_notes", True),
                    emit_results=tcfg.get("show_step_results", False),
                ):
                    if ev.get("type") == "token":
                        full_response += ev["content"]
                    yield f"data: {json.dumps(ev)}\n\n"
                    if ev.get("type") == "error":
                        return
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"
                return
            synthesis_block = state.get("synthesis") or None
            if synthesis_block:
                synthesis_sources = _recall_sources(state.get("last_matches") or [])
        else:
            try:
                for content in stream_llm_tokens(message, context_list, mode=mode):
                    full_response += content
                    yield f"data: {json.dumps({'type': 'token', 'content': content})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"
                return

        try:
            conn = sqlite3.connect(db_path)
            try:
                user_turn = create_turn(
                    conn, user_id=user_id, role="user", content=message,
                    context_turns=context_turns, committed=commit,
                    parent_turn_id=user_parent_id, paragraph_index=paragraph_index,
                    branched=branched,
                )
                assistant_turn = create_turn(
                    conn, user_id=user_id, role="assistant", content=full_response,
                    context_turns=context_turns, committed=commit,
                    parent_turn_id=user_turn["id"], paragraph_index=None,
                )
                # Persist a synthesized recall block on the user turn (per-branch).
                if synthesis_block:
                    set_turn_recall(conn, user_turn["id"], synthesis_block, synthesis_sources)
                # Embed both turns (best-effort) so they're searchable by recall tools.
                if tools_enabled:
                    for t in (user_turn, assistant_turn):
                        try:
                            vec = get_embedding(t["content"])
                            if vec:
                                set_turn_embedding(conn, t["id"], vec)
                        except Exception:
                            pass
            finally:
                conn.close()
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"
            return

        done = {
            "type": "done",
            "id": assistant_turn["id"],
            "user_turn_id": user_turn["id"],
            "parent_turn_id": user_parent_id,
            "paragraph_index": paragraph_index,
            "context_turns_used": context_turns,
        }
        yield f"data: {json.dumps(done)}\n\n"

    return event_generator


@app.get("/api/health")
async def health_check():
    """Basic health check endpoint."""
    return {"status": "healthy", "version": "0.2.0"}


@app.post("/api/messages")
async def send_message(
    request: UserMessage,
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """
    Send a user message and get the model response (streaming).

    - **message**: The user's input
    - **parent_turn_id**: The active leaf to continue from. Context is built from
      this turn's ancestor chain. Omit it to start a fresh root conversation.
    - **context_turns**: Prior committed turns to include (None = configured default,
      0 = fresh/no history).
    - **commit**: Whether to commit this turn to memory (default: true)
    - **X-Passkey**: User's passkey for authentication
    """
    _require_auth(passkey)

    try:
        db_path = _resolve_db_path(passkey)
        ctx_turns = _effective_context_turns(request.context_turns)
        parent_id = request.parent_turn_id

        # Build context from the active leaf's ancestor chain (the client tells us
        # which branch is active via parent_turn_id). Omitted -> fresh root.
        # Short-lived connection on THIS thread; the generator opens its own.
        conn = sqlite3.connect(db_path)
        try:
            if parent_id is not None:
                if get_turn_by_id(conn, parent_id) is None:
                    raise HTTPException(status_code=404, detail=f"parent_turn_id {parent_id} not found")
                context_list = get_ancestor_chain(conn, parent_id, limit=ctx_turns)
            else:
                context_list = []
        finally:
            conn.close()

        generator = _stream_turn_response(
            db_path,
            message=request.message,
            context_list=context_list,
            context_turns=ctx_turns,
            commit=request.commit,
            user_id=request.user_id or os.environ.get("USER_ID"),
            mode=request.mode,
            user_parent_id=parent_id,
            paragraph_index=None,
            tools_enabled=_tools_enabled(request.recall),
        )
        return StreamingResponse(generator(), media_type="text/event-stream", headers=SSE_HEADERS)

    except HTTPException:
        raise
    except Exception as e:
        return _sse_error(str(e))


@app.post("/api/branches/{parent_turn_id}")
async def create_branch(
    parent_turn_id: int,
    request: BranchRequest,
    passkey: Optional[str] = Header(None, alias="X-Passkey"),
):
    """Create a branch from a fork point and stream the reply.

    The fork point is `parent_turn_id` (any turn). Optionally `paragraph_index`
    records which paragraph of that turn the branch was taken from. The new branch
    inherits context up to and including the parent turn.
    """
    _require_auth(passkey)

    try:
        db_path = _resolve_db_path(passkey)
        ctx_turns = _effective_context_turns(request.context_turns)

        conn = sqlite3.connect(db_path)
        try:
            parent = get_turn_by_id(conn, parent_turn_id)
            if not parent:
                raise HTTPException(status_code=404, detail=f"Parent turn {parent_turn_id} not found")

            if request.paragraph_index is not None:
                paragraphs = _split_paragraphs(parent.get("content", ""))
                if request.paragraph_index < 0 or request.paragraph_index >= len(paragraphs):
                    raise HTTPException(
                        status_code=422,
                        detail=(f"paragraph_index {request.paragraph_index} out of range; "
                                f"parent turn {parent_turn_id} has {len(paragraphs)} paragraph(s)"),
                    )

            context_list = get_ancestor_chain(conn, parent_turn_id, limit=ctx_turns)
        finally:
            conn.close()

        generator = _stream_turn_response(
            db_path,
            message=request.message,
            context_list=context_list,
            context_turns=ctx_turns,
            commit=request.commit,
            user_id=request.user_id or os.environ.get("USER_ID"),
            mode=request.mode,
            user_parent_id=parent_turn_id,
            paragraph_index=request.paragraph_index,
            tools_enabled=_tools_enabled(request.recall),
            branched=True,
        )
        return StreamingResponse(generator(), media_type="text/event-stream", headers=SSE_HEADERS)

    except HTTPException:
        raise
    except Exception as e:
        return _sse_error(str(e))


@app.get("/api/tree")
async def get_tree(
    passkey: Optional[str] = Header(None, alias="X-Passkey"),
):
    """Return the full conversation tree (roots -> children) for the metro map."""
    _require_auth(passkey)

    try:
        db_path = _resolve_db_path(passkey)
        conn = sqlite3.connect(db_path)
        try:
            roots = get_turn_tree(conn)
        finally:
            conn.close()

        enriched = [_enrich_tree_node(node) for node in roots]
        return {
            "roots": enriched,
            "count": _count_nodes(enriched),
            # Default window size: how many recent turns feed the next message.
            "context_turns": _default_context_window(),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/turns/{turn_id}/tags")
async def patch_turn_tags(
    turn_id: int,
    request: TagsRequest,
    passkey: Optional[str] = Header(None, alias="X-Passkey"),
):
    """Add/remove free-form tags on a turn (used for recall boosts)."""
    _require_auth(passkey)
    try:
        db_path = _resolve_db_path(passkey)
        conn = sqlite3.connect(db_path)
        try:
            tags = update_turn_tags(conn, turn_id, add=request.add_tags, remove=request.remove_tags)
        finally:
            conn.close()
        if tags is None:
            raise HTTPException(status_code=404, detail=f"Turn {turn_id} not found")
        return {"turn_id": turn_id, "tags": tags}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/turns/{turn_id}/name")
async def patch_turn_name(
    turn_id: int,
    request: NameRequest,
    passkey: Optional[str] = Header(None, alias="X-Passkey"),
):
    """Set or clear a turn's display name (used to name conversations/branches)."""
    _require_auth(passkey)
    try:
        db_path = _resolve_db_path(passkey)
        conn = sqlite3.connect(db_path)
        try:
            found, value = update_turn_name(conn, turn_id, request.name)
        finally:
            conn.close()
        if not found:
            raise HTTPException(status_code=404, detail=f"Turn {turn_id} not found")
        return {"turn_id": turn_id, "name": value}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/recall/current")
async def get_recall_current(
    passkey: Optional[str] = Header(None, alias="X-Passkey"),
):
    """Return the current (ephemeral) recall block, or null if none."""
    _require_auth(passkey)
    try:
        db_path = _resolve_db_path(passkey)
        conn = sqlite3.connect(db_path)
        try:
            return {"recall": get_current_recall(conn)}
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/recall/reindex")
async def reindex_embeddings(
    passkey: Optional[str] = Header(None, alias="X-Passkey"),
):
    """Backfill embeddings for committed turns that don't have one yet.

    Run once after enabling recall so prior history becomes searchable.
    """
    _require_auth(passkey)
    try:
        db_path = _resolve_db_path(passkey)
        conn = sqlite3.connect(db_path)
        try:
            pending = get_turns_missing_embeddings(conn, limit=1000)
            indexed = 0
            # Embed in batches (one model call per chunk) for a fast backfill.
            CHUNK = 64
            for start in range(0, len(pending), CHUNK):
                chunk = pending[start:start + CHUNK]
                vectors = embed_texts([t["content"] for t in chunk])
                for turn, vec in zip(chunk, vectors):
                    if vec:
                        set_turn_embedding(conn, turn["id"], vec)
                        indexed += 1
        finally:
            conn.close()
        return {"indexed": indexed, "remaining": max(0, len(pending) - indexed)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/messages")
async def get_messages(
    limit: int = 10,
    offset: int = 0,
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """Retrieve conversation history."""
    _require_auth(passkey)

    try:
        db_path = _resolve_db_path(passkey)

        conn = sqlite3.connect(db_path)
        try:
            turns = get_recent_turns(conn, limit=limit, offset=offset)
        finally:
            conn.close()

        # Add a derived paragraphs[] array to assistant turns.
        turns = [_enrich_turn(t) for t in turns]

        return MessagesListResponse(
            turns=turns,
            count=len(turns),
            context_turns_used=config.get("memory", {}).get("default_context_window")
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/messages/{turn_id}")
async def delete_message(
    turn_id: int,
    subtree: bool = False,
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """Hard-delete a turn (the row is removed; ids are not reused).

    - default: delete just this turn; its direct children are reparented to this
      turn's parent (they rise one level rather than being orphaned).
    - ?subtree=true: delete this turn and all its descendants (a whole branch) —
      this is the metro-map "delete branch" action.
    """
    _require_auth(passkey)

    try:
        db_path = _resolve_db_path(passkey)

        conn = sqlite3.connect(db_path)
        try:
            result = delete_turn(conn, turn_id, subtree=subtree)
        finally:
            conn.close()

        if result is None:
            raise HTTPException(status_code=404, detail=f"Turn {turn_id} not found")

        return DeleteTurnResponse(
            id=turn_id,
            deleted=True,
            removed_turn_ids=result["removed_turn_ids"],
            removed_count=len(result["removed_turn_ids"]),
            reparented_children=result["reparented_children"],
            reparented_to=result["reparented_to"],
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/transcribe")
def transcribe_audio(
    request: Request,
    audio: UploadFile = File(...),
    language: Optional[str] = Form(None),
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """Transcribe audio to text using Whisper."""
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    # Check file size (25MB limit)
    content_length = int(request.headers.get("content-length", 0))
    if content_length > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 25MB)")
    
    # Validate content type (strip codec parameters like audio/webm;codecs=opus)
    content_type = audio.content_type
    if content_type:
        # Split on semicolon to remove codec parameters
        base_content_type = content_type.split(';')[0].strip().lower()
    else:
        base_content_type = None
    
    valid_types = ["audio/webm", "video/webm", "audio/ogg", "video/ogg",
                   "audio/mp4", "video/mp4", "audio/wav", "audio/x-wav"]
    
    if content_type and base_content_type not in valid_types:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid content type: {content_type}. Accepts audio/webm, video/webm, audio/ogg, video/ogg, audio/mp4, video/mp4, audio/wav, or audio/x-wav"
        )
    
    import os as _os
    import re
    import tempfile
    import subprocess

    tmp_path = None
    try:
        # Read audio data
        audio_data = audio.file.read()

        # Create temp file for the normalized audio (cleaned up in finally)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name

        # Use ffmpeg to normalize audio to 16kHz mono WAV
        try:
            process = subprocess.Popen(
                ["ffmpeg", "-y", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", tmp_path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
        except FileNotFoundError:
            raise HTTPException(
                status_code=500,
                detail="ffmpeg not found on server. Install ffmpeg to enable transcription."
            )

        stdout, stderr = process.communicate(input=audio_data)

        if process.returncode != 0:
            raise HTTPException(status_code=500, detail=f"FFmpeg error: {stderr.decode(errors='replace')}")

        # Transcribe the normalized 16kHz mono wav with faster-whisper.
        try:
            text = _whisper_transcribe(tmp_path, language)
        except HTTPException:
            raise
        except ImportError:
            raise HTTPException(
                status_code=500,
                detail="faster-whisper is not installed on the server. Install it "
                       "(pip install -r requirements.txt) to enable transcription.",
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

        return {"text": text.strip()}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if tmp_path:
            try:
                _os.unlink(tmp_path)
            except OSError:
                pass


# --- Streaming transcription (WebSocket) -----------------------------------

# Wire format for WS /api/transcribe/stream: raw PCM16, mono, 16 kHz, little-endian.
STREAM_SAMPLE_RATE = 16000
STREAM_BYTES_PER_SAMPLE = 2
# Re-transcribe (emit a partial) roughly every ~1.5s of newly received audio.
# faster-whisper makes each pass cheap enough to keep the running transcript close
# to final by the time the user stops, so the final pass feels instant.
STREAM_PARTIAL_INTERVAL_BYTES = int(STREAM_SAMPLE_RATE * STREAM_BYTES_PER_SAMPLE * 1.5)

_whisper_model = None


def _get_whisper_model():
    """Load the faster-whisper model once and reuse it across requests/connections.

    Engine is CTranslate2 (no PyTorch). Model/device/compute are configurable under
    a `transcription` config section; defaults are CPU int8 with the 'base' model.
    Set device: cuda / compute_type: float16 to use a GPU.
    """
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        tcfg = config.get("transcription", {}) or {}
        _whisper_model = WhisperModel(
            tcfg.get("model", "base"),
            device=tcfg.get("device", "cpu"),
            compute_type=tcfg.get("compute_type", "int8"),
        )
    return _whisper_model


def _whisper_transcribe(audio, language: Optional[str]) -> str:
    """Transcribe a file path or a float32 numpy array via faster-whisper.

    faster-whisper returns a generator of segments; join their text.
    """
    model = _get_whisper_model()
    segments, _info = model.transcribe(audio, language=language or "en")
    return "".join(segment.text for segment in segments).strip()


def _transcribe_pcm16(pcm_bytes: bytes, language: Optional[str]) -> str:
    """Transcribe raw PCM16 mono 16kHz bytes. Runs in a worker thread (blocking)."""
    if not pcm_bytes:
        return ""
    import numpy as np
    # PCM16 LE -> float32 in [-1, 1], which is what Whisper expects at 16 kHz.
    audio = np.frombuffer(pcm_bytes, dtype="<i2").astype("float32") / 32768.0
    return _whisper_transcribe(audio, language)


async def _ws_send(websocket: WebSocket, payload: dict) -> None:
    await websocket.send_text(json.dumps(payload))


@app.websocket("/api/transcribe/stream")
async def transcribe_stream(
    websocket: WebSocket,
    passkey: Optional[str] = Query(None),
    language: Optional[str] = Query(None),
):
    """Stream mic audio in, get incremental transcripts back.

    Protocol:
      - Auth: ?passkey=... OR first text frame {"passkey": "..."} (browsers can't
        set WebSocket headers). Invalid/missing -> error + close.
      - Client -> server (binary): raw PCM16, mono, 16 kHz, little-endian.
      - Client -> server (text): {"type":"end"} to finalize the turn.
      - Server -> client (text): {"type":"partial","text":...} as it transcribes,
        {"type":"final","text":...} after end, or {"type":"error","detail":...}.
    """
    await websocket.accept()

    # --- Auth (query param, else first text frame carrying the passkey) ---
    if auth_enabled:
        pk = passkey
        if not pk:
            try:
                first = await websocket.receive()
            except WebSocketDisconnect:
                return
            if first.get("type") == "websocket.disconnect":
                return
            if first.get("text"):
                try:
                    pk = json.loads(first["text"]).get("passkey")
                except Exception:
                    pk = None
        if not pk or not validate_passkey(pk):
            await _ws_send(websocket, {"type": "error", "detail": "Invalid or missing passkey"})
            await websocket.close(code=1008)
            return

    # Make sure Whisper is usable before we start accepting audio.
    try:
        await asyncio.to_thread(_get_whisper_model)
    except Exception as e:
        await _ws_send(websocket, {"type": "error", "detail": f"Whisper unavailable: {e}"})
        await websocket.close(code=1011)
        return

    buffer = bytearray()
    last_partial_bytes = 0

    try:
        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                return

            data_bytes = message.get("bytes")
            if data_bytes is not None:
                buffer += data_bytes
                # Emit a running partial every ~interval of new audio.
                if len(buffer) - last_partial_bytes >= STREAM_PARTIAL_INTERVAL_BYTES:
                    last_partial_bytes = len(buffer)
                    text = await asyncio.to_thread(_transcribe_pcm16, bytes(buffer), language)
                    await _ws_send(websocket, {"type": "partial", "text": text})
                continue

            text_frame = message.get("text")
            if text_frame is not None:
                try:
                    payload = json.loads(text_frame)
                except Exception:
                    continue
                if payload.get("type") == "end":
                    final_text = await asyncio.to_thread(_transcribe_pcm16, bytes(buffer), language)
                    await _ws_send(websocket, {"type": "final", "text": final_text})
                    await websocket.close()
                    return

    except WebSocketDisconnect:
        return
    except Exception as e:
        try:
            await _ws_send(websocket, {"type": "error", "detail": str(e)})
            await websocket.close(code=1011)
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    server_config = config.get("server", {})
    host = server_config.get("backend_host", "0.0.0.0")
    port = server_config.get("backend_port", 8000)
    
    print(f"Starting Collaborator Backend on {host}:{port}")
    print(f"Authentication: {'enabled' if auth_enabled else 'disabled'}")
    uvicorn.run(app, host=host, port=port)
