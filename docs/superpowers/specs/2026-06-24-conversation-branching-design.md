# Conversation Branching Design

**Date:** 2026-06-24  
**Status:** Draft - for review

## Overview

This document defines the architecture and implementation plan for conversation branching in Collaborator. Conversations are structured as trees rather than linear lists, enabling exploration of multiple threads from any point.

## Core Concepts

### Tree Structure
- **Root** — The first turn in a conversation
- **Nodes/Turns** — Each message/response pair is a node
- **Edges** — Parent-child relationships define the tree structure
- **Branches** — Sibling nodes represent alternative paths from a fork point
- **Active Path** — The current path from root to the user's current position

### User Operations
1. **Fork** — Create a new branch at any turn
2. **Switch** — Move the active path to a different branch
3. **Synthesize** — Combine multiple branches into a unified response

## Schema Design

### Table: `turns`

```sql
CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,  -- NULL for anonymous/single-user mode
    
    -- Tree structure
    parent_turn_id INTEGER,
    branch_id TEXT NOT NULL,  -- All turns in same path share a branch_id
    turn_index INTEGER NOT NULL,  -- Position within the branch (0 = root)
    
    -- Content
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    
    -- Context control
    context_turns INTEGER NOT NULL DEFAULT 5,
    committed BOOLEAN NOT NULL DEFAULT 1,  -- If 0, discarded and excluded from context
    
    -- Metadata
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    model_name TEXT,           -- Which model was used
    token_count INTEGER,       -- Track usage
    
    -- Branch state tracking
    branch_state TEXT NOT NULL DEFAULT 'active',  -- active, exhausted, synthesized
    
    FOREIGN KEY (parent_turn_id) REFERENCES turns(id),
    UNIQUE(user_id, branch_id, turn_index)  -- Ensure unique position per branch
);
```

### Table: `branches` (metadata about branches)

```sql
CREATE TABLE branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id TEXT UNIQUE NOT NULL,  -- UUID for the branch
    parent_branch_id TEXT,
    fork_turn_id INTEGER NOT NULL,  -- Turn where this branch was created
    root_turn_id INTEGER NOT NULL,  -- First turn in this branch path
    title TEXT,                     -- Auto-generated or user-set
    is_active BOOLEAN NOT NULL DEFAULT 0,  -- Currently active branch path
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    FOREIGN KEY (fork_turn_id) REFERENCES turns(id),
    FOREIGN KEY (root_turn_id) REFERENCES turns(id)
);
```
```

## Design Rationale

### Active Branch Tracking

**Decision:** Use an explicit `is_active` flag on branches table rather than inferred from turn_index.

**Reasoning:** The branch with the highest `turn_index` is not necessarily the user's current location - they may have navigated away and back. The `is_active` flag explicitly tracks the current position.

**Alternative considered:** A separate `session_state` table would add unnecessary complexity for a single scalar value.

### Synthesis Phase

**Decision:** Move synthesis to Phase 3+ (after linear turns and basic branching work).

**Reasoning:** Synthesis is genuinely complex:
- Requires UI to select multiple branches for comparison
- Needs diff visualization for conflicting information
- Context assembly must pull from multiple branch paths
- Higher risk feature that could delay core functionality

**Risk Mitigation:** The schema design already supports branching natively. Linear conversations are just single-branch trees, so we're not painting ourselves into a corner by deferring synthesis.

### commits are immutable - once persisted, content cannot be changed
- `branch_id`: All turns in a linear path share the same branch_id
- `turn_index`: Position within that path (0 = first turn, N = Nth turn)
- Together they uniquely identify any turn's position in the tree
- Allows us to reconstruct any path through the tree

### Why `parent_turn_id`
- Direct reference for easy traversal up/down the tree
- Enables quick discovery of siblings (same parent)
- Required for proper foreign key relationships

### Why `branch_state`
- `active`: Normal operation, part of context assembly
- `exhausted`: User has explored all interesting paths from this branch
- `synthesized`: Result of combining multiple branches

## Database Operations

### Get Active Branch Path
```sql
SELECT t.*
FROM turns t
JOIN (
    SELECT branch_id, MAX(turn_index) AS max_index
    FROM turns
    WHERE user_id = ? AND committed = 1
    GROUP BY branch_id
) current ON t.branch_id = current.branch_id AND t.turn_index = current.max_index
WHERE t.user_id = ? AND t.committed = 1
ORDER BY t.created_at;
```

### Get Context for New Turn (last N committed turns on active branch)
```sql
SELECT content, role
FROM turns
WHERE user_id = ?
  AND committed = 1
  AND branch_id = (SELECT branch_id FROM turns WHERE id = ?)
  AND turn_index < ?
ORDER BY turn_index DESC
LIMIT ?;
```

### Create New Branch (Fork)
```sql
-- First, create the fork turn on new branch
INSERT INTO turns (user_id, parent_turn_id, branch_id, turn_index, role, content)
VALUES (?, ?, ?, 0, 'user', ?);

-- Then create the assistant response
INSERT INTO turns (user_id, parent_turn_id, branch_id, turn_index, role, content)
VALUES (?, last_insert_rowid(), ?, 1, 'assistant', ?);
```

### Get All Branches from Fork Point
```sql
SELECT DISTINCT t.branch_id, b.title, t.id AS first_turn_id
FROM turns t
LEFT JOIN branches b ON t.branch_id = b.branch_id
WHERE t.user_id = ? AND t.parent_turn_id = ?
ORDER BY t.created_at;
```

### Switch Active Branch
```sql
UPDATE branches SET is_active = 0;
UPDATE branches SET is_active = 1 WHERE branch_id = ?;
```

### Synthesis Turn
```sql
-- Create a new branch for the synthesis
INSERT INTO branches (branch_id, parent_branch_id, fork_turn_id, title)
VALUES (?, ?, ?, ?);

