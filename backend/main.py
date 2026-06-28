from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
import os
import sqlite3

from pydantic import BaseModel
from typing import List, Optional

from config import get_config
from data.agents_md import load_agents_md
from db import init_db, create_turn, get_recent_turns, update_turn_committed, get_turn_by_id
from inference import call_llm
from auth import validate_passkey, create_user_db


# Initialize config
config = get_config()

# Check if authentication is enabled
auth_enabled = config.get("authentication", {}).get("enabled", False)

# Initialize database on startup
init_db()

# Pydantic models for API requests/responses
class UserMessage(BaseModel):
    message: str
    context_turns: Optional[int] = 5
    commit: Optional[bool] = True
    user_id: Optional[str] = None


class MessageResponse(BaseModel):
    id: int
    user_id: Optional[str]
    message: str
    response: str
    committed: bool
    context_turns_used: List[dict]  # The turns that were used as context
    system_prompt: str  # The system prompt applied to this conversation
    agents_md_content: Optional[str] = None  # AGENTS.md content for frontend reference


class MessagesListResponse(BaseModel):
    turns: List[dict]
    count: int
    context_turns_used: Optional[int] = None  # Number of turns in context window


class DiscardTurnResponse(BaseModel):
    id: int
    committed: bool


app = FastAPI(title="Collaborator Backend", version="0.1.0")

# Configure CORS
cors_origins = config.get("server", {}).get("cors_origins", ["http://localhost:3000"])
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_passkey_from_header(passkey: Optional[str] = Header(None, alias="X-Passkey")) -> str:
    """Extract passkey from header or query param."""
    return passkey


@app.get("/api/health")
async def health_check():
    """Basic health check endpoint."""
    return {"status": "healthy", "version": "0.1.0"}


@app.post("/api/messages")
async def send_message(
    request: UserMessage,
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """
    Send a user message and get the model response.
    
    - **message**: The user's input
    - **context_turns**: Number of prior committed turns to include in context (default: 5)
    - **commit**: Whether to commit this turn to memory (default: true)
    - **X-Passkey**: User's passkey for authentication
    """
    # Validate passkey if auth is enabled
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    try:
        # Create/get user database
        db_path_config = config.get("memory", {}).get("db_path")
        # Resolve path if not using passkey (auth disabled)
        if auth_enabled:
            db_path = create_user_db(passkey)
        else:
            # Resolve relative path to absolute
            if db_path_config and not os.path.isabs(db_path_config):
                from db import _resolve_path
                db_path = _resolve_path(db_path_config)
            else:
                db_path = db_path_config
        
        # Import db with correct path

        conn = sqlite3.connect(db_path)
        
        # Get context from recent committed turns (filtered by passkey if enabled)
        recent_turns = get_recent_turns(conn, limit=request.context_turns)
        
        # Call the LLM with context
        response = call_llm_streaming(request.message, recent_turns)
        
        # Persist the turn
        user_id = request.user_id or os.environ.get("USER_ID")
        
        turn = create_turn(
            conn,
            user_id=user_id,
            role="user",
            content=request.message,
            context_turns=request.context_turns,
            committed=request.commit
        )
        
        response_turn = create_turn(
            conn,
            user_id=user_id,
            role="assistant",
            content=response,
            context_turns=request.context_turns,
            committed=request.commit
        )
        
        conn.close()
        
        # Build context turns for response (include all relevant data)
        context_data = []
        if recent_turns:
            for turn in recent_turns:
                context_data.append({
                    "id": turn["id"],
                    "role": turn["role"],
                    "content": turn["content"],
                    "committed": turn.get("committed", True),
                    "created_at": turn["created_at"],
                    "model_name": turn.get("model_name"),
                    "token_count": turn.get("token_count")
                })
        
        # Load system prompt from file if specified
        system_prompt_text = config.get("system_prompt", {}).get("text", "")
        file_path = config.get("system_prompt", {}).get("file_path")
        if file_path:
            try:
                from config import resolve_path
                with open(resolve_path(file_path), 'r') as f:
                    system_prompt_text = f.read().strip()
            except IOError:
                pass  # Keep fallback text
        
        # Load AGENTS.md content for frontend
        agents_md_content = load_agents_md()
        
        return MessageResponse(
            id=response_turn["id"],
            user_id=user_id,
            message=request.message,
            response=response,
            committed=request.commit,
            context_turns_used=context_data,
            system_prompt=system_prompt_text,
            agents_md_content=agents_md_content
        )
        
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
    # Validate passkey if auth is enabled
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    try:
        # Create/get user database
        db_path_config = config.get("memory", {}).get("db_path")
        # Resolve path if not using passkey (auth disabled)
        if auth_enabled:
            db_path = create_user_db(passkey)
        else:
            # Resolve relative path to absolute
            if db_path_config and not os.path.isabs(db_path_config):
                from db import _resolve_path
                db_path = _resolve_path(db_path_config)
            else:
                db_path = db_path_config
        
        # Import db with correct path

        conn = sqlite3.connect(db_path)
        
        turns = get_recent_turns(conn, limit=limit, offset=offset)
        
        # Load system prompt for get_messages response
        system_prompt_text = config.get("system_prompt", {}).get("text", "")
        file_path = config.get("system_prompt", {}).get("file_path")
        if file_path:
            try:
                from config import resolve_path
                with open(resolve_path(file_path), 'r') as f:
                    system_prompt_text = f.read().strip()
            except IOError:
                pass
        
        conn.close()
        
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
async def discard_turn(
    turn_id: int,
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """Discard a specific turn (remove from context)."""
    # Validate passkey if auth is enabled
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    try:
        # Create/get user database
        db_path_config = config.get("memory", {}).get("db_path")
        # Resolve path if not using passkey (auth disabled)
        if auth_enabled:
            db_path = create_user_db(passkey)
        else:
            # Resolve relative path to absolute
            if db_path_config and not os.path.isabs(db_path_config):
                from db import _resolve_path
                db_path = _resolve_path(db_path_config)
            else:
                db_path = db_path_config
        
        # Import db with correct path

        conn = sqlite3.connect(db_path)
        
        # Verify turn belongs to user (owner check would be needed in real app)
        turn = get_turn_by_id(conn, turn_id)
        if not turn:
            conn.close()
            raise HTTPException(status_code=404, detail=f"Turn {turn_id} not found")
        
        result = update_turn_committed(conn, turn_id, committed=False)
        conn.close()
        
        if not result:
            raise HTTPException(status_code=404, detail=f"Turn {turn_id} not found")
        
        return DiscardTurnResponse(id=turn_id, committed=False)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    server_config = config.get("server", {})
    host = server_config.get("backend_host", "0.0.0.0")
    port = server_config.get("backend_port", 8000)
    
    print(f"Starting Collaborator Backend on {host}:{port}")
    print(f"Authentication: {'enabled' if auth_enabled else 'disabled'}")
    uvicorn.run(app, host=host, port=port)
