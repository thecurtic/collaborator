import re

content = open('main.py').read()

# Fix 1: transcribe endpoint
old_transcribe = '''async def transcribe_audio(
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
    content_type = request.headers.get("content-type", "")
    valid_types = ["audio/webm", "video/webm", "audio/ogg", "video/ogg",
                   "audio/mp4", "video/mp4", "audio/wav", "audio/x-wav"]
    
    if content_type and not any(vt in content_type for vt in valid_types):
        raise HTTPException(status_code=422, detail=f"Invalid content type. Accepts: webm/opus, mp4/aac, ogg/opus, wav")
    
    try:
        import tempfile
        import subprocess
        
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            # Use ffmpeg to normalize audio
            process = subprocess.Popen(
                ["ffmpeg", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", tmp.name],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            stdout, stderr = process.communicate(input=audio)
            
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
        raise HTTPException(status_code=500, detail=str(e))'''

new_transcribe = '''def transcribe_audio(
    request: Request,
    audio: UploadFile = File(...),
    language: Optional[str] = Form(None),
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """Transcribe audio to text using Whisper.
    
    Accepts: webm/opus, mp4/aac, ogg/opus, wav
    Returns: { "text": "<transcript>" }
    """
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    # Check file size (25MB limit)
    content_length = int(request.headers.get("content-length", 0))
    if content_length > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 25MB)")
    
    # Read audio data
    audio_data = audio.file.read()
    
    try:
        import tempfile
        import subprocess
        
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            # Use ffmpeg to normalize audio
            process = subprocess.Popen(
                ["ffmpeg", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", tmp.name],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            stdout, stderr = process.communicate(input=audio_data)
            
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
                # Fallback: try to find any text output
                lines = result.stdout.strip().split('\\n')
                for line in lines:
                    if line.strip():
                        text = line.strip()
                        break
                else:
                    text = result.stderr if result.stderr else "Transcription failed"
            
            return {"text": text}
            
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))'''

content = content.replace(old_transcribe, new_transcribe)

# Fix 2: Settings endpoints
old_settings = '''@app.get("/api/settings")
async def get_settings(
    passkey: Optional[str] = Header(None, alias="X-Passkey")
):
    """Get current voice settings."""
    if auth_enabled:
        if not passkey:
            raise HTTPException(status_code=403, detail="Passkey required")
        if not validate_passkey(passkey):
            raise HTTPException(status_code=403, detail="Invalid or revoked passkey")
    
    return SettingsResponse(voice_end_phrase="go ahead")


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
    
    return settings'''

new_settings = '''def get_voice_end_phrase_from_config() -> str:
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
    
    return settings'''

content = content.replace(old_settings, new_settings)

# Fix 3: Add no-transform to Cache-Control
old_cache = '''headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no"
            }'''

new_cache = '''headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no"
            }'''

content = content.replace(old_cache, new_cache)

# Fix 4: Add import for UploadFile at top
old_import = 'from fastapi import FastAPI, HTTPException, Header, UploadFile, Form, Request, File'
content = content.replace(old_import, old_import)  # Already correct

open('main.py', 'w').write(content)
print("Fixed all issues")
