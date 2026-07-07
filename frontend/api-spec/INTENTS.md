# Collaborator Intent Document

A living document describing the core philosophy, architecture decisions, and intended behavior of Collaborator.

**Last Updated:** 2026-07-06

> **Implementation status (2026-07-06):** The atomic-notes layer is underway. The
> note file format is specified in `NOTES-FORMAT.md` (one markdown file per idea,
> title-as-filename, app-managed frontmatter with local tags + `source_turns`
> provenance, `[[wikilinks]]` as local graph edges; Nostr kind-1 export deferred —
> events and their tags are constructed at signing time, all frontmatter stripped).
> The full pipeline is implemented: `GET /api/tree/{id}/export` (turns → nested
> JSON), `POST /api/notes/synthesize/{tree_id}` (one LLM pass via the editable
> `synthesis-notes.md` → pending drafts), and the curation gate
> (`/api/notes/drafts` review/edit/approve/reject; approval stamps frontmatter and
> writes `<Title>.md` into the vault — the vault holds approved notes only).
> Next: the notes index (embeddings/backlinks for recall + dedupe) and read-only
> notes tools on the tool loop.

> **Implementation status (2026-06-29):** Recall v1 is implemented on the backend —
> recall runs inside the send (embed → cosine search → synthesize → stream as a
> `recall` event → inject into context), embeddings + synthesis go through LM Studio,
> tags via `PATCH /api/turns/{id}/tags`, ephemeral current block via
> `GET /api/recall/current`, backfill via `POST /api/recall/reindex`. Deferred:
> edit-severity flow (interrupt/restart vs continue) and per-turn recall auditing.

---

## Core Philosophy

Collaborator is built on three principles:

1. **Full Visibility** - Every piece of context entering the model must be visible and explainable
2. **Full Editability** - Users should be able to edit, curate, and weight any contextual element before it influences the response
3. **First-Class Memory** - Conversational history isn't just logs; it's an editable knowledge base that actively shapes responses

---

## Collaborator System Prompt

You are Collaborator, a thinking partner for deep exploration across any domain—personal, technical, philosophical, creative, relational. Anything goes.

Your role is to think alongside the user. Not to solve for them, but to help them clarify, explore, challenge, and synthesize. They decide. You think with them.

### How to Think

- Go deep. Depth matters more than speed. Take time to reason before responding.
- Ask clarifying questions when meaning is unclear or the problem isn't fully formed yet.
- Challenge assumptions gently—flag inconsistencies, unexamined premises, and alternative framings when you see them.
- Synthesize across domains. A personal dilemma might parallel a technical problem discussed in a past branch. Make those connections.
- Integrate information from memory, web search, documents, and past conversation turns into your reasoning. Surface your sources so the user understands what shaped your thinking.
- Be honest about uncertainty. Say "I don't know" when you don't. Flag speculation clearly. Acknowledge limits.
- Respectful disagreement is thinking together. Don't agree just to agree.

### Memory and Context

You have access to the user's full conversation history including all branches explored, decisions made, and questions left open. A recall block precedes each turn summarizing what's relevant from that history. Use it. If something was decided or explored before, reference it rather than starting from scratch.

The recall block is not a summary to ignore—it is your memory speaking. Treat it as such.

### What You Are Not

You're not a task completer, search engine, therapist, or yes-man. You're a thinking partner. That's a peer relationship, not a service relationship.

### Tone

Thoughtful. Direct. Curious. Honest.

---

## Default Recall Behavior

Recall fires automatically on every prompt unless explicitly disabled. This ensures users never miss relevant memories, even for simple questions.

**Configuration:**
```yaml
recall:
  enabled: true        # Set to false to disable recall globally
  per_conversation: true  # Can be toggled per conversation
```

### How Recall Works

1. **Incoming message is embedded**
2. **Full database search** for semantically similar turns
3. **Tag boosts applied** (customizable)
4. **Synthesis LLM call** creates first-person memory block
5. **Simultaneous action:** Recall block is:
   - Displayed to user (above response area)
   - Added to context for immediate model processing
6. **Model generates response** using recall + recent window + current message

### User Edits the Recall Block

If user edits the recall block:

**Option A: Interrupt and Restart (default for major changes)**
- Current response generation is interrupted
- New recall synthesis processed with edited text
- Fresh response generated immediately

**Option B: Continue and Replace (default for minor edits)**
- Current response continues with original context
- Edited recall block replaces the previous one in database
- Next interaction uses updated recall

**User Settings:**
```yaml
recall_edit_behavior:
  minor_edits_replace: true     # Default: yes
  major_edits_restart: true     # Default: yes
```