-- Insert synthesis turn
INSERT INTO turns (user_id, parent_turn_id, branch_id, turn_index, role, content, branch_state)
VALUES (?, ?, ?, 0, 'assistant', ?, 'synthesized');
```

## API Endpoints

### POST /api/messages
Send a user message on the current active branch.

**Request Body:**
```json
{
  "message": "Your message here",
  "contextTurns": 5,
  "commit": true
}
```

**Response:**
```json
{
  "id": 123,
  "userId": "user-1",
  "branchId": "abc-123",
  "turnIndex": 5,
  "message": "Your message here",
  "response": "The model's response",
  "committed": true
}
```

### POST /api/branches/fork
Fork from a specific turn to create a new branch.

**Request Body:**
```json
{
  "forkTurnId": 5,
  "message": "Starting new branch from turn {forkTurnId}",
  "contextTurns": 5
}
```

**Response:**
```json
{
  "forkedFromTurnId": 5,
  "newBranchId": "xyz-789",
  "newTurnId": 124,
  "message": "Starting new branch from turn {forkTurnId}",
  "response": "The model's response",
  "committed": true
}
```

### GET /api/branches/active
Get the current active branch path.

**Response:**
```json
{
  "branchId": "abc-123",
  "path": [
    {"turnId": 1, "branchIndex": 0},
    {"turnId": 2, "branchIndex": 1},
    {"turnId": 5, "branchIndex": 2},
    {"turnId": 8, "branchIndex": 3}
  ],
  "currentTurnId": 8
}
```

### POST /api/branches/{branchId}/activate
Switch to a different branch.

**Request Body:**
```json
{
  "branchId": "xyz-789"
}
```

### POST /api/synthesis
Initiate a synthesis turn that draws from multiple branches.

**Request Body:**
```json
{
  "branchIds": ["abc-123", "def-456"],
  "synthesisPrompt": "Combine insights from these branches into a coherent summary",
  "contextTurns": 5
}
```

**Response:**
```json
{
  "synthesisTurnId": 15,
  "branchId": "synth-001",
  "summary": "Based on branches abc-123 and def-456, the synthesized insight is...",
  "sourceBranches": [
    {"branchId": "abc-123", "turnIds": [7, 9]},
    {"branchId": "def-456", "turnIds": [12, 13]}
  ]
}
```

## Context Assembly Algorithm

### Get Active Branch Path
```python
def get_active_branch_path(db, user_id):
    # Find the currently active branch
    cursor = db.cursor()
    cursor.execute("""
        SELECT branch_id FROM branches WHERE is_active = 1
    """)
    row = cursor.fetchone()
    if not row:
        return None  # No active branch
    
    branch_id = row[0]
    
    # Get all turns on this branch in order
    cursor.execute("""
        SELECT * FROM turns 
        WHERE user_id = ? AND branch_id = ?
        ORDER BY turn_index
    """, (user_id, branch_id))
    
    columns = ['id', 'parent_turn_id', 'branch_id', 'turn_index', ...]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]
```

### Get Context from Active Branch
```python
def get_context_from_active_branch(db, user_id, limit=5):
    # Get active branch
    path = get_active_branch_path(db, user_id)
    current_turn_id = path[-1]['turnId']
    
    # Get last N committed turns on this branch
    cursor = db.cursor()
    cursor.execute("""
        SELECT content, role
        FROM turns
        WHERE user_id = ? AND branch_id = ?
          AND turn_index < (SELECT turn_index FROM turns WHERE id = ?)
        ORDER BY turn_index DESC
        LIMIT ?
    """, (user_id, branch_id, current_turn_id, limit))
    
    return cursor.fetchall()
```

## Phase Plan

### Phase 1: Core Linear System (Current)
- [ ] SQLite schema with `turns` table
- [ ] Basic message → inference → persist flow
- [ ] Discard mechanism (`committed` flag)
- [ ] Context assembly from last N committed turns

### Phase 2: Branching Foundation
- [ ] Add `branch_id` and `turn_index` to turns table
- [ ] Add `branches` table with `is_active` flag
- [ ] Fork endpoint (create new branch at any turn)
- [ ] Switch endpoint (change active branch)
- [ ] Context assembly along active path

### Phase 3: UI for Branching (PWA)
- [ ] Vertical tree visualization
- [ ] Fork point highlighting
- [ ] Branch switching interface
- [ ] Branch metadata display

### Phase 4: Synthesis
- [ ] Multi-branch selection UI
- [ ] Diff visualization for conflicting info
- [ ] Synthesis turn creation endpoint
- [ ] Context assembly from multiple branches

## Migration Path

### From Linear to Tree Structure
1. Add new columns to `turns` table with default values
2. Migrate existing data: assign all turns to single branch `branch_0`
3. Set `turn_index` sequentially for existing turns in each branch
4. Create initial `branches` table with one entry per conversation
5. Update API to handle both old (linear) and new (tree) formats

## Frontend Considerations

### Vertical Tree Visualization
- Display the active path as a vertical timeline
- Fork points show multiple branches extending downward
- Users can expand/collapse branches
- Mobile-first design: single column with clear visual indicators

### Navigation Patterns
- **Back to fork**: Return to parent branch after exploring child
- **Switch branches**: Click on sibling branch to switch active path
- **Synthesize view**: Show multiple branches side-by-side for comparison
