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

/** A turn as returned by GET /api/messages. */
export interface ApiTurn {
  id: number;
  user_id: string | null;
  role: ApiRole;
  message: string; // user input text; empty for assistant turns
  response: string; // model output; empty for user turns
  committed: boolean;
  context_turns: number;
  created_at: string; // ISO 8601
  model_name: string | null;
  token_count: number | null;
  tags: string | null; // NOTE: API-SPEC types this as a single nullable string
}

/** GET /api/messages?limit&offset */
export interface ApiTurnsResponse {
  turns: ApiTurn[];
  count: number;
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
}

/** DELETE /api/messages/{turn_id} 200 response. */
export interface ApiDiscardResponse {
  id: number;
  committed: boolean;
}

/** Standard error envelope ({ "error": "..." }). */
export interface ApiError {
  error: string;
}
