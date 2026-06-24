# Collaborator SQLite Schema Design

**Date:** 2026-06-24  
**Status:** Draft - for review

## Overview

This document defines the SQLite schema for storing conversation turns in Collaborator's backend.

## Core Principles

1. **Turns are immutable** - once persisted, content cannot be changed
2. **Discard is a flag, not deletion** - discarded turns remain in the database but are excluded from context
3. **User-agnostic by default** - schema supports multi-user or single-user scenarios via `userId`

## Schema

### Table: `turns`

```sql
CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,  -- NULL for anonymous/single-user mode
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    context_turns INTEGER NOT NULL DEFAULT 5,  -- Number of prior turns to include in context
    committed BOOLEAN NOT NULL DEFAULT 1,        -- If 0, turn is discarded and excluded from context
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- Optional metadata for advanced features
    model_name TEXT,           -- Which model was used (for versioning)
    token_count INTEGER,       -- Track usage if needed
    tags TEXT                  -- JSON array of string tags for categorization
);
```

### Table: `conversations` (optional, for multi-user organizing)

```sql
CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,              -- Auto-generated or user-set
    first_turn_id INTEGER,   -- Reference to first turn in conversation
    last_updated TEXT NOT NULL DEFAULT (datetime('now')),
    
    FOREIGN KEY (first_turn_id) REFERENCES turns(id)
);
```

## Rationale

### Why `userId` can be NULL
- Single-user mode: All turns belong to the same implicit user
- Multi-user mode: Each user has a unique ID (e.g., UUID or email hash)

### Why `committed` flag instead of deletion
- User can "discard" a turn before it affects future context
- Discarded turns stay in database for audit/history
- Simplifies UI: one query to fetch committed context, another to show all turns

### Why `context_turns` per turn
- Each turn can specify how many prior turns should be included in context
- Allows flexible history window per message (e.g., 5 for normal, 0 for follow-up)
- Default of 5 matches typical chat context window

### Why `created_at` uses TEXT
- SQLite stores ISO 8601 strings efficiently
- Easy to query and sort
- Timezone-aware if needed (`datetime('now', 'utc')`)

## Queries

### Get context for new turn
```sql
SELECT content, role 
FROM turns 
WHERE user_id = ? 
  AND committed = 1 
  AND id > ?  -- after the last turn ID
ORDER BY id DESC 
LIMIT ?;  -- context_turns value
```

### Get all turns for a conversation (with discard status)
```sql
SELECT id, role, content, committed, created_at 
FROM turns 
WHERE user_id = ? 
ORDER BY id DESC 
LIMIT ?;
```

### Insert a new turn
```sql
INSERT INTO turns (user_id, role, content, context_turns, committed)
VALUES (?, ?, ?, ?, ?);
```

### Discard a turn (mark as uncommitted)
```sql
UPDATE turns SET committed = 0 WHERE id = ?;
```

## Migration Plan

When adding this schema to an existing project:

1. Create the `turns` table
2. Populate with any test messages (if needed)
3. Update API to use new storage layer
4. Add `committed` column if upgrading from simple storage

## Future Enhancements

- `deleted_at` timestamp for soft deletes (if needed)
- `updated_at` trigger on commit flag change
- `session_id` for chat session tracking
- `embeddings` column for similarity search (if needed)
