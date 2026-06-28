# Frontend Update: Streaming Response + Settings/Transcribe

**Commit:** `73282db`  
**Date:** June 27, 2026

## Summary

Streaming format standardized, plus new endpoints for settings (`GET/PATCH /api/settings`) and transcription (`POST /api/transcribe`). TTS is handled by Piper WASM on frontend.

## API Changes

### Streaming Response Format (POST /api/messages)

Standardized SSE format:

```
data: {"type":"token","content":"Hi"}
data: {"type":"token","content":" there"}
data: {"type":"done","id":42,"context_turns_used":5}
```

**Event Types:**

| Type | Description |
|------|-------------|
| `token` | Partial response chunk (includes `content`) |
| `done` | Stream complete (includes `id`, `context_turns_used`) |

**Error Event:**
```
data: {"type":"error","detail":"Error message"}
```

**Response Headers (to prevent buffering):**
- `Cache-Control: no-cache`
- `X-Accel-Buffering: no`

**Frontend Parsing Example:**
```typescript
interface SSEEvent {
  type: 'token' | 'done' | 'error';
  content?: string;
  id?: number;
  context_turns_used?: number;
  detail?: string;
}

async function* streamMessages(message: string) {
  const response = await fetch('/api/messages', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'X-Passkey': localStorage.getItem('collaborator_passkey')
    },
    body: JSON.stringify({ message })
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader?.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      
      const dataStr = line.slice(6).trim();
      
      if (dataStr === '[DONE]') break;
      
      try {
        const event: SSEEvent = JSON.parse(dataStr);
        
        if (event.type === 'token' && event.content) {
          yield event.content;
        } else if (event.type === 'done') {
          console.log('Final metadata:', event);
        } else if (event.type === 'error') {
          throw new Error(event.detail || 'Streaming error');
        }
      } catch (e) {
        console.warn('Parse error:', e);
      }
    }
  }
}
```

### Settings Endpoint

**GET /api/settings**
```json
{
  "voice_end_phrase": "go ahead"
}
```

**PATCH /api/settings**
```json
// Request
{
  "voice_end_phrase": "go ahead"
}

// Response (same structure)
{
  "voice_end_phrase": "go ahead"
}
```

### Transcribe Endpoint

**POST /api/transcribe**
- Upload audio (webm/opus, mp4/aac, ogg/opus, wav)
- FFmpeg normalizes → Whisper STT
- Max 25MB file size
- 403/413/422/500 error codes

```json
// Request (multipart/form-data)
{
  audio: <binary>,
  language?: "en"
}

// Response
{
  "text": "Transcribed text goes here"
}
```

## Frontend Implementation

### Streaming + TTS Integration
```typescript
async function handleSend(message: string) {
  const userMsgId = Date.now();
  
  // Add user message
  setMessages(prev => [...prev, { 
    id: userMsgId, 
    role: 'user', 
    content: message 
  }]);

  // Start streaming
  const tokens = [];
  for await (const token of streamMessages(message)) {
    tokens.push(token);
    
    // Feed to Piper for TTS
    const textChunk = tokens.join('');
    await piper.speak(textChunk);
    
    // Update UI
    updateMessageDisplay(tokens.join(''));
  }

  // Stream complete - final metadata available
}
```

### Settings Modal
```typescript
async function updateSettings(key: string, value: any) {
  const response = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 
      'Content-Type': 'application/json',
      'X-Passkey': localStorage.getItem('collaborator_passkey')
    },
    body: JSON.stringify({ [key]: value })
  });
  
  const settings = await response.json();
  setVoiceEndPhrase(settings.voice_end_phrase);
}
```

### Transcription
```typescript
async function transcribeAudio(file: File) {
  const formData = new FormData();
  formData.append('audio', file);
  
  if (selectedLanguage) {
    formData.append('language', selectedLanguage);
  }

  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 
      'X-Passkey': localStorage.getItem('collaborator_passkey')
    },
    body: formData
  });
  
  const result = await response.json();
  return result.text;
}
```

## Testing Checklist

- [ ] Streaming tokens arrive incrementally
- [ ] `done` event contains `id` and `context_turns_used`
- [ ] Error events format: `{type:"error",detail:"..."}`
- [ ] Settings GET/PATCH round-trips correctly
- [ ] Transcribe accepts webm/mp4/ogg/wav
- [ ] FFmpeg normalization works
- [ ] Whisper transcription accurate

## Related Files

| File | Change |
|------|--------|
| `backend/inference.py` | StreamingResponse class, consistent SSE format |
| `backend/main.py` | Added `/api/settings`, `/api/transcribe` endpoints |
| `API-SPEC.md` | Updated with streaming format, settings, transcribe |

## Notes

- TTS (Piper WASM) runs entirely on frontend
- Streaming enables real-time text + audio sync
- Settings persist to config.yaml (backend reloads)
- Transcribe is stateless, fast (~2s interval calls)
