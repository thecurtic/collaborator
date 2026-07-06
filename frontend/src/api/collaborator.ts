import type {
  BranchInput,
  ConversationTree,
  HealthStatus,
  Note,
  NoteDraft,
  NoteMeta,
  ProposedDraft,
  RecallBlock,
  ReindexResult,
  SendMessageInput,
  SynthesisResult,
  TurnsPage,
} from '@/domain/models';
import {
  toHealth,
  toNote,
  toNoteDraft,
  toNoteMeta,
  toRecallBlock,
  toTree,
  toTurnsPage,
} from '@/domain/adapters';
import { ApiRequestError, request, requestStream } from './http';
import type {
  ApiApproveResponse,
  ApiDraftsResponse,
  ApiHealth,
  ApiNoteResponse,
  ApiNoteSearchResponse,
  ApiNotesResponse,
  ApiRecall,
  ApiReindexResponse,
  ApiSendMessageResponse,
  ApiSynthesisResponse,
  ApiTranscription,
  ApiTree,
  ApiTurnsResponse,
  ApiWsTicket,
} from './types';

export interface TranscribeOptions {
  language?: string;
  /** Filename hint (extension helps the backend pick a demuxer). */
  filename?: string;
}

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
          },
        ]
      : [];
  });
}

async function consumeStream(
  res: Response,
  onToken: (chunk: string) => void,
  onRecall?: (block: RecallBlock) => void,
  onStatus?: (text: string) => void,
  onDrafts?: (drafts: ProposedDraft[]) => void,
): Promise<{ text: string; done: Record<string, unknown> }> {
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
  try {
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const evt = parseSseData(line);
        if (!evt) continue;
        if (evt.type === 'token' && typeof evt.content === 'string') {
          text += evt.content;
          onToken(evt.content);
        } else if (evt.type === 'recall') {
          // toRecallBlock guards every field — SSE payloads are unvalidated.
          onRecall?.(toRecallBlock(evt as unknown as ApiRecall));
        } else if (evt.type === 'status') {
          // Tool-calling: a live "what it's doing" line, e.g.
          // {"type":"status","tool":"recall_semantic","label":"Searching memory…"}
          onStatus?.(firstString(evt, ['label', 'content', 'message', 'text']));
        } else if (evt.type === 'tool_result') {
          // Reserved — optional "show steps" view (tools.show_step_results); off
          // by default. Not rendered yet.
        } else if (evt.type === 'drafts_proposed') {
          // The model called propose_note this turn — pending drafts await
          // review in the inbox (it can never write the vault directly).
          const drafts = toProposedDrafts(evt);
          if (drafts.length) onDrafts?.(drafts);
        } else if (evt.type === 'done') {
          done = evt;
        } else if (evt.type === 'error') {
          throw new ApiRequestError(
            typeof evt.detail === 'string' ? evt.detail : 'Stream error',
            500,
          );
        }
      }
    }
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
   * Send a message and stream the assistant response (SSE). `onToken` fires for
   * each incremental chunk; the promise resolves with final metadata once the
   * `done` event arrives. Pass a signal to cancel mid-stream.
   */
  sendMessageStream(
    input: SendMessageInput,
    onToken: (chunk: string) => void,
    signal?: AbortSignal,
    onRecall?: (block: RecallBlock) => void,
    onStatus?: (text: string) => void,
    onDrafts?: (drafts: ProposedDraft[]) => void,
  ): Promise<SendStreamResult>;
  /** Branch from a turn (or paragraph), streaming the reply like sendMessageStream. */
  branchMessage(
    input: BranchInput,
    onToken: (chunk: string) => void,
    signal?: AbortSignal,
    onRecall?: (block: RecallBlock) => void,
    onStatus?: (text: string) => void,
    onDrafts?: (drafts: ProposedDraft[]) => void,
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
   * Set a conversation's stage. Applies to the turn's ENTIRE subtree, so call
   * it on the conversation's root to promote the whole chat (seed → tree).
   */
  setTurnState(turnId: number, state: 'seed' | 'tree'): Promise<void>;

  /** Transcribe recorded audio to text (Whisper, backend). */
  transcribe(audio: Blob, opts?: TranscribeOptions): Promise<string>;

  /** Short-lived single-use ticket for WS auth (fetch right before opening). */
  getWsTicket(): Promise<string>;

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
   * Approve: writes the vault file. Throws ApiRequestError 422 (invalid
   * title) or 409 (title collision — draft stays pending; rename and retry).
   */
  approveDraft(id: number): Promise<{ filename: string }>;
  rejectDraft(id: number): Promise<void>;
  listNotes(tag?: string): Promise<NoteMeta[]>;
  searchNotes(
    q: string,
    mode?: 'semantic' | 'keyword',
    limit?: number,
  ): Promise<NoteMeta[]>;
  getNote(title: string): Promise<Note>;
  /** Reconcile the index with the vault (after external Obsidian edits). */
  reindexNotes(): Promise<ReindexResult>;

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
    onToken: (chunk: string) => void,
    signal?: AbortSignal,
    onRecall?: (block: RecallBlock) => void,
    onStatus?: (text: string) => void,
    onDrafts?: (drafts: ProposedDraft[]) => void,
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
        recall: input.recall,
      }),
      signal,
    });
    const { text, done } = await consumeStream(
      res,
      onToken,
      onRecall,
      onStatus,
      onDrafts,
    );
    return {
      id: numOrNull(done.id),
      contextWindow: numOrNull(done.context_turns_used),
      text,
    };
  }

  async branchMessage(
    input: BranchInput,
    onToken: (chunk: string) => void,
    signal?: AbortSignal,
    onRecall?: (block: RecallBlock) => void,
    onStatus?: (text: string) => void,
    onDrafts?: (drafts: ProposedDraft[]) => void,
  ): Promise<BranchStreamResult> {
    const res = await requestStream(`/api/branches/${input.parentTurnId}`, {
      method: 'POST',
      body: JSON.stringify({
        message: input.message,
        paragraph_index: input.paragraphIndex,
        context_turns: input.contextTurns,
        commit: input.commit,
        mode: input.mode,
        recall: input.recall,
      }),
      signal,
    });
    const { text, done } = await consumeStream(
      res,
      onToken,
      onRecall,
      onStatus,
      onDrafts,
    );
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

  async setTurnState(turnId: number, state: 'seed' | 'tree'): Promise<void> {
    await request<unknown>(`/api/turns/${turnId}/state`, {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    });
  }

  async transcribe(audio: Blob, opts: TranscribeOptions = {}): Promise<string> {
    const form = new FormData();
    form.append('audio', audio, opts.filename ?? 'recording.webm');
    if (opts.language) form.append('language', opts.language);
    const res = await request<ApiTranscription>('/api/transcribe', {
      method: 'POST',
      body: form,
    });
    return res.text;
  }

  async getWsTicket(): Promise<string> {
    const res = await request<ApiWsTicket>('/api/auth/ws-ticket', {
      method: 'POST',
    });
    return res.ticket;
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

  async approveDraft(id: number): Promise<{ filename: string }> {
    const res = await request<ApiApproveResponse>(
      `/api/notes/drafts/${id}/approve`,
      { method: 'POST' },
    );
    return { filename: res.filename };
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
  ): Promise<NoteMeta[]> {
    const search = new URLSearchParams({ q, mode, limit: String(limit) });
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
}

/** The app-wide API instance. Swap here to introduce a mock for recall work. */
export const api: CollaboratorApi = new HttpCollaboratorApi();
