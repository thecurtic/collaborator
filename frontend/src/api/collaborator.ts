import type {
  BranchInput,
  ChatCard,
  NotificationSettings,
  ConversationTree,
  HealthStatus,
  Note,
  NoteDraft,
  NoteMeta,
  PromptInfo,
  ProposedDraft,
  RecallBlock,
  ScratchItem,
  ReindexResult,
  SendMessageInput,
  SynthesisResult,
  DeviceSession,
  ModelsInfo,
  NoteFieldsPatch,
  Transcript,
  TtsVoices,
  TurnsPage,
  WebSearch,
} from '@/domain/models';
import {
  toHealth,
  toDeviceSession,
  toModelsInfo,
  toTranscript,
  toTtsVoices,
  toNote,
  toNoteDraft,
  toNoteMeta,
  toPromptInfo,
  toRecallBlock,
  toScratchItem,
  toChatCard,
  toNotificationSettings,
  toTree,
  toTurnsPage,
} from '@/domain/adapters';
import { ApiRequestError, request, requestStream } from './http';
import type {
  ApiApproveResponse,
  ApiDraftsResponse,
  ApiHealth,
  ApiModelsResponse,
  ApiNoteResponse,
  ApiNoteSearchResponse,
  ApiNoteUpdateResponse,
  ApiNotesResponse,
  ApiPromptsResponse,
  ApiRecall,
  ApiScratchItem,
  ApiScratchList,
  ApiLoginResponse,
  ApiSessionsResponse,
  ApiSetModelResponse,
  ApiReindexResponse,
  ApiSendMessageResponse,
  ApiSynthesisResponse,
  ApiTranscriptResponse,
  ApiTranscriptsResponse,
  ApiChatCard,
  ApiNotificationSettings,
  ApiTree,
  ApiTtsVoices,
  ApiTurnsResponse,
  ApiWebSearchResponse,
  ApiWsTicket,
} from './types';

export interface ListTurnsParams {
  limit?: number;
  offset?: number;
}

/** Final result of a streamed branch, after the `done` event. */
export interface BranchStreamResult {
  id: number | null;
  userTurnId: number | null;
  parentTurnId: number | null;
  paragraphIndex: number | null;
  contextWindow: number | null;
  text: string;
}

/** Final result of a streamed send, after the `done` event. */
export interface SendStreamResult {
  /** Assistant turn id, if the backend reports it on the done event. */
  id: number | null;
  /** Context window size, if reported on the done event. */
  contextWindow: number | null;
  /** The full assembled response text. */
  text: string;
}

