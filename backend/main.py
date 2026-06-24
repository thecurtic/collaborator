from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import os

from backend.db import get_db, create_turn, get_recent Turns
from backend.inference import call_llm

app = FastAPI(title="Collaborator Backend", version="0.1.0")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health_check():
    """Basic health check endpoint."""
    return {"status": "healthy", "version": "0.1.0"}


@app.post("/api/messages")
async def send_message(message: str, context_turns: int = 5, commit: bool = True):
    """
    Send a user message and get the model response.
    
    - **message**: The user's input
    - **context_turns**: Number of prior committed turns to include in context (default: 5)
    - **commit**: Whether to commit this turn to memory (default: true)
    """
    try:
        # Get context from recent committed turns
        db = get_db()
        recent_turns = get_recent_turns(db, limit=context_turns)
        
        # Call the LLM with context
        response = call_llm(message, recent_turns)
        
        # Persist the turn
        user_id = os.environ.get("USER_ID")  # Optional for multi-user support
        
        turn = create_turn(
            db,
            user_id=user_id,
            role="user",
            content=message,
            context_turns=context_turns,
            committed=commit
        )
        
        response_turn = create_turn(
            db,
            user_id=user_id,
            role="assistant",
            content=response,
            context_turns=context_turns,
            committed=commit
        )
        
        return {
            "id": response_turn["id"],
            "userId": user_id,
            "message": message,
            "response": response,
            "turnsAgo": 0,
            "committed": commit
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/messages")
async def get_messages(limit: int = 10, offset: int = 0):
    """Retrieve conversation history."""
    try:
        db = get_db()
        turns = get_recent_turns(db, limit=limit, offset=offset)
        return {"turns": turns, "count": len(turns)}
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
        return {"id": turn_id, "committed": False}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
