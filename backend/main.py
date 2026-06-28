from fastapi import FastAPI, HTTPException, Header, UploadFile, Form, Request, File
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
from db import init_db, create_turn, get_recent_turns, update_turn_committed, get_turn_by_id
from inference import call_llm_streaming, call_llm_non_streaming
from auth import validate_passkey, create_user_db

app = FastAPI()

# Initialize config
config = get_config()

# Check if authentication is enabled
auth_enabled = config.get("authentication", {}).get("enabled", False)

# Initialize database on startup
init_db()


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
    context_turns_used: List[dict]
    system_prompt: str


class MessagesListResponse(BaseModel):
    turns: List[dict]
    count: int
    context_turns_used: Optional[int] = None


class DiscardTurnResponse(BaseModel):
    id: int
    committed: bool


class SettingsResponse(BaseModel):
    voice_end_phrase: str


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
    Send a user message and get the model response (streaming).
    
    - **message**: The user's input
    - **context_turns**: Number of prior committed turns to include in context (default: 5)
    - **commit**: Whether to commit this turn to memory (default: true)
    - **X-Passkey**: User's passkey for authentication
    """
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    try:
        db_path_config = config.get("memory", {}).get("db_path")
        
        if auth_enabled:
            db_path = create_user_db(passkey)
        else:
            if db_path_config and not os.path.isabs(db_path_config):
                db_path = resolve_path(db_path_config)
            else:
                db_path = db_path_config
        
        conn = sqlite3.connect(db_path)
        
        recent_turns = get_recent_turns(conn, limit=request.context_turns)
        
        # Load system prompt
        system_prompt_text = config.get("system_prompt", {}).get("text", "")
        file_path = config.get("system_prompt", {}).get("file_path")
        if file_path:
            try:
                with open(resolve_path(file_path), 'r') as f:
                    system_prompt_text = f.read().strip()
            except IOError:
                pass
        
        # Build context turns for response
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
        
        # Streaming response generator
        def event_generator():
            result = call_llm_streaming(request.message, recent_turns)
            
            # Emit tokens
            for char in result.text:
                yield f"data: {json.dumps({'type': 'token', 'content': char})}\n\n"
            
            # Persist the turn (for both user and assistant)
            user_id = request.user_id or os.environ.get("USER_ID")
            
            turn = create_turn(
                conn,
                user_id=user_id,
                role="user",
                content=request.message,
                context_turns=request.context_turns,
                committed=request.commit
            )
            
            assistant_turn = create_turn(
                conn,
                user_id=user_id,
                role="assistant",
                content=result.text,
                context_turns=request.context_turns,
                committed=request.commit
            )
            
            conn.close()
            
            # Final done event with metadata
            yield f"data: {json.dumps({'type': 'done', 'id': assistant_turn['id'], 'context_turns_used': request.context_turns})}\n\n"
        
        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no"
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        # Emit error event then close stream
        def error_generator():
            yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"
        
        return StreamingResponse(
            error_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no"
            }
        )


@app.get("/api/messages")
async def get_messages(
    limit: int = 10,
    offset: int = 0,
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """Retrieve conversation history."""
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    try:
        db_path_config = config.get("memory", {}).get("db_path")
        
        if auth_enabled:
            db_path = create_user_db(passkey)
        else:
            if db_path_config and not os.path.isabs(db_path_config):
                db_path = resolve_path(db_path_config)
            else:
                db_path = db_path_config
        
        conn = sqlite3.connect(db_path)
        
        turns = get_recent_turns(conn, limit=limit, offset=offset)
        
        # Load system prompt
        system_prompt_text = config.get("system_prompt", {}).get("text", "")
        file_path = config.get("system_prompt", {}).get("file_path")
        if file_path:
            try:
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
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    try:
        db_path_config = config.get("memory", {}).get("db_path")
        
        if auth_enabled:
            db_path = create_user_db(passkey)
        else:
            if db_path_config and not os.path.isabs(db_path_config):
                db_path = resolve_path(db_path_config)
            else:
                db_path = db_path_config
        
        conn = sqlite3.connect(db_path)
        
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


def get_voice_end_phrase_from_config() -> str:
    """Get voice end phrase from config or default."""
    try:
        cfg = get_config()
        return cfg.get("voice_end_phrase", "go ahead")
    except:
        return "go ahead"


def save_voice_end_phrase(phrase: str) -> None:
    """Save voice end phrase to .config.yaml and reload."""
    import os
    import yaml
    
    project_root = resolve_path(".")
    config_path = os.path.join(project_root, ".config.yaml")
    
    # Load existing .config.yaml or create empty
    existing = {}
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as f:
                existing = yaml.safe_load(f) or {}
        except:
            existing = {}
    
    # Update voice_end_phrase
    if "voice" not in existing:
        existing["voice"] = {}
    existing["voice"]["voice_end_phrase"] = phrase
    
    # Write back
    with open(config_path, 'w') as f:
        yaml.dump(existing, f)
    
    # Reload config
    if hasattr(get_config, "_config"):
        delattr(get_config, "_config")


@app.get("/api/settings")
async def get_settings(
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """Get current voice settings."""
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    return SettingsResponse(voice_end_phrase=get_voice_end_phrase_from_config())


@app.patch("/api/settings")
async def patch_settings(
    settings: SettingsResponse,
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """Update voice settings."""
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    # Save to config
    save_voice_end_phrase(settings.voice_end_phrase)
    
    return settings


@app.post("/api/transcribe")
async def transcribe_audio(
    request: Request,
    audio: bytes = File(...),
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
    
    # Validate content type
    content_type = audio.content_type
    valid_types = ["audio/webm", "video/webm", "audio/ogg", "video/ogg",
                   "audio/mp4", "video/mp4", "audio/wav", "audio/x-wav"]
    
    if content_type and content_type not in valid_types:
        raise HTTPException(status_code=422, detail=f"Invalid content type: {content_type}. Accepts: webm/opus, mp4/aac, ogg/opus, wav")
    
    try:
        # Read audio data
        audio_data = await audio.read()
        
        # Create temp file for processing
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            # Use ffmpeg to normalize audio
            import subprocess
            process = await asyncio.create_subprocess_exec(
                "ffmpeg", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav",
                tmp.name,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await process.communicate(input=audio_data)
            
            if process.returncode != 0:
                raise HTTPException(status_code=500, detail=f"FFmpeg error: {stderr.decode()}")
            
            # Call Whisper
            whisper_command = ["whisper", tmp.name, "--model", "base", "--language", language or ""]
            result = subprocess.run(whisper_command, capture_output=True, text=True)
            
            if result.returncode != 0:
                raise HTTPException(status_code=500, detail=f"Whisper error: {result.stderr}")
            
            # Extract text from Whisper output
            import re
            match = re.search(r'"text": "([^"]+)"', result.stdout)
            if match:
                text = match.group(1).replace('\\"', '"')
            else:
                text = result.stdout.strip()
            
            return {"text": text}
            
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