/** Parse one SSE line ("data: {...}") into its JSON payload, or null. */
function parseSseData(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const dataStr = trimmed.slice(5).trim();
  if (!dataStr || dataStr === '[DONE]') return null;
  try {
    return JSON.parse(dataStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstString(evt: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    if (typeof evt[k] === 'string') return evt[k] as string;
  }
  return '';
}

/**
 * A tool-activity `status` event, structured. Two shapes share the event type:
 * starts (no `outcome`; may carry the full query/url/title) and outcomes
 * (`outcome` always present — that field is the discriminator, per contract).
 */
export interface ToolStatusEvent {
  tool: string;
  label: string;
  /** Full untruncated query (search-type tools), url (fetch_url), title (get_note). */
  query?: string;
  url?: string;
  title?: string;
  /** Present ONLY on outcome events. */
  outcome?: 'ok' | 'empty' | 'error';
  /** web_search outcome: number of results. */
  count?: number;
  /** web_search outcome: the result URLs (page-level sources). */
  urls?: string[];
  /** error outcome: short failure reason. */
  error?: string;
  /** True when this is an outcome event ('outcome' in raw event). */
  isOutcome: boolean;
}

/** Callbacks for SSE events during a streamed send/branch. */
export interface StreamHandlers {
  /** Each incremental response chunk. */
  onToken: (chunk: string) => void;
  /** Synthesized recall block injected into context. */
  onRecall?: (block: RecallBlock) => void;
  /**
   * Chain-of-thought deltas (545e1a5) — display-only. Never persisted
   * server-side and never part of the transcript; discard when the reply
   * completes.
   */
  onReasoning?: (chunk: string) => void;
  /** Tool activity: starts and outcomes ("Searching…" → "✓ 5 results"). */
  onStatus?: (evt: ToolStatusEvent) => void;
  /** Drafts the model proposed via propose_note (pending in the inbox). */
  onDrafts?: (drafts: ProposedDraft[]) => void;
  /** Links the model wanted to read but couldn't (per-turn fetch budget). */
  onUnfollowedLinks?: (links: string[]) => void;
}

/** Parse a drafts_proposed SSE event into ProposedDraft[] (defensively). */
function toProposedDrafts(evt: Record<string, unknown>): ProposedDraft[] {
  const raw = Array.isArray(evt.drafts) ? evt.drafts : [];
  return raw.flatMap((d) => {
    const o = d as Record<string, unknown>;
    return typeof o.id === 'number' && typeof o.title === 'string'
      ? [
          {
            id: o.id,
            title: o.title,
            runId: typeof o.run_id === 'string' ? o.run_id : '',
            kind: o.kind === 'edit' ? ('edit' as const) : ('new' as const),
            targetTitle:
              typeof o.target_title === 'string' ? o.target_title : null,
          },
        ]
      : [];
  });
}

async function consumeStream(
  res: Response,
  handlers: StreamHandlers,
): Promise<{ text: string; done: Record<string, unknown> }> {
  const { onToken, onRecall, onReasoning, onStatus, onDrafts, onUnfollowedLinks } =
    handlers;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const data = (await res.json()) as ApiSendMessageResponse;
    const full = data.response ?? '';
    if (full) onToken(full);
    return { text: full, done: { id: data.id ?? null } };
  }
  if (!res.body) throw new ApiRequestError('No response stream', 0);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let done: Record<string, unknown> = {};
  const handleEvent = (evt: Record<string, unknown>) => {
    if (evt.type === 'token' && typeof evt.content === 'string') {
      text += evt.content;
      onToken(evt.content);
    } else if (evt.type === 'recall_block' || evt.type === 'recall') {
      // 9aee10b event (old `recall` kept for pre-tool-loop backends).
      // toRecallBlock guards every field — SSE payloads are unvalidated.
      onRecall?.(toRecallBlock(evt as unknown as ApiRecall));
    } else if (evt.type === 'reasoning') {
      // Display-only chain-of-thought (545e1a5); also the stream keepalive.
      if (typeof evt.content === 'string') onReasoning?.(evt.content);
    } else if (evt.type === 'status') {
      // Keepalive heartbeats (stream_reasoning=false mode) are not tool
      // activity — rendering them would add a junk row every 15s.
      if (evt.heartbeat === true) return;
      // Tool activity: start events (what it's doing) and outcome events
      // (how it went) — discriminated by the presence of `outcome`.
      const str = (k: string) =>
        typeof evt[k] === 'string' ? (evt[k] as string) : undefined;
      const rawOutcome = str('outcome');
      onStatus?.({
        tool: str('tool') ?? '',
        label: firstString(evt, ['label', 'content', 'message', 'text']),
        query: str('query'),
        url: str('url'),
        title: str('title'),
        outcome:
          rawOutcome === 'ok' ||
          rawOutcome === 'empty' ||
          rawOutcome === 'error'
            ? rawOutcome
            : undefined,
        count: typeof evt.count === 'number' ? evt.count : undefined,
        urls: Array.isArray(evt.urls)
          ? (evt.urls as unknown[]).filter(
              (u): u is string => typeof u === 'string',
            )
          : undefined,
        error: str('error'),
        isOutcome: 'outcome' in evt,
      });
    } else if (evt.type === 'tool_result') {
      // Reserved — optional "show steps" view (tools.show_step_results); off
      // by default. Not rendered yet.
    } else if (evt.type === 'drafts_proposed') {
      // The model called propose_note this turn — pending drafts await
      // review in the inbox (it can never write the vault directly).
      const drafts = toProposedDrafts(evt);
      if (drafts.length) onDrafts?.(drafts);
    } else if (evt.type === 'unfollowed_links') {
      // Fetch budget hit with links left over — offer one-tap follow-ups.
      const links = Array.isArray(evt.links)
        ? evt.links.filter((l): l is string => typeof l === 'string')
        : [];
      if (links.length) onUnfollowedLinks?.(links);
    } else if (evt.type === 'done') {
      done = evt;
    } else if (evt.type === 'error') {
      throw new ApiRequestError(
        typeof evt.detail === 'string' ? evt.detail : 'Stream error',
        500,
      );
    }
  };
  try {
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const evt = parseSseData(line);
        if (evt) handleEvent(evt);
      }
    }
    // Flush the tail: a final event with no trailing newline (or a split
    // multi-byte char in the last chunk) would otherwise be dropped —
    // losing the `done` metadata for the whole stream.
    buffer += decoder.decode();
    const tail = parseSseData(buffer);
    if (tail) handleEvent(tail);
  } finally {
    reader.releaseLock();
  }
  return { text, done };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

