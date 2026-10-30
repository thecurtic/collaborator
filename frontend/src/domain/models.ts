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

import type { AgentQuestion } from '@/api/agents';

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
  /** True when this turn was created as an explicit fork (POST /api/branches). */
  branched: boolean;
  /** The chat's user-set name (roots only). */
  name: string | null;
  /** Generated label of the branch this turn starts; null until summarized. */
  label: string | null;
  /** LLM-generated title (roots, all states). `name` always wins. */
  title: string | null;
  /** Chat-level tags (roots only): organize the chat; never feed recall. */
  chatTags: string[];
  /** Conversation stage (see ConversationState). Meaningful on roots. */
  state: ConversationState;
  /** Recall block that this turn triggered (user turns only), or null. */
  recall: RecallBlock | null;
  /** Persisted tool activity for this turn (assistant turns; may be empty). */
  tools: ToolActivity[];
  /** Files this (user) turn carried — a snapshot taken when it was sent. */
  attachments: TurnAttachment[];
  children: TreeNode[];
}

export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'document'
  | 'text'
  | 'audio'
  | 'video'
  | 'file';

/** What a turn records about each file it carried. */
export interface TurnAttachment {
  id: number;
  filename: string;
  mime: string | null;
  kind: AttachmentKind;
  size: number;
}

/** An uploaded file (POST /api/attachments) and the state of its text. */
export interface Attachment extends TurnAttachment {
  createdAt: string;
  /** idle: audio/video sent without asking for a transcript. */
  textStatus: 'pending' | 'working' | 'done' | 'failed' | 'none' | 'idle';
  textError: string | null;
  textVia: string | null;
  pages: number | null;
  chars: number;
  /** The user turn that first carried it; null = not sent yet. */
  firstTurnId: number | null;
  /** Audio/video: its transcript on the Transcripts page, once asked for. */
  transcriptId: number | null;
  /** Only on GET /api/attachments/{id}. */
  text?: string | null;
}

/** Display label for a conversation root: user name → LLM title → preview. */
export function rootLabel(node: TreeNode): string {
  return node.name ?? node.title ?? node.preview ?? 'Untitled';
}

