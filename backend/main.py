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
from inference import call_llm_streaming, call_llm_non_streaming, stream_llm_tokens
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
    context_turns: Optional[int] = 5
    commit: Optional[bool] = True
    user_id: Optional[str] = None
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


class DiscardTurnResponse(BaseModel):
    id: int
    committed: bool


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
        
        # Fetch context with a short-lived connection on this (request) thread.
        # The streaming generator below runs on a separate worker thread, so it
        # must NOT reuse this connection — SQLite forbids cross-thread use.
        conn = sqlite3.connect(db_path)
        try:
            recent_turns = get_recent_turns(conn, limit=request.context_turns)
        finally:
            conn.close()

        # Streaming response generator
        def event_generator():
            full_response = ""
            try:
                # True token-by-token streaming from the LLM.
                for content in stream_llm_tokens(request.message, recent_turns, mode=request.mode):
                    full_response += content
                    yield f"data: {json.dumps({'type': 'token', 'content': content})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"
                return

            # Persist both turns. Open a fresh connection on THIS thread so the
            # write does not cross threads.
            try:
                user_id = request.user_id or os.environ.get("USER_ID")
                gen_conn = sqlite3.connect(db_path)
                try:
                    create_turn(
                        gen_conn,
                        user_id=user_id,
                        role="user",
                        content=request.message,
                        context_turns=request.context_turns,
                        committed=request.commit,
                    )
                    assistant_turn = create_turn(
                        gen_conn,
                        user_id=user_id,
                        role="assistant",
                        content=full_response,
                        context_turns=request.context_turns,
                        committed=request.commit,
                    )
                finally:
                    gen_conn.close()
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'detail': str(e)})}\n\n"
                return

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
                with open(resolve_path(file_path), 'r', encoding='utf-8') as f:
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

        # Transcribe: prefer the whisper python module, fall back to the CLI.
        text = None

        try:
            import whisper
            model = whisper.load_model("base")
            result_obj = model.transcribe(tmp_path, language=language or "en")
            text = result_obj["text"]
        except HTTPException:
            raise
        except Exception:
            # Python module unavailable/failed — fall back to the whisper CLI.
            try:
                result = subprocess.run(
                    ["whisper", tmp_path, "--model", "base", "--language", language or "en",
                     "--output_format", "txt"],
                    capture_output=True, text=True
                )
            except FileNotFoundError:
                raise HTTPException(
                    status_code=500,
                    detail="Whisper is not installed on the server (neither the python "
                           "module nor the CLI). Install 'openai-whisper' to enable transcription."
                )

            if result.returncode != 0:
                raise HTTPException(status_code=500, detail=f"Whisper error: {result.stderr}")

            # Extract text from CLI output (JSON-ish, then first non-empty line).
            match = re.search(r'"text":\s*"([^"]+)"', result.stdout)
            if match:
                text = match.group(1).replace('\\"', '"')
            else:
                for line in result.stdout.split('\n'):
                    if line.strip():
                        text = line.strip()
                        break

        if text is None:
            raise HTTPException(status_code=500, detail="Could not extract transcription")

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


if __name__ == "__main__":
    import uvicorn
    server_config = config.get("server", {})
    host = server_config.get("backend_host", "0.0.0.0")
    port = server_config.get("backend_port", 8000)
    
    print(f"Starting Collaborator Backend on {host}:{port}")
    print(f"Authentication: {'enabled' if auth_enabled else 'disabled'}")
    uvicorn.run(app, host=host, port=port)
