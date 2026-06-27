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
import { request } from './http';
import type {
  ApiHealth,
  ApiSendMessageResponse,
  ApiTurnsResponse,
} from './types';

export interface ListTurnsParams {
  limit?: number;
  offset?: number;
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

  async discardTurn(turnId: number): Promise<void> {
    await request<unknown>(`/api/messages/${turnId}`, { method: 'DELETE' });
  }
}

/** The app-wide API instance. Swap here to introduce a mock for recall work. */
export const api: CollaboratorApi = new HttpCollaboratorApi();