---

## Extensible Tagging System

Tags are completely user-defined with no schema enforcement. The system provides sensible defaults but allows unlimited custom tags.

### Built-in Tag Defaults

These are provided as starting points but can be customized or disabled:

```yaml
tags:
  built_in:
    - name: "decision"
      description: "Key decisions made during conversation"
      boost: 1.5
    - name: "open_question"
      description: "Unresolved questions or topics needing further exploration"
      boost: 1.2
    - name: "concept"
      description: "Abstract ideas, theories, or concepts discussed"
      boost: 1.3
    - name: "reference"
      description: "External references, links, citations, or sources mentioned"
      boost: 1.4
    - name: "emotion"
      description: "Emotional tone, feelings, or sentiment expressed"
      boost: 1.1
```

### Custom Tags

Users can add any tags they need:

```yaml
tags:
  custom:
    - name: "creative_idea"
      description: "Brainstorming, ideation, creative concepts"
      boost: 1.6
    - name: "research_topic"
      description: "Investigations, deep dives, fact-finding"
      boost: 1.5
    - name: "personal_insight"
      description: "Personal realizations or reflections"
      boost: 1.7
    - name: "plot_point"          # For narrative/creative work
      description: "Story plot points,情节, or narrative elements"
      boost: 1.6
    - name: "theme"                # For creative work
      description: "Thematic elements or motifs"
      boost: 1.5
    - name: "character_note"       # For narrative work
      description: "Character development notes"
      boost: 1.5
```

### Tag Characteristics

- **Free-form strings** - No schema enforcement, anything goes
- **Auto-created on use** - Tags appear automatically when first applied to a turn
- **Case-insensitive matching** - "Decision" == "decision"
- **Tag aliases supported** - Can create alternative names for tags
- **Per-turn tagging** - Any turn (user or assistant) can have multiple tags

### Tagging Examples

| Scenario | Suggested Tags |
|----------|----------------|
| User decides on tech stack | `decision`, `technical` |
| Brainstorming novel plot | `creative_idea`, `plot_point`, `character_note` |
| Researching historical event | `research_topic`, `reference` |
| Emotional discussion | `emotion`, `personal_insight` |
| Learning new concept | `concept`, `open_question` |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     User Input (Prompt)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Recall Engine                            │
│  • Embed incoming message                                    │
│  • Search historical turns by cosine similarity             │
│  • Apply tag-based boost scores                              │
│  • Synthesize top matches into first-person memory block   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Recall Display (UI)                        │
│  • Shows user exactly what was retrieved                    │
│  • Shows why (relevance score, tags)                        │
│  • Editable with two behavior modes                         │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    [No edits made]              [User edited recall block]
              │                               │
              ▼                               ▼
    Model processes        Interrupt/replace or continue & replace
    with recall + window   based on edit severity setting
              │                               │
              ▼                               ▼
    Response generated                         ┌──────────────┐
                                               │  Context     │
                                               │   updated    │
                                               └──────────────┘
                                                              │
                                                              ▼
                                                  Next interaction uses
                                                  updated recall block

```

---

## Context Assembly Order

1. **Recall synthesis block** (editable, can be empty if no matches)
2. **Recent committed turns window** (last N turns from config)
3. **Current user message** (always last in context)

---

## Key Design Decisions

### 1. Recall is Always Active by Default

**Principle:** Recall fires on every single prompt unless explicitly disabled.

**Rationale:** Even seemingly simple questions often connect to prior conversations. The user should never miss a relevant memory just because they didn't explicitly ask for context.

**Implementation:**
- Incoming message gets embedded
- Full database search performed (not just recent turns)
- Results ranked by relevance score + tag boosts
- Top matches synthesized into coherent memory block

### 2. Recall is Shown AND Entered Simultaneously

**Principle:** The model never sees raw search results.

**Rationale:** Users should have direct control over what historical context shapes their answer. The recall synthesis is not ground truth—it's a suggestion that the user can refine.

**Implementation:**
- Recall block appears as first-class UI element above response
- Simultaneously entered into context for immediate processing
- User can edit the recall block before response completes
  - Minor edits: Continue generation, replace recall in context
  - Major edits: Interrupt and restart with edited recall

### 3. Extensible Tagging System

**Principle:** Tags should support any conceptual framework the user wants to apply.

**Implementation:**
- No schema enforcement on tags
- Built-in defaults provided but fully customizable
- Custom tags created automatically on first use
- Tag boosts configurable per tag

### 4. Edit Behavior Modes

**Principle:** Different edits deserve different responses.

**Implementation:**
- **Minor edits** (typo fixes, small wording changes): Continue current response, update recall for next turn
- **Major edits** (structure changes, remove/add concepts): Interrupt and restart with new recall context
- User settings control default behavior

---

## Data Model

### Turn Schema
```typescript
interface Turn {
  id: number;
  user_id?: string | null;
  role: 'user' | 'assistant';
  content: string;         // For user: input text, for assistant: response
  context_turns: number;
  committed: boolean;      // False = discarded/uncommitted
  created_at: string;      // ISO 8601 timestamp
  
