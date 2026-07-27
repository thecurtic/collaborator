import type {
  BranchInput,
  ConversationTree,
  HealthStatus,
  Note,
  NoteDraft,
  NoteMeta,
  PromptInfo,
  ProposedDraft,
  RecallBlock,
  ReindexResult,
  SendMessageInput,
  SynthesisResult,
  TtsVoices,
  TurnsPage,
  WebSearch,
} from '@/domain/models';
import {
  toHealth,
  toTtsVoices,
  toNote,
  toNoteDraft,
  toNoteMeta,
  toPromptInfo,
  toRecallBlock,
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
  ApiSetModelResponse,
  ApiReindexResponse,
  ApiSendMessageResponse,
  ApiSynthesisResponse,
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
  const { onToken, onRecall, onStatus, onDrafts, onUnfollowedLinks } = handlers;
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
    } else if (evt.type === 'status') {
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

  /** Short-lived single-use ticket for WS auth (fetch right before opening). */
  getWsTicket(): Promise<string>;

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
    patch: { title?: string; body?: string; tags?: string[]; links?: string[] },
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
  /** Reconcile the index with the vault (after external Obsidian edits). */
  reindexNotes(): Promise<ReindexResult>;

  /**
   * Edit an approved vault note (all fields optional — send what changed).
   * Rename is safe: the backend rewrites inbound wikilinks vault-wide and
   * reports the touched titles. Throws 404/422/409 (title problems).
   */
  updateNote(
    title: string,
    patch: { title?: string; body?: string; tags?: string[] },
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

  /** Current + available chat models (live from LM Studio; GET may 500). */
  getModels(): Promise<{ current: string; available: string[] }>;
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

  async getWsTicket(): Promise<string> {
    const res = await request<ApiWsTicket>('/api/auth/ws-ticket', {
      method: 'POST',
    });
    return res.ticket;
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
    patch: { title?: string; body?: string; tags?: string[]; links?: string[] },
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

  async reindexNotes(): Promise<ReindexResult> {
    return request<ApiReindexResponse>('/api/notes/reindex', { method: 'POST' });
  }

  async listPrompts(): Promise<PromptInfo[]> {
    const res = await request<ApiPromptsResponse>('/api/prompts');
    return (res.prompts ?? []).map(toPromptInfo);
  }

  async updateNote(
    title: string,
    patch: { title?: string; body?: string; tags?: string[] },
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
    };
  }

  async getModels(): Promise<{ current: string; available: string[] }> {
    const res = await request<ApiModelsResponse>('/api/models');
    return { current: res.current, available: res.available ?? [] };
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
