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

  // --- Branching ---
  /** Fork point (the turn this one branched from); null = root. */
  parentTurnId: number | null;
  /** Which paragraph of the parent this branched from, if any. */
  paragraphIndex: number | null;
  /** Assistant turns: response split on blank lines (branch affordances). */
  paragraphs: string[];

  // --- Reserved for INTENTS.md recall features (not yet served) ---
  relevanceScore?: number;
  embeddingId?: number;
}

/**
 * Conversation stage: `seed` = a provisional new chat (lives in the Chats
 * staging list), `tree` = promoted to a full conversation (list + map). The
 * whole conversation shares one state (inherited from the root).
 */
export type ConversationState = 'seed' | 'tree';

/** A node in the conversation tree (GET /api/tree). */
export interface TreeNode {
  id: number;
  role: Role;
  /** Display text (user input or assistant response). */
  content: string;
  preview: string;
  paragraphs: string[];
  parentTurnId: number | null;
  paragraphIndex: number | null;
  /** True when generated with context_turns:0 — a fresh-context boundary. */
  contextBoundary: boolean;
  /** True when this turn was created as an explicit fork (POST /api/branches). */
  branched: boolean;
  /** User-set name (used to name a conversation/branch by its root turn). */
  name: string | null;
  /** Conversation stage (see ConversationState). Meaningful on roots. */
  state: ConversationState;
  /** Recall block that this turn triggered (user turns only), or null. */
  recall: RecallBlock | null;
  children: TreeNode[];
}

export interface ConversationTree {
  roots: TreeNode[];
  count: number;
  /** Context window size (recent turns in context), if the backend provides it. */
  contextWindow: number | null;
}

export interface BranchInput {
  parentTurnId: number;
  message: string;
  /** 0-based paragraph of the parent to branch from (omit to branch the turn). */
  paragraphIndex?: number;
  contextTurns?: number;
  commit?: boolean;
  mode?: 'voice' | 'text';
  /** Opt-in: search memory and inject a synthesized recall block into context. */
  recall?: boolean;
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

/** A turn that recall matched (shown as a source under the recall block). */
export interface RecallSource {
  turnId: number;
  role: string;
  tags: string[];
  branchRootId: number | null;
  similarity: number;
  score: number;
  preview: string;
}

/** Synthesized memory block injected into context (recall SSE event). */
export interface RecallBlock {
  content: string;
  sources: RecallSource[];
}

export interface SendMessageInput {
  message: string;
  /** Opt-in: search memory and inject a synthesized recall block into context. */
  recall?: boolean;
  /**
   * The active leaf turn id to continue from (its ancestor chain = context).
   * Omit ONLY for a brand-new conversation; omitting on an existing convo starts
   * a new disconnected root.
   */
  parentTurnId?: number;
  contextTurns?: number;
  commit?: boolean;
  userId?: string;
  /** "voice" for call mode so the backend can adjust the system prompt. */
  mode?: 'voice' | 'text';
}