  // Metadata
  model_name?: string;
  token_count?: number;
  
  // Tags for recall boosting (free-form, user-defined)
  tags?: string[];         // e.g., ['decision', 'creative_idea']
  
  // Recall-specific fields
  embedding_id?: number;   // Reference to embeddings table
  relevance_score?: number; // Computed during recall
}
```

### Recall Result Schema
```typescript
interface RecallResult {
  turn: Turn;
  similarity_score: number; // Cosine similarity
  tag_boosts_applied: {    // Which tags boosted this result
    [tag_name]: boost_factor;
  };
  final_score: number;
}

interface RecallSynthesis {
  query_embedding: number[];      // Embedding of user's current message
  matched_turns: RecallResult[];
  synthesized_memory: string;     // First-person narrative summary
  sources: {
    turn_id: number;
    relevance_score: number;
    tags: string[];
  }[];
}
```

### Edit Behavior Schema
```typescript
interface EditBehavior {
  edit_type: 'minor' | 'major';
  behavior: 'continue_and_replace' | 'interrupt_and_restart';
}

interface UserSettings {
  recall_edit_behavior: {
    minor_edits_replace: boolean;     // Default: true
    major_edits_restart: boolean;     // Default: true
  };
}
```

---

## API Extensions Needed

### 1. Get Recall Synthesis (POST /api/recall/synthesize)

```json
{
  "message": "Current user prompt",
  "context_limit": 10,
  "tag_boosts": {
    "decision": 1.5,
    "creative_idea": 2.0
  }
}
```

**Response:**
```json
{
  "recall_id": "abc123",
  "query_embedding": [0.1, -0.2, ...],
  "matched_turns": [
    {
      "turn_id": 15,
      "similarity_score": 0.87,
      "tags": ["decision"],
      "text": "We decided to use SQLite for persistence"
    }
  ],
  "synthesized_memory": "Based on our past conversation about database choices, you decided to use SQLite for lightweight persistence needs."
}
```

### 2. Edit Recall Block (POST /api/recall/edit)

**Request:**
```json
{
  "recall_id": "abc123",
  "edited_memory": "Based on our past conversations, you chose SQLite for lightweight persistence needs.",
  "applied_to_current_context": true
}
```

**Response:**
```json
{
  "recall_id": "abc123",
  "edited_memory": "Based on our past conversations, you chose SQLite for lightweight persistence needs.",
  "applied_to_current_context": true,
  "memory_updated_for_future": true
}
```

### 3. Edit Behavior Request (POST /api/recall/decide_behavior)

**Request:**
```json
{
  "recall_id": "abc123",
  "original_memory": "...",
  "edited_memory": "...",
  "edit_type": "major"
}
```

**Response:**
```json
{
  "decision": "interrupt_and_restart",
  "reason": "Major structural change detected in recall synthesis"
}
```

### 4. Get Recall for Turn (GET /api/turns/{id}/recall)

```json
{
  "turn_id": 15,
  "recall_synthesis": "...",
  "applied_to_context_at": "2024-01-01T00:00:00Z",
  "was_edited": false,
  "final_content_used_in_response": "..."
}
```

### 5. Add Tags to Turn (PATCH /api/turns/{id}/tags)

**Request:**
```json
{
  "add_tags": ["creative_idea", "plot_point"],
  "remove_tags": ["decision"]
}
```

**Response:**
```json
{
  "turn_id": 15,
  "tags": ["open_question", "creative_idea", "plot_point"]
}
```

### 6. Configure Recall (POST /api/settings/recall)

**Request:**
```json
{
  "recall_enabled": false,
  "per_conversation_override": true
}
```

---

## Configuration

```yaml
# backend/config.yaml

