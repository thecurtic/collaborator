import type {
  BranchInput,
  ConversationTree,
  HealthStatus,
  RecallBlock,
  RecallSource,
  SendMessageInput,
  SendMessageResult,
  TurnsPage,
} from '@/domain/models';
import { toHealth, toSendResult, toTree, toTurnsPage } from '@/domain/adapters';
import { ApiRequestError, request, requestStream } from './http';
import type {
  ApiHealth,
  ApiSendMessageResponse,
  ApiTranscription,
  ApiTree,
  ApiTurnsResponse,
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

/**
 * Consume an SSE stream from /api/messages or /api/branches: fire `onToken` per
 * token and return the assembled text plus the `done` event payload. Tolerates a
 * non-streaming JSON fallback.
 */
function toRecallBlock(evt: Record<string, unknown>): RecallBlock {
  const raw = Array.isArray(evt.sources) ? evt.sources : [];
  const sources: RecallSource[] = raw.map((s) => {
    const o = s as Record<string, unknown>;
    return {
      turnId: typeof o.turn_id === 'number' ? o.turn_id : 0,
      role: typeof o.role === 'string' ? o.role : '',
      tags: Array.isArray(o.tags) ? (o.tags as string[]) : [],
      branchRootId: typeof o.branch_root_id === 'number' ? o.branch_root_id : null,
      similarity: typeof o.similarity === 'number' ? o.similarity : 0,
      score: typeof o.score === 'number' ? o.score : 0,
      preview: typeof o.preview === 'string' ? o.preview : '',
    };
  });
  return {
    content: typeof evt.content === 'string' ? evt.content : '',
    sources,
  };
}

function firstString(evt: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    if (typeof evt[k] === 'string') return evt[k] as string;
  }
  return '';
}

async function consumeStream(
  res: Response,
  onToken: (chunk: string) => void,
  onRecall?: (block: RecallBlock) => void,
  onStatus?: (text: string) => void,
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
          onRecall?.(toRecallBlock(evt));
        } else if (evt.type === 'status') {
          // Tool-calling: a live "what it's doing" line (best-effort shape).
          onStatus?.(firstString(evt, ['content', 'message', 'status', 'text']));
        } else if (evt.type === 'tool_result') {
          // Reserved — full rendering once the tool-calling one-pager lands.
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
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
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
  ): Promise<SendStreamResult>;
  /** Branch from a turn (or paragraph), streaming the reply like sendMessageStream. */
  branchMessage(
    input: BranchInput,
    onToken: (chunk: string) => void,
    signal?: AbortSignal,
    onRecall?: (block: RecallBlock) => void,
    onStatus?: (text: string) => void,
  ): Promise<BranchStreamResult>;
  /** Full conversation tree (for branch navigation / metro map). */
  getTree(): Promise<ConversationTree>;
  /**
   * Hard-delete a turn. Default reparents its children up one level; pass
   * `subtree: true` to delete the whole branch (the turn + all descendants).
   */
  deleteTurn(turnId: number, subtree?: boolean): Promise<void>;

  /** Transcribe recorded audio to text (Whisper, backend). */
  transcribe(audio: Blob, opts?: TranscribeOptions): Promise<string>;

  // --- Roadmap (INTENTS.md "API Extensions Needed", not yet served) ---
  // synthesizeRecall(input): Promise<RecallSynthesis>;
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

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const res = await request<ApiSendMessageResponse>('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        message: input.message,
        context_turns: input.contextTurns,
        commit: input.commit,
        user_id: input.userId,
        mode: input.mode,
      }),
    });
    return toSendResult(res);
  }

  async sendMessageStream(
    input: SendMessageInput,
    onToken: (chunk: string) => void,
    signal?: AbortSignal,
    onRecall?: (block: RecallBlock) => void,
    onStatus?: (text: string) => void,
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
    const { text, done } = await consumeStream(res, onToken, onRecall, onStatus);
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
    const { text, done } = await consumeStream(res, onToken, onRecall, onStatus);
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
}

/** The app-wide API instance. Swap here to introduce a mock for recall work. */
export const api: CollaboratorApi = new HttpCollaboratorApi();
