/**
 * Canonical internal domain model.
 *
 * Per our scoping decision, this mirrors the AS-BUILT API (API-SPEC.md) rather
 * than the aspirational INTENTS.md model — but it is deliberately shaped so the
 * INTENTS direction is not blocked:
 *   - `tags` is normalized to string[] (the API currently sends string | null),
 *     matching where tagging is headed.
 *   - Recall-related fields (relevanceScore, embeddingId) are reserved as
 *     optional so recall results can populate the same Turn type later.
 */

export type Role = 'user' | 'assistant';

export interface Turn {
  id: number;
  userId: string | null;
  role: Role;
  /** User input text (user turns). Empty for assistant turns. */
  message: string;
  /** Model output (assistant turns). Empty for user turns. */
  response: string;
  committed: boolean;
  contextTurns: number;
  createdAt: string;
  modelName: string | null;
  tokenCount: number | null;
  /** Normalized to an array even though the API sends a single string today. */
  tags: string[];

  // --- Reserved for INTENTS.md recall features (not yet served) ---
  relevanceScore?: number;
  embeddingId?: number;
}

export interface HealthStatus {
  status: string;
  version: string;
}

export interface TurnsPage {
  turns: Turn[];
  count: number;
  /**
   * Context window size: how many recent committed turns the backend feeds the
   * model. The next message's context = the most recent `contextWindow` turns.
   * Null when the backend doesn't report it.
   */
  contextWindow: number | null;
}

export interface SendMessageInput {
  message: string;
  contextTurns?: number;
  commit?: boolean;
  userId?: string;
}

export interface SendMessageResult {
  id: number;
  userId: string | null;
  message: string;
  response: string;
  committed: boolean;
  /** Turns the backend actually used as context for this response, if reported. */
  contextTurnsUsed?: Turn[];
  /** System prompt used for this response, if reported. */
  systemPrompt?: string;
  /** AGENTS.md content, if exposed by the backend. */
  agentsMd?: string;
}
