import type {
  ApiHealth,
  ApiSendMessageResponse,
  ApiTurn,
  ApiTurnsResponse,
} from '@/api/types';
import type {
  HealthStatus,
  SendMessageResult,
  Turn,
  TurnsPage,
} from './models';

/** Normalize the API's `tags: string | null` into a clean string[]. */
function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function toTurn(api: ApiTurn): Turn {
  return {
    id: api.id,
    userId: api.user_id,
    role: api.role,
    message: api.message,
    response: api.response,
    committed: api.committed,
    contextTurns: api.context_turns,
    createdAt: api.created_at,
    modelName: api.model_name,
    tokenCount: api.token_count,
    tags: parseTags(api.tags),
  };
}

export function toTurnsPage(api: ApiTurnsResponse): TurnsPage {
  return {
    turns: api.turns.map(toTurn),
    count: api.count,
  };
}

export function toHealth(api: ApiHealth): HealthStatus {
  return { status: api.status, version: api.version };
}

export function toSendResult(api: ApiSendMessageResponse): SendMessageResult {
  return {
    id: api.id,
    userId: api.user_id,
    message: api.message,
    response: api.response,
    committed: api.committed,
  };
}