/**
 * The single seam between the UI and the backend.
 *
 * Today it covers exactly what API-SPEC.md implements. The recall / tagging /
 * settings surface from INTENTS.md is intentionally listed below as a roadmap
 * so it can be added here (and optionally mock-implemented) without changing
 * any calling code. UI/hooks should depend on this interface, never on fetch.
 */
export interface CollaboratorApi {
  health(): Promise<HealthStatus>;
  /**
   * Probe an authenticated endpoint to check the current passkey (or that auth
   * is disabled). Resolves if allowed; throws ApiRequestError(403) if the
   * passkey is missing/invalid. /api/health can't be used — it's unauthenticated.
   */
  verifyAuth(): Promise<void>;
  listTurns(params?: ListTurnsParams): Promise<TurnsPage>;
  /**
   * Send a message and stream the assistant response (SSE). `handlers.onToken`
   * fires per chunk; the promise resolves with final metadata once the `done`
   * event arrives. Pass a signal to cancel mid-stream.
   */
  sendMessageStream(
    input: SendMessageInput,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<SendStreamResult>;
  /** Branch from a turn (or paragraph), streaming the reply like sendMessageStream. */
  branchMessage(
    input: BranchInput,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<BranchStreamResult>;
  /** Full conversation tree (for branch navigation / metro map). */
  getTree(): Promise<ConversationTree>;
  /**
   * Hard-delete a turn. Default reparents its children up one level; pass
   * `subtree: true` to delete the whole branch (the turn + all descendants).
   */
  deleteTurn(turnId: number, subtree?: boolean): Promise<void>;
  /** Set (or clear, with an empty string) a turn's name. */
  renameTurn(turnId: number, name: string): Promise<void>;
  /**
   * Regenerate the LLM title for the conversation containing `turnId`
   * (resolves to the root). 502 = generation failed.
   */
  regenerateTitle(turnId: number): Promise<string>;
  /**
   * Set a conversation's stage. Applies to the turn's ENTIRE subtree, so call
   * it on the conversation's root to promote the whole chat (seed → tree).
   */
  setTurnState(turnId: number, state: 'seed' | 'tree'): Promise<void>;

  // --- Notifications: the settings list + delivery test ---
  getNotificationSettings(): Promise<NotificationSettings>;
  /** Turn kinds on/off; omitted kinds keep their setting. */
  setNotificationKinds(enabled: Record<string, boolean>): Promise<NotificationSettings>;
  /** Send a test through the configured delivery; resolves to its status. */
  sendTestNotification(): Promise<string>;

  // --- Chats: chat-level tags + the three-dots card (any turn id in a chat) ---
  /** The card: the chat's tags and its cached summary (null until generated). */
  getChat(turnId: number): Promise<ChatCard>;
  /** Replace the chat's tags (full list; [] clears). Non-empty promotes a seed. */
  setChatTags(turnId: number, tags: string[]): Promise<ChatCard>;
  /**
   * Generate the summary (and tag proposals) from the branch through
   * `turnId` to its latest leaf. 502 = generation failed.
   */
  summarizeChat(turnId: number): Promise<ChatCard>;

  /** Short-lived single-use ticket for WS auth (fetch right before opening). */
  getWsTicket(): Promise<string>;

  // --- Device sessions (b60da69) — the passkey is never stored client-side ---
  /**
   * Exchange the passkey for a device session. Browsers get an httpOnly
   * cookie (ignore the returned token); the Android shell stores the token
   * for the X-Session header. 403 = wrong passkey; 429 = lockout (see
   * ApiRequestError.retryAfterS).
   */
  login(
    passkey: string,
    deviceLabel: string,
  ): Promise<{ token: string; sessionId: number; expiresAt: string }>;
  /** Every logged-in device, the current one flagged. */
  listSessions(): Promise<DeviceSession[]>;
  /** Revoke one device's session immediately (the lost-phone story). */
  revokeSession(id: number): Promise<void>;
  /** Revoke the current session and clear the cookie. */
  logout(): Promise<void>;

  // --- Server voice tier (9acc3d1) — gate on health capabilities ---
  /** Server TTS voice roster for the picker (capabilities.ttsStream only). */
  getTtsVoices(): Promise<TtsVoices>;
  /**
   * Synthesize text to a playable audio Blob (POST /api/tts, streaming WAV).
   * Callers pipeline sentence-by-sentence, so awaiting each small body whole
   * keeps first-audio latency low without MediaSource plumbing.
   * 503 = TTS not configured; 404 = unknown voice; 422 = empty text.
   */
  synthesizeSpeech(text: string, voice?: string): Promise<Blob>;

  // --- Notes pipeline ---
  /**
   * One LLM pass over a tree (root id) or branch (any committed turn id) →
   * pending drafts. Synchronous and potentially SLOW (minutes on local
   * inference); zero drafts is a valid outcome.
   */
  synthesizeNotes(treeId: number): Promise<SynthesisResult>;
  listDrafts(params?: {
    status?: 'pending' | 'approved' | 'rejected';
    runId?: string;
  }): Promise<NoteDraft[]>;
  /** Edit a PENDING draft (409 once decided). */
  updateDraft(
    id: number,
    patch: {
      title?: string;
      body?: string;
      tags?: string[];
      links?: string[];
      /** Event drafts: corrected times (85c508c). */
      fields?: NoteFieldsPatch;
    },
  ): Promise<void>;
  /**
   * Approve: writes the vault file (new drafts) or applies the change to the
   * target note (edit drafts — renames rewrite inbound wikilinks). Throws
   * 422 (invalid title) or 409 (title collision, or an edit draft's target
   * was deleted/renamed since the proposal — detail explains).
   */
  approveDraft(
    id: number,
  ): Promise<{ filename: string; renamed: boolean; linksRewritten: string[] }>;
  rejectDraft(id: number): Promise<void>;
  listNotes(tag?: string): Promise<NoteMeta[]>;
  searchNotes(
    q: string,
    mode?: 'semantic' | 'keyword',
    limit?: number,
    /** Scope results to one reserved category tag (5b3e491). */
    tag?: string,
  ): Promise<NoteMeta[]>;
  getNote(title: string): Promise<Note>;
  /**
   * Event notes overlapping [from, to] (inclusive ISO dates), sorted by
   * start — the calendar query (85c508c).
   */
  listEvents(from: string, to: string): Promise<NoteMeta[]>;
  /** RFC 5545 export of events (85c508c) — offer as a file download. */
  downloadEventsIcs(): Promise<Blob>;
  /**
   * Delete a vault note (file + index). Inbound wikilinks become unresolved
   * (Obsidian semantics); deleting USER resets the profile hub. Returns the
   * titles of notes now holding unresolved links.
   */
  deleteNote(title: string): Promise<{ linksNowUnresolvedIn: string[] }>;
  /** Reconcile the index with the vault (after external Obsidian edits). */
  reindexNotes(): Promise<ReindexResult>;

  /**
   * Edit an approved vault note (all fields optional — send what changed).
   * Rename is safe: the backend rewrites inbound wikilinks vault-wide and
   * reports the touched titles. Throws 404/422/409 (title problems).
   */
  updateNote(
    title: string,
    patch: {
      title?: string;
      body?: string;
      tags?: string[];
      /** 1f18a9b: typed frontmatter; '' / [] clears a key (422 on invalid). */
      fields?: NoteFieldsPatch;
    },
  ): Promise<{ note: Note; renamed: boolean; linksRewritten: string[] }>;

  /**
   * Prompt building blocks as the runtime resolves them (References viewer).
   * READ-ONLY — editability is shelved backend-side; don't add edit UI.
   */
  listPrompts(): Promise<PromptInfo[]>;

  /**
   * Manual (raw) web search via the private SearXNG instance — no LLM,
   * nothing saved to any conversation. Errors matter to the UI: 502 = engines
   * failed (detail has per-engine reasons — render as a failure, NOT "no
   * results"); 503 = search not configured on this server.
   */
  searchWeb(q: string, limit?: number): Promise<WebSearch>;

  /**
   * Current + available chat models, with per-model load state when the
   * endpoint is LM Studio (f7e235b). GET may 500 when the box is down.
   */
  getModels(): Promise<ModelsInfo>;

  // --- Scratch (notes-to-self, 7444138): inert capture, opt-in actions ---
  /** Capture text/URL. Inert forever — zero model contact. */
  addScratch(content: string): Promise<ScratchItem>;
  /** Capture a file (photo/audio/anything) with an optional caption. */
  addScratchMedia(file: File | Blob, filename: string, content?: string): Promise<ScratchItem>;
  /** Authenticated media bytes for an item (thumbnails, audio playback). */
  getScratchMedia(id: number): Promise<Blob>;
  /** Newest first; `q` searches content + transcripts; `before` pages older. */
  listScratch(params?: {
    q?: string;
    before?: number;
    limit?: number;
  }): Promise<ScratchItem[]>;
  /** The hold-send gesture: one-shot agent action on this item. */
  actScratch(id: number): Promise<ScratchItem>;
  /** Toggle the has-the-LLM-seen-this flag. */
  setScratchReadable(id: number, readable: boolean): Promise<ScratchItem>;
  deleteScratch(id: number): Promise<void>;

  /**
   * Background video-transcription jobs (b23d8ea), newest first. Optional
   * filters: `channel` (substring) and `q` (keywords over title, channel and
   * full text; matches carry a snippet).
   */
  listTranscripts(filter?: { channel?: string; q?: string }): Promise<Transcript[]>;
  /** One job including its full text. */
  getTranscript(id: number): Promise<Transcript>;
  /** Delete a stored transcript (row only; the source video is remote). */
  deleteTranscript(id: number): Promise<void>;
  /**
   * Switch the chat model — applies to the very next message and persists.
   * PER-INSTALL: changes the model for every user, not just this passkey.
   * 422 = not in the available list; retry with force only as an advanced
   * user action.
   */
  setModel(modelId: string, force?: boolean): Promise<void>;

  // --- Roadmap (INTENTS.md "API Extensions Needed", not yet served) ---
  // editRecall(input): Promise<RecallSynthesis>;
  // setTurnTags(turnId, { add, remove }): Promise<string[]>;
  // configureRecall(settings): Promise<void>;
}

class HttpCollaboratorApi implements CollaboratorApi {
  async health(): Promise<HealthStatus> {
    return toHealth(await request<ApiHealth>('/api/health'));
  }

  async verifyAuth(): Promise<void> {
    // Smallest authenticated call; we only care that it isn't a 403.
    await request<ApiTurnsResponse>('/api/messages?limit=1');
  }

  async listTurns(params: ListTurnsParams = {}): Promise<TurnsPage> {
    const search = new URLSearchParams();
    if (params.limit != null) search.set('limit', String(params.limit));
    if (params.offset != null) search.set('offset', String(params.offset));
    const qs = search.toString();
    const res = await request<ApiTurnsResponse>(
      `/api/messages${qs ? `?${qs}` : ''}`,
    );
    return toTurnsPage(res);
  }

  async sendMessageStream(
    input: SendMessageInput,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<SendStreamResult> {
    const res = await requestStream('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        message: input.message,
        // Active leaf to continue from; omit only for a brand-new conversation.
        parent_turn_id: input.parentTurnId,
        context_turns: input.contextTurns,
        commit: input.commit,
        user_id: input.userId,
        mode: input.mode,
        // 9aee10b: `tools` supersedes the misnamed `recall` alias.
        tools: input.tools,
        // b23d8ea: opt-in per-turn location (absent = no placeholder).
        location: input.location,
        state: input.state,
      }),
      signal,
    });
    const { text, done } = await consumeStream(res, handlers);
    return {
      id: numOrNull(done.id),
      contextWindow: numOrNull(done.context_turns_used),
      text,
    };
  }

