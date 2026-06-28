# Frontend Update: Voice Feature Backend Fixes

**Commit:** `bfcec48`  
**Date:** June 27, 2026

## Summary

Fixed /api/transcribe, /api/settings endpoints, and SSE buffering in production.

## Changes

### 1. Transcribe Endpoint Fixed

**Before (broken):**
```python
audio: bytes = File(...)
# ... tries audio.content_type and await audio.read() - AttributeError!
```

**After:**
```python
audio: UploadFile = File(...)  # Now has .content_type and .read()
```

**Request:**
```http
POST /api/transcribe
X-Passkey: <your-passkey>
Content-Type: multipart/form-data

Form fields:
- audio (required, binary)
- language (optional, string)
```

**Response:**
```json
{
  "text": "Transcribed text goes here"
}
```

**Error Handling:**
- 403: Missing/invalid passkey
- 413: File too large (>25MB)
- 422: Invalid content type
- 500: FFmpeg or Whisper error

### 2. Settings Endpoints Made Real

**GET /api/settings**
- Reads `voice_end_phrase` from config (not hardcoded)
- Falls back to "go ahead" if not configured

**PATCH /api/settings**
- Writes to `.config.yaml` under `voice:` section
- Reloads config for immediate effect

**Example:**
```typescript
// GET
const { voice_end_phrase } = await get('/api/settings');

// PATCH
await patch('/api/settings', {
  voice_end_phrase: "fill in the blank"
});
```

### 3. SSE Buffering Fix

**Problem:** Cloudflare buffers SSE streams (tokens arrive all at once)

**Solution:** Added `no-transform` to Cache-Control header

```python
headers={
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no"
}
```

Also disable Cloudflare:
- Rocket Loader: Off
- Compression: Off for `/api/messages` path

## Frontend Integration

### Streaming with Settings
```typescript
async function* streamWithSettings(message: string, endPhrase: string) {
  const tokens = [];
  
  for await (const token of streamMessages(message)) {
    tokens.push(token);
    
    // Check for end phrase
    const currentText = tokens.join('');
    if (currentText.toLowerCase().includes(endPhrase.toLowerCase())) {
      // Stop stream and submit
      break;
    }
    
    yield token;
  }
  
  return tokens.join('');
}
```

### Transcribe with Progress
```typescript
async function transcribeWithProgress(file: File) {
  const formData = new FormData();
  formData.append('audio', file);
  
  // Language optional
  if (selectedLanguage) {
    formData.append('language', selectedLanguage);
  }

  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'X-Passkey': localStorage.getItem('collaborator_passkey') },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Transcription failed: ${response.status}`);
  }

  const result = await response.json();
  return result.text;
}
```

### Settings UI
```typescript
function SettingsForm() {
  const [settings, setSettings] = useState({ voice_end_phrase: 'go ahead' });
  
  useEffect(() => {
    // Load settings on mount
    fetch('/api/settings')
      .then(r => r.json())
      .then(setSettings);
  }, []);
  
  async function handleChange(key: string, value: string) {
    const response = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 
        'Content-Type': 'application/json',
        'X-Passkey': localStorage.getItem('collaborator_passkey')
      },
      body: JSON.stringify({ [key]: value })
    });
    
    if (response.ok) {
      setSettings(await response.json());
    }
  }

  return (
    <form>
      <label>End-of-turn phrase:</label>
      <input
        value={settings.voice_end_phrase}
        onChange={e => handleChange('voice_end_phrase', e.target.value)}
      />
    </form>
  );
}
```

## Testing Checklist

- [ ] Transcribe accepts webm/mp4/ogg/wav files
- [ ] FFmpeg normalization works (16kHz mono WAV)
- [ ] Whisper transcription returns text
- [ ] Settings GET returns real config value
- [ ] Settings PATCH persists to .config.yaml
- [ ] Streaming tokens arrive incrementally (no buffering)
- [ ] Cache-Control header includes `no-transform`
- [ ] Cloudflare settings updated for streaming path

## Related Files

| File | Change |
|------|--------|
| `backend/main.py` | Fixed transcribe (UploadFile), real settings endpoints |
| `backend/config.py` | Added config reload on settings change |
| `API-SPEC.md` | Updated streaming headers documentation |
