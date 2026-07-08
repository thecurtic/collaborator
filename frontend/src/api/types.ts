/**
 * Wire-level types — these mirror api-spec/API-SPEC.md EXACTLY (snake_case,
 * as-built). Do not hand these shapes to UI components; map them to the domain
 * model in src/domain first. Keeping the wire layer isolated means the recall
 * /tagging extensions described in api-spec/INTENTS.md can be added here without
 * rippling through the UI.
 */

export type ApiRole = 'user' | 'assistant';

/** GET /api/health */
export interface ApiHealth {
  status: string;
  version: string;
}

/**
 * A turn as returned by GET /api/messages.
 *
 * IMPORTANT: API-SPEC.md documents `message`/`response`, but the AS-BUILT
 * backend (db.py + main.py get_messages) actually returns a single `content`
 * column per turn. We accept both shapes so the adapter is robust to either,
 * and `committed` may arrive as 0/1 (SQLite) rather than a real boolean.
 */
export interface ApiTurn {
  id: number;
  user_id: string | null;
  role: ApiRole;
  content?: string; // as-built field (one column, role decides meaning)
  message?: string; // per API-SPEC (not actually sent on GET)
  response?: string; // per API-SPEC (not actually sent on GET)
  committed: boolean | number;
  context_turns: number;
  created_at: string; // ISO 8601
  model_name: string | null;
  token_count: number | null;
  tags: string | null;
  // Branching (77ebdc7)
  parent_turn_id?: number | null;
  paragraph_index?: number | null;
  paragraphs?: string[]; // assistant turns: content split on blank lines
}

/** A node in GET /api/tree (nested). */
export interface ApiRecallSource {
  turn_id: number;
  role?: string;
  tags?: string[];
  branch_root_id?: number | null;
  similarity?: number;
  score?: number;
  preview?: string;
}

export interface ApiRecall {
  content: string;
  sources?: ApiRecallSource[];
}

export interface ApiTreeNode {
  id: number;
  role: ApiRole;
  content: string;
  preview: string;
  paragraphs?: string[];
  /** Present only on user turns that triggered recall. */
  recall?: ApiRecall;
  parent_turn_id: number | null;
  paragraph_index: number | null;
  created_at?: string;
  committed?: boolean | number;
  /** This turn's stored context window. */
  context_turns?: number;
  /** True when generated with context_turns:0 (a fresh-context boundary). */
  context_boundary?: boolean;
  /** True when this turn was created via POST /api/branches (an explicit fork). */
  branched?: boolean;
  /** User-set name (conversation/branch naming); null/absent = unnamed. */
  name?: string | null;
  /** Conversation stage: "seed" (provisional chat) or "tree" (promoted). */
  state?: string;
  children: ApiTreeNode[];
}

/** GET /api/tree */
export interface ApiTree {
  roots: ApiTreeNode[];
  count: number;
  /** Context window size (recent turns fed to the next message), if provided. */
  context_turns?: number;
}

/** GET /api/messages?limit&offset */
export interface ApiTurnsResponse {
  turns: ApiTurn[];
  count: number;
  /** Context window size (number of recent committed turns fed to the model). */
  context_turns_used?: number;
}

/** POST /api/messages 201 response (non-streaming fallback). */
export interface ApiSendMessageResponse {
  id: number;
  user_id: string | null;
  message: string;
  response: string;
  committed: boolean;
  /** The actual turn objects used as context for this response. */
  context_turns_used?: ApiTurn[];
  /** Full system prompt text used for this response. */
  system_prompt?: string;
  /** AGENTS.md content, if the backend exposes it (may be absent/empty). */
  agents_md_content?: string;
}

/** POST /api/auth/ws-ticket — short-lived single-use WS auth ticket. */
export interface ApiWsTicket {
  ticket: string;
  expires_in: number;
}

// ---- Notes pipeline (drafts inbox + vault index) ----

/** A semantic near-duplicate flag on a draft (vs. an existing vault note). */
export interface ApiDuplicateRef {
  title: string;
  score: number;
}

/** A note draft (pending until the user approves/rejects). */
export interface ApiNoteDraft {
  id: number;
  run_id: string;
  tree_root_id: number | null;
  title: string;
  body: string;
  tags?: string[];
  links?: string[];
  source_turns?: number[];
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  decided_at: string | null;
  duplicate_of?: ApiDuplicateRef[];
}

/** GET /api/notes/drafts */
export interface ApiDraftsResponse {
  drafts: ApiNoteDraft[];
  count: number;
}

/** POST /api/notes/drafts/{id}/approve */
export interface ApiApproveResponse {
  draft: ApiNoteDraft;
  path: string;
  filename: string;
}

/** POST /api/notes/synthesize/{tree_id} */
export interface ApiSynthesisResponse {
  run_id: string;
  drafts: ApiNoteDraft[];
  count: number;
}

/** Vault note metadata (list/search entries; search adds `score`). */
export interface ApiNoteMeta {
  filename: string;
  title: string;
  created?: string;
  tags?: string[];
  source_turns?: number[];
  links?: string[];
  score?: number;
}

/** GET /api/notes */
export interface ApiNotesResponse {
  notes: ApiNoteMeta[];
  count: number;
}

/** GET /api/notes/search */
export interface ApiNoteSearchResponse {
  results: ApiNoteMeta[];
  count: number;
  mode: string;
}

/** GET /api/notes/{title} — full note (backlinks = titles or note objects). */
export interface ApiNoteResponse {
  note: ApiNoteMeta & {
    body: string;
    backlinks?: (string | { title: string })[];
  };
}

/** POST /api/notes/reindex */
export interface ApiReindexResponse {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

/** GET /api/prompts entry — a prompt building block as the runtime resolves it. */
export interface ApiPromptEntry {
  name: string;
  description?: string;
  applies?: string;
  /** Provenance: file | config | default. */
  source?: string;
  file?: string | null;
  content?: string;
  note?: string | null;
}

/** GET /api/prompts (read-only by design — editability is shelved). */
export interface ApiPromptsResponse {
  prompts: ApiPromptEntry[];
  count: number;
}

/** Standard error envelope ({ "error": "..." }). */
export interface ApiError {
  error: string;
}