/** The three-dots card about one chat: its tags and on-demand summary. */
export interface ChatCard {
  rootId: number;
  tags: string[];
  summary: {
    text: string;
    /** Tags the summary suggested — offered, never applied. */
    proposedTags: string[];
    generatedAt: string | null;
    /** The chat has grown since the summary was generated. */
    stale: boolean;
  } | null;
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
  /** Uploaded attachments this message carries. */
  attachmentIds?: number[];
  /** Transcribe the audio/video among them (the hold-send gesture). */
  transcribe?: boolean;
  /**
   * Client-chosen id for the streamed reply, so it can be stopped with the
   * reply so far kept (api.stopStream).
   */
  streamId?: string;
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

/** A logged-in device (b60da69) — the lost-phone story: revoke from anywhere. */
export interface DeviceSession {
  id: number;
  label: string;
  createdAt: string;
  lastSeen: string;
  expiresAt: string;
  current: boolean;
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

/**
 * A scratch (notes-to-self) item (7444138): inert capture by default — the
 * model touches an item only via the explicit hold-send action.
 */
export interface ScratchItem {
  id: number;
  createdAt: string;
  kind: 'text' | 'url' | 'image' | 'audio' | 'video' | 'file';
  content: string;
  mediaMime: string | null;
  mediaHash: string | null;
  transcript: string | null;
  status: 'inert' | 'pending' | 'committed' | 'done' | 'refused';
  /** Whether the LLM has ever seen this item (actions set it; toggleable). */
  llmReadable: boolean;
  actionResult: {
    kind: string;
    note: string | null;
    draftTitle: string | null;
  } | null;
  draftId: number | null;
  transcriptId: number | null;
  /** Pinned above the stream. */
  pinned: boolean;
  /** The linked transcription job, for an event's live state. */
  transcriptJob: { status: string; title: string | null; channel: string | null } | null;
  /** The file's own name and size (media items). */
  mediaName: string | null;
  mediaSize: number | null;
  /** A link's preview: page title + site (or video title + channel). */
  preview: {
    status: 'pending' | 'done' | 'failed';
    title: string | null;
    site: string | null;
    icon: boolean;
    image: boolean;
  } | null;
}

/** Scratch's derived filters (by what each item already is). */
export type ScratchFilter = 'links' | 'photos' | 'documents' | 'text' | 'voice';

/** A video-transcription job (b23d8ea): STT over the audio, never captions. */
/** GET /api/transcripts: the jobs plus the tag vocabulary in use. */
export interface TranscriptList {
  items: Transcript[];
  vocabulary: string[];
  /** Sources in use with their counts (filter chips). */
  sources: { source: string; count: number }[];
}

export interface Transcript {
  id: number;
  /** '' for a file of the user's own (no URL). */
  url: string;
  /** Where the audio came from: link (a video URL), attachment (a file sent
   *  in a chat), scratch (a Scratch capture); future sources pass through. */
  source: string;
  title: string | null;
  /** The video's channel/uploader (null for pre-2026-10-12 transcripts). */
  channel: string | null;
  durationS: number | null;
  status: 'processing' | 'done' | 'error';
  /** Why it failed (status 'error' only). */
  error: string | null;
  chars: number | null;
  /** Text around the first search hit (filtered listings only). */
  snippet: string | null;
  /** Optional tags; `project` plus a name puts it in that project. */
  tags: string[];
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
  /** Structured per-category fields; null when the draft has none set. */
  fields: NoteFields | null;
}

/**
 * Per-type frontmatter as one flat superset — the note's single type tag
 * (event, social-graph, user-profile) decides which keys mean anything.
 * null/[] = unset.
 */
export interface NoteFields {
  // event
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  /** Social-graph note titles — real graph edges. */
  people: string[];
  /** Recurrence rule (null = one-off). Occurrences are derived server-side. */
  repeat: RepeatRule | null;
  /** Per-occurrence overrides, kept forever. */
  exceptions: OccurrenceException[];
  // social-graph
  aliases: string[];
  kind: string | null;
  relation: string | null;
  birthday: string | null;
  // user-profile satellites
  area: string | null;
  // USER.md hub note only
  name: string | null;
  dob: string | null;
  residesIn: string | null;
  timezone: string | null;
}

/**
 * PATCH shape for fields (notes and drafts): omitted keys keep their value,
 * '' or [] clears one. Server-validated (422 with a readable reason).
 */
export type NoteFieldsPatch = Record<
  string,
  string | string[] | boolean | object
>;

/** Vault note metadata (list/search rows). */
/** GET /api/notes/search: hybrid (default) fuses keyword and semantic. */
export type NoteSearchMode = 'hybrid' | 'semantic' | 'keyword';

export interface NoteMeta {
  filename: string;
  title: string;
  created: string | null;
  /** Last changed in the app (list only); null = never, use `created`. */
  edited: string | null;
  tags: string[];
  sourceTurns: number[];
  /** Outgoing [[wikilink]] targets parsed from the body. */
  links: string[];
  /** Search relevance, when this row came from /api/notes/search. */
  score: number | null;
  /** Typed frontmatter (1f18a9b); null when the note has none set. */
  fields: NoteFields | null;
  /** Calendar windows: the original date of this occurrence (recurring). */
  occurrence: string | null;
  recurring: boolean;
  /** An exception gave this occurrence a different time. */
  moved: boolean;
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
  /**
   * Engine health (41f2a61): who answered (name → result count) and who
   * failed with why — a search silently reduced to one engine is a degraded
   * worldview the UI must surface.
   */
  enginesResponded: Record<string, number>;
  enginesFailed: { engine: string; reason: string | null }[];
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
  /** Uploaded attachments this message carries. */
  attachmentIds?: number[];
  /** Transcribe the audio/video among them (the hold-send gesture). */
  transcribe?: boolean;
  /**
   * Client-chosen id for the streamed reply, so it can be stopped with the
   * reply so far kept (api.stopStream).
   */
  streamId?: string;
}


/** One notification kind in the settings list (every kind is optional). */
export interface NotificationKind {
  kind: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface NotificationSettings {
  kinds: NotificationKind[];
  /** Phone delivery (self-hosted ntfy) is configured on the server. */
  ntfyConfigured: boolean;
}

/** What a warm-feed item is (UX doc, Feed). */
export type FeedItemType =
  | 'chat'
  | 'note'
  | 'event'
  | 'approval'
  | 'transcript'
  | 'merged'
  /** An open question from an agent channel (heavy: it blocks on me). */
  | 'agent_question'
  /** A message an agent backend flagged as needing me, not yet seen. */
  | 'agent_message';

export interface FeedItem {
  /** Stable id, e.g. chat:12 — used for touch and pin. */
  key: string;
  type: FeedItemType;
  title: string;
  subtitle: string | null;
  /** Later of touched and changed (ISO UTC); null = not yet warm. */
  warmth: string | null;
  tags: string[];
  pinned: boolean;
  /** Where tapping goes: rootId/leafId, title, draftId/runId, transcriptId. */
  ref: {
    rootId?: number;
    leafId?: number;
    title?: string;
    start?: string;
    draftId?: number;
    runId?: string | null;
    transcriptId?: number;
    project?: string | null;
    /** Agent items: the stored message, its channel, and its question. */
    messageId?: number;
    endpointId?: string;
    channel?: string;
    question?: AgentQuestion | null;
    /** A question's message text (a test build's link arrives here). */
    text?: string;
  };
}

export interface Feed {
  pinned: FeedItem[];
  items: FeedItem[];
}

export type RepeatFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RepeatRule {
  freq: RepeatFreq;
  interval?: number;
  /** MO TU WE TH FR SA SU (weekly rules). */
  byDay?: string[];
  byMonthDay?: number;
  until?: string;
  count?: number;
}

export interface OccurrenceException {
  date: string;
  cancelled?: boolean;
  start?: string;
  end?: string;
  note?: string;
}
