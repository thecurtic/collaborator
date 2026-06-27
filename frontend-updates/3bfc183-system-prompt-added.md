# Frontend Update: System Prompt Added

**Commit:** `3bfc183`  
**Date:** June 27, 2026

## Summary

System prompt moved from inline text in config to standalone `system-prompt.md` file.

## Impact on Frontend

### No API Changes
- Endpoint behavior unchanged
- Request/response schemas identical

### Config Changes
**Previous:**
```yaml
system_prompt:
  text: "You are Collaborator, a helpful assistant."
```

**New:**
```yaml
system_prompt:
  text: "You are Collaborator, a helpful assistant."  # fallback only
  file_path: "system-prompt.md"                        # actual prompt source
```

### Data Model Changes
None.

### Behavioral Changes

**Backend:**
- System prompt now loaded from `system-prompt.md` (if specified)
- Falls back to `text` field if `file_path` not set
- Backend processes same amount of token budget

**Frontend:**
- No UI changes needed
- Frontend doesn't display system prompt to user
- Only backend uses it for context assembly

## Testing Checklist

- [ ] Backend starts successfully with new config
- [ ] Messages still send/receive correctly
- [ ] System prompt is applied (backend logs show loaded prompt)
- [ ] Config fallback works if `file_path` removed

## Related Files

| File | Change |
|------|--------|
| `config.yaml` | Added `system_prompt.file_path` field |
| `system-prompt.md` | New file - Collaborator's philosophical guide |
| `backend/config.py` | Added file reading logic for system prompt |

## Key Changes in system-prompt.md

1. **Thinking partner** - not a task completer, search engine, therapist, or yes-man
2. **Depth over speed** - take time to reason before responding
3. **Honest about uncertainty** - say "I don't know" explicitly
4. **Respectful disagreement** - thinking together, not service relationship

## Notes

- Frontend doesn't need to display the system prompt
- This is purely backend context configuration
- The file is editable by users for easy tuning
