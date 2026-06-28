import type {
  HealthStatus,
  SendMessageInput,
  SendMessageResult,
  TurnsPage,
} from '@/domain/models';
import {
  toHealth,
  toSendResult,
  toTurnsPage,
} from '@/domain/adapters';
import { ApiRequestError, request, requestStream } from './http';
import type {
  ApiHealth,
  ApiSendMessageResponse,
  ApiTurnsResponse,
} from './types';

export interface ListTurnsParams {
  limit?: number;
  offset?: number;
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
  ): Promise<SendStreamResult>;
  discardTurn(turnId: number): Promise<void>;

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
      }),
    });
    return toSendResult(res);
  }

  async sendMessageStream(
    input: SendMessageInput,
    onToken: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<SendStreamResult> {
    const res = await requestStream('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        message: input.message,
        context_turns: input.contextTurns,
        commit: input.commit,
        user_id: input.userId,
      }),
      signal,
    });
    if (!res.body) throw new ApiRequestError('No response stream', 0);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let id: number | null = null;
    let contextWindow: number | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are newline-delimited; keep the trailing partial line.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const evt = parseSseData(line);
          if (!evt) continue;
          if (evt.type === 'token' && typeof evt.content === 'string') {
            text += evt.content;
            onToken(evt.content);
          } else if (evt.type === 'done') {
            if (typeof evt.id === 'number') id = evt.id;
            if (typeof evt.context_turns_used === 'number') {
              contextWindow = evt.context_turns_used;
            }
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

    return { id, contextWindow, text };
  }

  async discardTurn(turnId: number): Promise<void> {
    await request<unknown>(`/api/messages/${turnId}`, { method: 'DELETE' });
  }
}

/** The app-wide API instance. Swap here to introduce a mock for recall work. */
export const api: CollaboratorApi = new HttpCollaboratorApi();
