# Frontend Update: Context Data, System Prompt, and AGENTS.md Exposed

**Commit:** `b81f527`  
**Date:** June 27, 2026

## Summary

Backend now exposes live context data, system prompt content, and AGENTS.md to frontend via API responses.

## Impact on Frontend

### New Response Fields (POST /api/messages)

| Field | Type | Description |
|-------|------|-------------|
| `context_turns_used` | `Turn[]` | The actual turn objects being used as context for this response |
| `system_prompt` | `string` | The full system prompt text (loaded from file if configured) |
| `agents_md_content` | `string?` | AGENTS.md content for frontend reference |

### New Response Fields (GET /api/messages)

| Field | Type | Description |
|-------|------|-------------|
| `context_turns_used` | `int` | Number of turns configured for context window |

### API-SPEC.md Updated

The API specification now documents these new response fields. Frontend developers should update their TypeScript interfaces:

```typescript
interface MessageResponse {
  id: number;
  user_id?: string | null;
  message: string;
  response: string;
  committed: boolean;
  context_turns_used: Turn[];    // NEW
  system_prompt: string;          // NEW
  agents_md_content?: string;     // NEW
}

interface MessagesListResponse {
  turns: Turn[];
  count: number;
  context_turns_used?: number;    // NEW
}
```

### Usage Examples

**Display Context Turns:**
```typescript
// Show user what turns are being used as context
const { context_turns_used, system_prompt } = await sendMessage(message);

console.log("Context turns:", context_turns_used.length);
context_turns_used.forEach(turn => {
  console.log(`${turn.role}: ${turn.content.substring(0, 50)}...`);
});

console.log("System prompt:", system_prompt);
```

**Show AGENTS.md to User:**
```typescript
// Load and display project documentation
const agentsResponse = await fetch('/api/messages');
const { agents_md_content } = await agentsResponse.json();

// Display in help modal or settings
<div className="agents-docs">{agents_md_content}</div>
```

**Track Context Window:**
```typescript
// GET response shows how many turns are in context window
const { context_turns_used } = await getMessages();
console.log(`Context window size: ${context_turns_used}`); // e.g., 5
```

## Testing Checklist

- [ ] POST response includes `context_turns_used` array
- [ ] POST response includes `system_prompt` string
- [ ] GET response includes `context_turns_used` count
- [ ] System prompt matches content in `system-prompt.md`
- [ ] AGENTS.md content is loaded and accessible
- [ ] Frontend types updated to match new response schema

## Related Files

| File | Change |
|------|--------|
| `backend/main.py` | Added new response fields to models |
| `backend/data/agents_md.py` | New file - loads AGENTS.md content |
| `API-SPEC.md` | Updated with new response models |

## Notes

- `agents_md_content` is optional - may be empty if AGENTS.md not found
- System prompt is always loaded from file if `system_prompt.file_path` configured
- Frontend should handle empty/missing fields gracefully
