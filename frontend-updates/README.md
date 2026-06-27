# Frontend Update Notes

This directory contains one-pagers for commits that affect frontend development.

## How to Use This Directory

- **Frontend developers**: Read these one-pagers when pulled to understand what backend changes may affect your work
- **Backend developers**: Create a one-pager for each commit that impacts the API, config, or data models
- **Manual pruning**: Periodically review and remove outdated one-pagers (these are temporary guides)

## One-Pager Format

Each file should be named: `{commit-hash}-{short-description}.md`

Example:
```
3bfc183-system-prompt-added.md
```

Content should include:

### Summary (1 sentence)
A one-sentence summary of what changed and why.

### Impact on Frontend
- **API changes**: Any endpoint modifications, new endpoints, or removed endpoints
- **Config changes**: New configuration options or changed defaults
- **Data model changes**: Schema modifications, new fields, removed fields
- **Behavioral changes**: How the frontend should adapt to new behavior

### Testing Checklist
- [ ] Verify API calls work with new endpoints
- [ ] Check config loading with new options
- [ ] Test data model changes in UI
- [ ] Verify error handling for behavioral changes

### Related Files
- API-SPEC.md (if endpoint changed)
- config.yaml.example (if config structure changed)
- INTENTS.md (if philosophical changes)

---

## Current One-Pagers

### June 27, 2026
- `3bfc183-system-prompt-added.md` - System prompt moved to external Markdown file

---
