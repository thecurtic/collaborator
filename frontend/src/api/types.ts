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
}

/** GET /api/messages?limit&offset */
export interface ApiTurnsResponse {
  turns: ApiTurn[];
  count: number;
  /** Context window size (number of recent committed turns fed to the model). */
  context_turns_used?: number;
}

/** POST /api/messages request body. */
export interface ApiSendMessageRequest {
  message: string;
  context_turns?: number;
  commit?: boolean;
  user_id?: string;
}

/** POST /api/messages 201 response. */
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

/** DELETE /api/messages/{turn_id} 200 response. */
export interface ApiDiscardResponse {
  id: number;
  committed: boolean;
}

/** POST /api/transcribe response. */
export interface ApiTranscription {
  text: string;
}

/** Standard error envelope ({ "error": "..." }). */
export interface ApiError {
  error: string;
}
