# Frontend Update: Streaming Response Support

**Commit:** `b81f527`  
**Date:** June 27, 2026

## Summary

Backend now supports Server-Sent Events (SSE) streaming for real-time LLM responses. Streaming is enabled by default.

## Impact on Frontend

### API Changes

**POST /api/messages - Response Format**

Before (single response):
```json
{
  "id": 42,
  "response": "Full response text here...",
  ...
}
```

After (streaming with SSE):
```http
HTTP/1.1 201 Created
Content-Type: text/event-stream

data: {"type":"token","content":"Hi"}
data: {"type":"token","content":" there"}
data: {"type":"token","content":"!"}
data: {"type":"done"}

```

### Frontend Implementation

**Simple Streaming Example (EventSource):**
```typescript
async function sendMessageStreaming(message: string) {
  const response = await fetch('/api/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Passkey': localStorage.getItem('collaborator_passkey')
    },
    body: JSON.stringify({ message, commit: true })
  });

  // Parse SSE stream
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          
          if (dataStr === '[DONE]') {
            // Stream complete
            break;
          }
          
          try {
            const data = JSON.parse(dataStr);
            
            if (data.type === 'token') {
              // Update UI with incremental token
              fullResponse += data.content;
              updateMessageDisplay(fullResponse);
            } else if (data.type === 'done') {
              // Stream complete - final data may include context
            }
          } catch (e) {
            console.warn('Failed to parse SSE data:', e);
          }
        }
      }
    }
  }

  return fullResponse;
}
```

**Using ReadableStream (Modern Browsers):**
```typescript
async function* streamTokens(response: Response) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  if (!reader || !response.body) return;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          
          if (dataStr === '[DONE]') {
            return;
          }

          try {
            const data = JSON.parse(dataStr);
            if (data.type === 'token') {
              yield data.content;
            }
          } catch (e) {
            // Ignore malformed SSE lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function sendMessageWithStream(message: string) {
  const response = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });

  // Collect all tokens
  const tokens = [];
  for await (const token of streamTokens(response)) {
    tokens.push(token);
    updateDisplay(tokens.join(''));
  }

  return tokens.join('');
}
```

**React Integration:**
```typescript
function ChatComponent() {
  const [messages, setMessages] = useState<{role: string, content: string}[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  async function handleSend(message: string) {
    const newMessage = { role: 'user', content: message };
    setMessages(prev => [...prev, newMessage]);
    
    setIsStreaming(true);
    let fullResponse = '';
    
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
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          
          if (dataStr === '[DONE]') break;
          
          try {
            const data = JSON.parse(dataStr);
            
            if (data.type === 'token') {
              fullResponse += data.content;
              
              // Update UI with streaming response
              setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg?.role === 'assistant') {
                  return [
                    ...prev.slice(0, -1),
                    { role: 'assistant', content: fullResponse }
                  ];
                }
                return [...prev, { role: 'assistant', content: fullResponse }];
              });
            }
          } catch (e) {
            console.warn('Parse error:', e);
          }
        }
      }
    }

    setIsStreaming(false);
  }

  return (
    <div className="chat-container">
      {messages.map((msg, i) => (
        <div key={i} className={`message ${msg.role}`}>
          {msg.content}
        </div>
      ))}
      <button disabled={isStreaming} onClick={() => handleSend(input)}>
        {isStreaming ? '...' : 'Send'}
      </button>
    </div>
  );
}
```

### Server-Sent Event Format

Each line follows SSE format:
```
data: {"type":"token","content":"text"}
```

Where:
- `type`: Either `"token"` (partial response) or `"done"` (stream complete)
- `content`: The actual text fragment for this token

### Breaking Changes

**None** - Non-streaming mode still available via `call_llm_non_streaming()` if needed.

### Testing Checklist

- [ ] POST `/api/messages` returns streaming response
- [ ] Token events are received incrementally
- [ ] `type: "done"` signal indicates completion
- [ ] UI updates with each token (not waiting for full response)
- [ ] Cancel/stop button works during streaming
- [ ] Error handling during stream interruption

### Related Files

| File | Change |
|------|--------|
| `backend/inference.py` | Added `call_llm_streaming()` with SSE support |
| `backend/main.py` | Updated to use streaming endpoint |
| `API-SPEC.md` | Documented SSE response format |
