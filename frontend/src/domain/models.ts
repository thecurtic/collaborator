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
  /** LLM-generated title (roots, all states). `name` always wins. */
  title: string | null;
  /** Conversation stage (see ConversationState). Meaningful on roots. */
  state: ConversationState;
  /** Recall block that this turn triggered (user turns only), or null. */
  recall: RecallBlock | null;
  /** Persisted tool activity for this turn (assistant turns; may be empty). */
  tools: ToolActivity[];
  children: TreeNode[];
}

/** Display label for a conversation root: user name → LLM title → preview. */
export function rootLabel(node: TreeNode): string {
  return node.name ?? node.title ?? node.preview ?? 'Untitled';
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
  /**
   * Offer the model its tools this turn (web/notes/recall — the whole agent
   * loop, 9aee10b). Omit to use the server default; explicit false disables.
   */
  tools?: boolean;
  /** Where the user is, when they've opted in (b23d8ea); omit otherwise. */
  location?: TurnLocation;
}

/**
 * Optional server voice features (9acc3d1). All false on backends that don't
 * advertise them — server engine options should be hidden then.
 */
export interface ServerCapabilities {
  /** WS /api/transcribe/stream serves the session protocol. */
  sttStream: boolean;
  /** POST /api/tts will synthesize (piper installed + a voice on disk). */
  ttsStream: boolean;
  /** In-stream phrase detection (always equals sttStream today). */
  phrases: boolean;
}

export interface HealthStatus {
  status: string;
  version: string;
  capabilities: ServerCapabilities;
}

/** One chat model as LM Studio reports it (f7e235b); nulls = unreported. */
export interface ModelInfo {
  id: string;
  type: string | null;
  loaded: boolean;
  quantization: string | null;
  maxContextLength: number | null;
  loadedContextLength: number | null;
}

export interface ModelsInfo {
  current: string;
  available: string[];
  /** Empty on non-LM-Studio endpoints — make no load claims then. */
  models: ModelInfo[];
  loaded: string[];
  /** null = unknown (endpoint doesn't report load state). */
  currentLoaded: boolean | null;
}

/**
 * Optional per-turn location (b23d8ea). The backend resolves it to named
 * places server-side; coordinates never leave the server, and by default the
 * turn is informed but nothing is stored.
 */
export interface TurnLocation {
  lat: number;
  lon: number;
  /** Meters. */
  accuracy?: number;
  /** Unix seconds. */
  ts?: number;
}

/** A video-transcription job (b23d8ea): STT over the audio, never captions. */
export interface Transcript {
  id: number;
  url: string;
  title: string | null;
  durationS: number | null;
  status: 'processing' | 'done' | 'error';
  chars: number | null;
  createdAt: string;
  finishedAt: string | null;
  /** Full text — present only when fetched by id. */
  text: string | null;
}

/** GET /api/tts/voices — server TTS voice roster for the picker. */
export interface TtsVoices {
  voices: string[];
  defaultVoice: string | null;
  enabled: boolean;
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

// ---- Notes pipeline ----

/** A semantic near-duplicate flag on a draft (vs. an existing vault note). */
export interface DuplicateRef {
  title: string;
  score: number;
}

export type DraftStatus = 'pending' | 'approved' | 'rejected';

/**
 * An LLM-synthesized (or hand-written) note awaiting the user's decision.
 * The vault only ever contains APPROVED notes — this is the curation gate.
 */
export interface NoteDraft {
  id: number;
  /** Groups one synthesis pass / one chat turn's proposals. */
  runId: string;
  treeRootId: number | null;
  /** 'new' = a proposed note; 'edit' = a proposed change to an existing one. */
  kind: 'new' | 'edit';
  /** Edit drafts: the existing note being changed. */
  targetTitle: string | null;
  /** Edit drafts: the model's one-line rationale (review context). */
  reason: string | null;
  title: string;
  body: string;
  tags: string[];
  links: string[];
  /** Turn ids this note was distilled from (for source links). */
  sourceTurns: number[];
  status: DraftStatus;
  createdAt: string;
  decidedAt: string | null;
  /** Near-duplicate vault notes — flagged, never dropped. */
  duplicateOf: DuplicateRef[];
  /** Structured event times (event drafts, 85c508c); null otherwise. */
  fields: EventDraftFields | null;
}

/**
 * Event-draft fields: wall-clock ISO strings (no offset — the backend stamps
 * the offset at approval). `start` date-only when allDay.
 */
export interface EventDraftFields {
  start: string | null;
  end: string | null;
  allDay: boolean;
}

/** Vault note metadata (list/search rows). */
export interface NoteMeta {
  filename: string;
  title: string;
  created: string | null;
  tags: string[];
  sourceTurns: number[];
  /** Outgoing [[wikilink]] targets parsed from the body. */
  links: string[];
  /** Search relevance, when this row came from /api/notes/search. */
  score: number | null;
}

/** A full vault note (body + incoming links). */
export interface Note extends NoteMeta {
  body: string;
  /** Titles of notes whose bodies link here. */
  backlinks: string[];
}

/** Result of one synthesis pass over a tree/branch. */
export interface SynthesisResult {
  runId: string;
  drafts: NoteDraft[];
  count: number;
}

/** A draft the chat model proposed mid-conversation (drafts_proposed SSE). */
export interface ProposedDraft {
  id: number;
  title: string;
  runId: string;
  kind: 'new' | 'edit';
  targetTitle: string | null;
}

/**
 * One tool call — in the live activity feed or persisted on a turn.
 * 'pending' = live call awaiting its outcome; 'none' = the tool doesn't
 * report outcomes (recall/notes reads) — render as a plain row.
 */
export interface ToolActivity {
  id: number;
  tool: string;
  /** What it's doing: full query/url/title when available, else the label. */
  text: string;
  outcome: 'pending' | 'ok' | 'empty' | 'error' | 'none';
  /** Resolution detail: "5 results" / failure reason / outcome label. */
  detail: string | null;
  /** web_search result URLs (page-level sources), when reported. */
  urls?: string[];
}

export interface ReindexResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

/** A raw web-search hit (manual search screen; private SearXNG). */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export interface WebSearch {
  query: string;
  results: WebSearchResult[];
  /** SearXNG direct answers (sometimes present). */
  answers: string[];
  infoboxes: { title: string; content: string }[];
}

/**
 * A prompt building block as the backend runtime resolves it (References
 * viewer). READ-ONLY by design — the backend shelved editability, so the UI
 * must not grow edit affordances yet.
 */
export interface PromptInfo {
  name: string;
  description: string;
  /** Which turns this applies to (subtitle). */
  applies: string;
  /** Provenance of the text the model actually receives. */
  source: 'file' | 'config' | 'default';
  /** Backing filename when source === 'file'. */
  file: string | null;
  /** The exact (markdown) text the model receives. */
  content: string;
  /** Caveat worth surfacing (e.g. "cached until restart"). */
  note: string | null;
}

export interface SendMessageInput {
  message: string;
  /**
   * Offer the model its tools this turn (web/notes/recall — the whole agent
   * loop, 9aee10b). Omit to use the server default; explicit false disables.
   */
  tools?: boolean;
  /** Where the user is, when they've opted in (b23d8ea); omit otherwise. */
  location?: TurnLocation;
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
  /** New-root only: conversation stage (used when a root is re-created). */
  state?: ConversationState;
}

