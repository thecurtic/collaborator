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
  /** Server voice tier feature flags (9acc3d1); absent on older backends. */
  capabilities?: {
    stt_stream?: boolean;
    tts_stream?: boolean;
    phrases?: boolean;
  };
}

/** POST /api/auth/login (b60da69) — also sets the httpOnly session cookie. */
export interface ApiLoginResponse {
  token: string;
  session_id: number;
  label: string;
  expires_at: string;
}

/** One device session (GET /api/auth/sessions). */
export interface ApiSession {
  id: number;
  label: string;
  created_at: string;
  last_seen: string;
  expires_at: string;
  current: boolean;
}

export interface ApiSessionsResponse {
  sessions: ApiSession[];
}

/** One scratch (notes-to-self) item (7444138). */
export interface ApiScratchItem {
  id: number;
  created_at: string;
  kind: string;
  content?: string | null;
  media_path?: string | null;
  media_mime?: string | null;
  media_size?: number | null;
  media_hash?: string | null;
  transcript?: string | null;
  status?: string;
  llm_readable?: boolean;
  action_result?: {
    kind?: string;
    note?: string | null;
    draft_title?: string | null;
  } | null;
  draft_id?: number | null;
  transcript_id?: number | null;
  pinned?: boolean;
  transcript_status?: string | null;
  transcript_title?: string | null;
  transcript_channel?: string | null;
}

/** GET /api/scratch */
export interface ApiScratchList {
  items: ApiScratchItem[];
  /** First page only: every pinned item matching the same filters. */
  pinned?: ApiScratchItem[];
}

/** GET /api/tts/voices */
export interface ApiTtsVoices {
  voices: string[];
  default: string;
  enabled: boolean;
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
  /** LLM-generated title (roots, all states). User-set `name` wins. */
  title?: string | null;
  /** Chat-level tags (roots only); distinct from per-turn recall tags. */
  chat_tags?: string[];
  /** Conversation stage: "seed" (provisional chat) or "tree" (promoted). */
  state?: string;
  /** Persisted tool activity for this (assistant) turn, when tools ran. */
  tools?: ApiTurnTool[];
  /** Files a user turn carried (snapshot at send time). */
  attachments?: ApiTurnAttachment[];
  children: ApiTreeNode[];
}

export interface ApiTurnAttachment {
  id: number;
  filename: string;
  mime: string | null;
  kind: string;
  size: number;
}

export interface ApiAttachment extends ApiTurnAttachment {
  created_at: string;
  text_status: string;
  text_error: string | null;
  text_via: string | null;
  pages: number | null;
  chars: number;
  first_turn_id: number | null;
  text?: string | null;
  snippet?: string;
}

/** One persisted tool call on a tree node (mirrors the status/outcome events). */
export interface ApiTurnTool {
  tool: string;
  query?: string;
  url?: string;
  title?: string;
  outcome?: string;
  count?: number;
  error?: string;
  /** web_search result URLs (page-level sources). */
  urls?: string[];
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
  /** "new" (default) = a proposed note; "edit" = a proposed change. */
  kind?: string;
  /** Edit drafts: the existing note being changed. */
  target_title?: string | null;
  /** Edit drafts: the model's one-line rationale. */
  reason?: string | null;
  title: string;
  body: string;
  tags?: string[];
  links?: string[];
  source_turns?: number[];
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  decided_at: string | null;
  duplicate_of?: ApiDuplicateRef[];
  /**
   * Structured per-category fields (85c508c events; 1f18a9b all categories):
   * validated by the backend and serialized into frontmatter at approval.
   */
  fields?: ApiNoteFields | null;
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
  /** Edit drafts: the approval renamed the target note. */
  renamed?: boolean;
  /** Edit drafts: notes whose inbound wikilinks were rewritten. */
  links_rewritten?: string[];
}

/** POST /api/notes/synthesize/{tree_id} */
export interface ApiSynthesisResponse {
  run_id: string;
  drafts: ApiNoteDraft[];
  count: number;
}

/** Vault note metadata (list/search entries; search adds `score`). */
/**
 * Per-type frontmatter. One flat superset — the note's single type tag
 * (event, social-graph, user-profile) decides which keys are meaningful.
 */
export interface ApiNoteFields {
  start?: string | null;
  end?: string | null;
  all_day?: boolean;
  location?: string | null;
  people?: string[];
  repeat?: ApiRepeatRule | null;
  exceptions?: ApiOccurrenceException[];
  aliases?: string[];
  kind?: string | null;
  relation?: string | null;
  birthday?: string | null;
  area?: string | null;
  // USER.md hub note only:
  name?: string | null;
  dob?: string | null;
  resides_in?: string | null;
  timezone?: string | null;
}