  async branchMessage(
    input: BranchInput,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<BranchStreamResult> {
    const res = await requestStream(`/api/branches/${input.parentTurnId}`, {
      method: 'POST',
      body: JSON.stringify({
        message: input.message,
        paragraph_index: input.paragraphIndex,
        context_turns: input.contextTurns,
        commit: input.commit,
        mode: input.mode,
        // 9aee10b: `tools` supersedes the misnamed `recall` alias.
        tools: input.tools,
        // b23d8ea: opt-in per-turn location (absent = no placeholder).
        location: input.location,
      }),
      signal,
    });
    const { text, done } = await consumeStream(res, handlers);
    return {
      id: numOrNull(done.id),
      userTurnId: numOrNull(done.user_turn_id),
      parentTurnId: numOrNull(done.parent_turn_id),
      paragraphIndex: numOrNull(done.paragraph_index),
      contextWindow: numOrNull(done.context_turns_used),
      text,
    };
  }

  async getTree(): Promise<ConversationTree> {
    return toTree(await request<ApiTree>('/api/tree'));
  }

  async deleteTurn(turnId: number, subtree = false): Promise<void> {
    const qs = subtree ? '?subtree=true' : '';
    await request<unknown>(`/api/messages/${turnId}${qs}`, { method: 'DELETE' });
  }

  async renameTurn(turnId: number, name: string): Promise<void> {
    await request<unknown>(`/api/turns/${turnId}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  }

  async regenerateTitle(turnId: number): Promise<string> {
    const res = await request<{ root_id: number; title: string }>(
      `/api/turns/${turnId}/title`,
      { method: 'POST' },
    );
    return res.title;
  }

  async setTurnState(turnId: number, state: 'seed' | 'tree'): Promise<void> {
    await request<unknown>(`/api/turns/${turnId}/state`, {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    });
  }

  async getNotificationSettings(): Promise<NotificationSettings> {
    return toNotificationSettings(
      await request<ApiNotificationSettings>('/api/notifications/settings'),
    );
  }

  async setNotificationKinds(
    enabled: Record<string, boolean>,
  ): Promise<NotificationSettings> {
    return toNotificationSettings(
      await request<ApiNotificationSettings>('/api/notifications/settings', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    );
  }

  async sendTestNotification(): Promise<string> {
    const res = await request<{ delivered: string }>('/api/notifications/test', {
      method: 'POST',
    });
    return res.delivered;
  }

  async getChat(turnId: number): Promise<ChatCard> {
    return toChatCard(await request<ApiChatCard>(`/api/chats/${turnId}`));
  }

  async setChatTags(turnId: number, tags: string[]): Promise<ChatCard> {
    return toChatCard(
      await request<ApiChatCard>(`/api/chats/${turnId}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tags }),
      }),
    );
  }

  async summarizeChat(turnId: number): Promise<ChatCard> {
    return toChatCard(
      await request<ApiChatCard>(`/api/chats/${turnId}/summary`, {
        method: 'POST',
      }),
    );
  }

  async getWsTicket(): Promise<string> {
    const res = await request<ApiWsTicket>('/api/auth/ws-ticket', {
      method: 'POST',
    });
    return res.ticket;
  }

  async login(
    passkey: string,
    deviceLabel: string,
  ): Promise<{ token: string; sessionId: number; expiresAt: string }> {
    const res = await request<ApiLoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ passkey, device_label: deviceLabel }),
    });
    return {
      token: res.token,
      sessionId: res.session_id,
      expiresAt: res.expires_at,
    };
  }

  async listSessions(): Promise<DeviceSession[]> {
    const res = await request<ApiSessionsResponse>('/api/auth/sessions');
    return (res.sessions ?? []).map(toDeviceSession);
  }

  async revokeSession(id: number): Promise<void> {
    await request<unknown>(`/api/auth/sessions/${id}`, { method: 'DELETE' });
  }

  async logout(): Promise<void> {
    await request<unknown>('/api/auth/logout', { method: 'POST' });
  }

  async listEvents(from: string, to: string): Promise<NoteMeta[]> {
    const search = new URLSearchParams({ tag: 'event', from, to });
    const res = await request<ApiNoteSearchResponse>(
      `/api/notes/search?${search.toString()}`,
    );
    return (res.results ?? []).map(toNoteMeta);
  }

  async downloadEventsIcs(): Promise<Blob> {
    const res = await requestStream('/api/events.ics');
    return res.blob();
  }

  async getTtsVoices(): Promise<TtsVoices> {
    return toTtsVoices(await request<ApiTtsVoices>('/api/tts/voices'));
  }

  async synthesizeSpeech(text: string, voice?: string): Promise<Blob> {
    const res = await requestStream('/api/tts', {
      method: 'POST',
      body: JSON.stringify({ text, ...(voice ? { voice } : {}), format: 'wav' }),
    });
    return res.blob();
  }

  async synthesizeNotes(treeId: number): Promise<SynthesisResult> {
    const res = await request<ApiSynthesisResponse>(
      `/api/notes/synthesize/${treeId}`,
      { method: 'POST' },
    );
    return {
      runId: res.run_id,
      drafts: (res.drafts ?? []).map(toNoteDraft),
      count: res.count ?? 0,
    };
  }

  async listDrafts(
    params: { status?: 'pending' | 'approved' | 'rejected'; runId?: string } = {},
  ): Promise<NoteDraft[]> {
    const search = new URLSearchParams();
    if (params.status) search.set('status', params.status);
    if (params.runId) search.set('run_id', params.runId);
    const qs = search.toString();
    const res = await request<ApiDraftsResponse>(
      `/api/notes/drafts${qs ? `?${qs}` : ''}`,
    );
    return (res.drafts ?? []).map(toNoteDraft);
  }

  async updateDraft(
    id: number,
    patch: {
      title?: string;
      body?: string;
      tags?: string[];
      links?: string[];
      /** Event drafts: corrected times (85c508c). */
      fields?: NoteFieldsPatch;
    },
  ): Promise<void> {
    await request<unknown>(`/api/notes/drafts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async approveDraft(
    id: number,
  ): Promise<{ filename: string; renamed: boolean; linksRewritten: string[] }> {
    const res = await request<ApiApproveResponse>(
      `/api/notes/drafts/${id}/approve`,
      { method: 'POST' },
    );
    return {
      filename: res.filename,
      renamed: res.renamed === true,
      linksRewritten: res.links_rewritten ?? [],
    };
  }

  async rejectDraft(id: number): Promise<void> {
    await request<unknown>(`/api/notes/drafts/${id}/reject`, { method: 'POST' });
  }

  async listNotes(tag?: string): Promise<NoteMeta[]> {
    const qs = tag ? `?tag=${encodeURIComponent(tag)}` : '';
    const res = await request<ApiNotesResponse>(`/api/notes${qs}`);
    return (res.notes ?? []).map(toNoteMeta);
  }

  async searchNotes(
    q: string,
    mode: 'semantic' | 'keyword' = 'semantic',
    limit = 20,
    tag?: string,
  ): Promise<NoteMeta[]> {
    const search = new URLSearchParams({ q, mode, limit: String(limit) });
    if (tag) search.set('tag', tag); // 5b3e491: category-scoped search
    const res = await request<ApiNoteSearchResponse>(
      `/api/notes/search?${search.toString()}`,
    );
    return (res.results ?? []).map(toNoteMeta);
  }

  async getNote(title: string): Promise<Note> {
    const res = await request<ApiNoteResponse>(
      `/api/notes/${encodeURIComponent(title)}`,
    );
    return toNote(res.note);
  }

  async deleteNote(
    title: string,
  ): Promise<{ linksNowUnresolvedIn: string[] }> {
    const res = await request<{ links_now_unresolved_in?: string[] }>(
      `/api/notes/${encodeURIComponent(title)}`,
      { method: 'DELETE' },
    );
    return {
      linksNowUnresolvedIn: (res.links_now_unresolved_in ?? []).filter(
        (t): t is string => typeof t === 'string',
      ),
    };
  }

  async reindexNotes(): Promise<ReindexResult> {
    return request<ApiReindexResponse>('/api/notes/reindex', { method: 'POST' });
  }

  async listPrompts(): Promise<PromptInfo[]> {
    const res = await request<ApiPromptsResponse>('/api/prompts');
    return (res.prompts ?? []).map(toPromptInfo);
  }

  async updateNote(
    title: string,
    patch: {
      title?: string;
      body?: string;
      tags?: string[];
      fields?: NoteFieldsPatch;
    },
  ): Promise<{ note: Note; renamed: boolean; linksRewritten: string[] }> {
    const res = await request<ApiNoteUpdateResponse>(
      `/api/notes/${encodeURIComponent(title)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    return {
      note: toNote(res.note),
      renamed: res.renamed === true,
      linksRewritten: res.links_rewritten ?? [],
    };
  }

  async searchWeb(q: string, limit = 15): Promise<WebSearch> {
    const search = new URLSearchParams({ q, limit: String(limit) });
    const res = await request<ApiWebSearchResponse>(
      `/api/search?${search.toString()}`,
    );
    return {
      query: res.query ?? q,
      results: (res.results ?? []).map((r) => ({
        title: r.title || r.url,
        url: r.url,
        snippet: r.snippet ?? '',
        engine: r.engine ?? '',
      })),
      answers: (res.answers ?? []).filter((a) => typeof a === 'string'),
      infoboxes: (res.infoboxes ?? []).map((b) => ({
        title: b.title ?? '',
        content: b.content ?? '',
      })),
      enginesResponded: res.engines?.responded ?? {},
      enginesFailed: (res.engines?.failed ?? [])
        .filter((f) => typeof f.engine === 'string' && f.engine)
        .map((f) => ({ engine: f.engine as string, reason: f.reason ?? null })),
    };
  }

  async getModels(): Promise<ModelsInfo> {
    return toModelsInfo(await request<ApiModelsResponse>('/api/models'));
  }

  async addScratch(content: string): Promise<ScratchItem> {
    const res = await request<{ item: ApiScratchItem }>('/api/scratch', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    return toScratchItem(res.item);
  }

  async addScratchMedia(
    file: File | Blob,
    filename: string,
    content?: string,
  ): Promise<ScratchItem> {
    const form = new FormData();
    form.append('file', file, filename);
    if (content) form.append('content', content);
    // http.ts skips the JSON Content-Type for FormData (browser sets the
    // multipart boundary itself).
    const res = await request<{ item: ApiScratchItem }>('/api/scratch/media', {
      method: 'POST',
      body: form,
    });
    return toScratchItem(res.item);
  }

  async getScratchMedia(id: number): Promise<Blob> {
    const res = await requestStream(`/api/scratch/${id}/media`);
    return res.blob();
  }

  async listScratch(
    params: { q?: string; before?: number; limit?: number } = {},
  ): Promise<ScratchItem[]> {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.before != null) search.set('before', String(params.before));
    if (params.limit != null) search.set('limit', String(params.limit));
    const qs = search.toString();
    const res = await request<ApiScratchList>(
      `/api/scratch${qs ? `?${qs}` : ''}`,
    );
    return (res.items ?? []).map(toScratchItem);
  }

  async actScratch(id: number): Promise<ScratchItem> {
    const res = await request<{ item: ApiScratchItem }>(
      `/api/scratch/${id}/act`,
      { method: 'POST' },
    );
    return toScratchItem(res.item);
  }

  async setScratchReadable(
    id: number,
    readable: boolean,
  ): Promise<ScratchItem> {
    const res = await request<{ item: ApiScratchItem }>(`/api/scratch/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ llm_readable: readable }),
    });
    return toScratchItem(res.item);
  }

  async deleteScratch(id: number): Promise<void> {
    await request<unknown>(`/api/scratch/${id}`, { method: 'DELETE' });
  }

  async deleteTranscript(id: number): Promise<void> {
    await request<unknown>(`/api/transcripts/${id}`, { method: 'DELETE' });
  }

  async listTranscripts(filter?: {
    channel?: string;
    q?: string;
  }): Promise<Transcript[]> {
    const params = new URLSearchParams();
    if (filter?.channel) params.set('channel', filter.channel);
    if (filter?.q?.trim()) params.set('q', filter.q.trim());
    const qs = params.toString();
    const res = await request<ApiTranscriptsResponse>(
      `/api/transcripts${qs ? `?${qs}` : ''}`,
    );
    return (res.transcripts ?? []).map(toTranscript);
  }

  async getTranscript(id: number): Promise<Transcript> {
    const res = await request<ApiTranscriptResponse>(`/api/transcripts/${id}`);
    return toTranscript(res.transcript);
  }

  async setModel(modelId: string, force = false): Promise<void> {
    await request<ApiSetModelResponse>('/api/model', {
      method: 'PUT',
      body: JSON.stringify({ model_id: modelId, ...(force ? { force } : {}) }),
    });
  }
}

/** The app-wide API instance. Swap here to introduce a mock for recall work. */
export const api: CollaboratorApi = new HttpCollaboratorApi();