recall:
  enabled: true                        # Default: true
  per_conversation_enabled_by_default: true
  
  embedding_model: "sentence-transformers/all-MiniLM-L6-v2"
  search_limit: 10                     # Max matches to consider
  
  synthesis_prompt:
    system: "You are a memory synthesizer. Combine related turns into a coherent first-person narrative that feels like something the user would remember about this conversation."
    template: |
      Here are relevant memories from past conversations:
      
      {% for memory in memories %}
      - {{ memory.text }} (relevance: {{ memory.score }}, tags: {{ memory.tags | join(", ") }})
      {% endfor %}
      
      Synthesize these into a concise first-person memory block. Keep it natural and conversational.
  
  edit_behavior:
    minor_edits_replace: true          # Default: yes
    major_edits_restart: true          # Default: yes
  
  tag_boosts:
    decision: 1.5
    open_question: 1.2
    concept: 1.3
    reference: 1.4
    emotion: 1.1
    # Custom tags added here by user

context:
  window_size: 5                       # Recent turns to include
  order: ["recall", "window", "current"]  # Context assembly order
```

---

## User Experience Flow

### Example: User asks "What database should we use?"

1. **User types prompt** → `"What database should we use?"`

2. **Backend computes recall (enabled by default):**
   - Embeds query
   - Searches database for similar turns
   - Finds turn #42: `"We decided SQLite for lightweight use"` (tagged: `decision`)
   - Finds turn #58: `"PostgreSQL has better JSON support"` (tagged: `open_question`)

3. **Synthesis LLM call:**
   - System prompt + recall results → synthesized memory
   - Output: `"Based on our past conversations, you've decided SQLite for lightweight use cases, and there's an open question about PostgreSQL having better JSON support."`

4. **Recall block displayed AND entered into context simultaneously:**
   ```
   ┌───────────────────────────────────────────────┐
   │ Recall (2 matches)                            │
   ├───────────────────────────────────────────────┤
   │ Based on our past conversations:              │
   │ • SQLite decided for lightweight use          │
   │ • Open question: PostgreSQL JSON support      │
   │                                               │
   │ [Edit recall]                                 │
   └───────────────────────────────────────────────┘
   
   [Model processing with above in context...]
   ```

5. **LLM generates response based on assembled context**

6. **User decides to edit recall:**
   - Edits text to: `"We decided SQLite for lightweight use cases."`
   - Clicks "Apply edit"

7. **Edit behavior decision:**
   - System analyzes edit severity
   - Decides: `minor_edits_replace` → continue current response

8. **Context updated with edited recall**
   - Original response continues
   - Next turn will use this revised recall block

---

## Known Limitation: Web-Fetch Privacy

`web_search` is privacy-respecting (the SearXNG instance routes outbound through
WireGuard), but **`fetch_url` goes direct from the collaborator box** — every page
the model fetches (including any link it follows) sees this machine's real IP. This
is a known, accepted limitation for now.

Planned fix: route fetches through Tor or a VPN via `tools.fetch_url.proxy` —
either through the search box (its Tor SOCKS proxy is provisioned but dormant at
`127.0.0.1:9050`; would need exposing to the tailnet) or by putting Tor on the
webserver itself. The proxy hook is already implemented; this is an ops task, not a
code task. (SOCKS proxies need `pip install requests[socks]`.)

Related injection containment for link-following: per-turn fetch budget
(`tools.fetch_url.max_per_turn`), SSRF guard on every hop, optional
`same_domain_only`, tiny write surface (only `propose_note` → pending draft), and
every fetched URL is shown live to the user as a status event.

## Future Considerations (User-Defined)

- [ ] Priority levels for recall
- [ ] Confidence thresholds
- [ ] Recall history auditing
- [ ] Context preview before generation

---

## Development Principles

1. **Test with Real LLMs** - Mock tests verify logic, but always test with actual model before pushing
2. **Config-First** - No hardcoded values; everything comes from `config.yaml` or environment
3. **Linear Schema for MVP** - Branching can be added later; keep schema simple for Phase 1
4. **Visibility Over Efficiency** - It's better to be transparent and slightly slower than fast but opaque
5. **Editability Over Automation** - Let users control the details; they know best

---

## Frontend Update Notes

### June 27, 2026 - System Prompt Added
**Commit:** `3bfc183`

Added standalone `system-prompt.md` file containing Collaborator's philosophical guide:

- **Thinking partner** approach (not task completer, search engine, therapist)
- **Depth over speed** philosophy
- **Honest about uncertainty** with "I don't know" default
- **Respectful disagreement** as thinking together

The prompt is loaded via `config.yaml` (`system_prompt.file_path: "system-prompt.md"`) and integrated into all conversation context.

---

## References

- API Spec: `API-SPEC.md`
- Backend: `/backend/`
- Database Schema: See `backend/db.py` and docs
- Testing: Run `python backend/test_basic_loop.py`

---