export interface ApiNoteMeta {
  filename: string;
  title: string;
  created?: string;
  tags?: string[];
  source_turns?: number[];
  links?: string[];
  score?: number;
  /** 1f18a9b: present on search/get/list/graph results after reindex. */
  fields?: ApiNoteFields | null;
  /**
   * Event times live as TOP-LEVEL columns on note rows — the backend's
   * `fields` dict deliberately excludes start/end/all_day (they're indexed
   * separately). The adapter merges them back into NoteFields.
   */
  event_start?: string | null;
  event_end?: string | null;
  event_all_day?: boolean;
  /** Calendar windows: one occurrence of a recurring event (original date). */
  occurrence?: string | null;
  recurring?: boolean;
  moved?: boolean;
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

/** One GET /api/search result (private SearXNG, same path as the agent tool). */
export interface ApiWebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  engine?: string;
}

/** GET /api/search — manual web search (no LLM; nothing saved to convos). */
export interface ApiWebSearchResponse {
  query: string;
  results: ApiWebSearchResult[];
  answers?: string[];
  infoboxes?: { title?: string; content?: string }[];
  /** 41f2a61: per-engine coverage — degraded search should be visible. */
  engines?: {
    responded?: Record<string, number>;
    failed?: { engine?: string; reason?: string }[];
  };
}

/** Per-model detail (f7e235b) — only from LM Studio endpoints. */
export interface ApiModelInfo {
  id: string;
  type?: string;
  state?: string;
  quantization?: string | null;
  max_context_length?: number | null;
  loaded_context_length?: number | null;
}

/** GET /api/models — live from LM Studio (may 500 if the box is down). */
export interface ApiModelsResponse {
  current: string;
  available: string[];
  /** f7e235b enrichment; empty/absent on non-LM-Studio endpoints. */
  models?: ApiModelInfo[];
  loaded?: string[];
  /** Absent (not false) when load state is unknown — make no claims then. */
  current_loaded?: boolean;
}

/** One video-transcription job (b23d8ea). */
export interface ApiTranscript {
  id: number;
  url: string;
  title?: string | null;
  channel?: string | null;
  duration_s?: number | null;
  status: 'processing' | 'done' | 'error';
  error?: string | null;
  chars?: number | null;
  snippet?: string;
  created_at: string;
  finished_at?: string | null;
  tags?: string[];
  /** Full text — only on GET /api/transcripts/{id}. */
  text?: string;
}

/** GET /api/transcripts */
export interface ApiTranscriptsResponse {
  transcripts: ApiTranscript[];
  count: number;
  /** Every tag in use (notes, chats, transcripts), most used first. */
  vocabulary?: string[];
}

/** GET /api/transcripts/{id} */
export interface ApiTranscriptResponse {
  transcript: ApiTranscript;
}

/** PUT /api/model — applies to the next message and persists. */
export interface ApiSetModelResponse {
  model_id: string;
  persisted: boolean;
}

/** PATCH /api/notes/{title} — edit an approved vault note. */
export interface ApiNoteUpdateResponse {
  note: ApiNoteResponse['note'];
  renamed?: boolean;
  /** Titles of notes whose inbound [[wikilinks]] were rewritten on rename. */
  links_rewritten?: string[];
}

/** Standard error envelope ({ "error": "..." }). */
export interface ApiError {
  error: string;
}

/** The three-dots chat card (GET/PUT/POST /api/chats/{turn_id}…). */
export interface ApiChatCard {
  root_id: number;
  tags: string[];
  summary: {
    text: string;
    proposed_tags?: string[];
    turns?: number;
    generated_at?: string;
    stale?: boolean;
  } | null;
  promoted?: boolean;
}

/** GET/PUT /api/notifications/settings */
export interface ApiNotificationSettings {
  kinds: {
    kind: string;
    label: string;
    description: string;
    default: boolean;
    enabled: boolean;
  }[];
  delivery: { ntfy: boolean };
}

/** GET /api/feed — one warm-feed item. */
export interface ApiFeedItem {
  key: string;
  type: 'chat' | 'note' | 'event' | 'approval' | 'transcript' | 'merged';
  title: string;
  subtitle?: string | null;
  warmth: string | null;
  tags?: string[];
  pinned?: boolean;
  ref?: Record<string, unknown>;
}

export interface ApiFeed {
  pinned: ApiFeedItem[];
  items: ApiFeedItem[];
}

/** An event's recurrence rule (NOTES-FORMAT.md, Recurrence). */
export interface ApiRepeatRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  by_day?: string[];
  by_month_day?: number;
  until?: string;
  count?: number;
}

/** A per-occurrence override, keyed by the occurrence's original date. */
export interface ApiOccurrenceException {
  date: string;
  cancelled?: boolean;
  start?: string;
  end?: string;
  note?: string;
}
