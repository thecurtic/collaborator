from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import os

from pydantic import BaseModel
from typing import List, Optional

from config import get_config
from db import get_db, create_turn, get_recent_turns, update_turn_committed
from inference import call_llm


# Initialize config
config = get_config()

# Initialize database on startup
from db import init_db
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


class MessagesListResponse(BaseModel):
    turns: List[dict]
    count: int


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


@app.get("/api/health")
async def health_check():
    """Basic health check endpoint."""
    return {"status": "healthy", "version": "0.1.0"}


@app.post("/api/messages")
async def send_message(request: UserMessage):
    """
    Send a user message and get the model response.
    
    - **message**: The user's input
    - **context_turns**: Number of prior committed turns to include in context (default: 5)
    - **commit**: Whether to commit this turn to memory (default: true)
    """
    try:
        db = get_db()
        
        # Get context from recent committed turns
        recent_turns = get_recent_turns(db, limit=request.context_turns)
        
        # Call the LLM with context
        response = call_llm(request.message, recent_turns)
        
        # Persist the turn
        user_id = request.user_id or os.environ.get("USER_ID")
        
        turn = create_turn(
            db,
            user_id=user_id,
            role="user",
            content=request.message,
            context_turns=request.context_turns,
            committed=request.commit
        )
        
        response_turn = create_turn(
            db,
            user_id=user_id,
            role="assistant",
            content=response,
            context_turns=request.context_turns,
            committed=request.commit
        )
        
        return MessageResponse(
            id=response_turn["id"],
            user_id=user_id,
            message=request.message,
            response=response,
            committed=request.commit
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/messages")
async def get_messages(limit: int = 10, offset: int = 0):
    """Retrieve conversation history."""
    try:
        db = get_db()
        turns = get_recent_turns(db, limit=limit, offset=offset)
        return MessagesListResponse(turns=turns, count=len(turns))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/messages/{turn_id}")
async def discard_turn(turn_id: int):
    """Discard a specific turn (remove from context)."""
    try:
        db = get_db()
        result = update_turn_committed(db, turn_id, committed=False)
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
    uvicorn.run(app, host=host, port=port)
