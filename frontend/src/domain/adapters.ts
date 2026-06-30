import type {
  ApiHealth,
  ApiRecall,
  ApiSendMessageResponse,
  ApiTree,
  ApiTreeNode,
  ApiTurn,
  ApiTurnsResponse,
} from '@/api/types';
import type {
  ConversationTree,
  HealthStatus,
  RecallBlock,
  SendMessageResult,
  TreeNode,
  Turn,
  TurnsPage,
} from './models';

/** Map a tree node's stored recall (or the recall SSE event) to a RecallBlock. */
export function toRecallBlock(api: ApiRecall): RecallBlock {
  return {
    content: typeof api.content === 'string' ? api.content : '',
    sources: (api.sources ?? []).map((s) => ({
      turnId: s.turn_id,
      role: s.role ?? '',
      tags: s.tags ?? [],
      branchRootId: s.branch_root_id ?? null,
      similarity: s.similarity ?? 0,
      score: s.score ?? 0,
      preview: s.preview ?? '',
    })),
  };
}

/** Normalize the API's `tags: string | null` into a clean string[]. */
function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function toTurn(api: ApiTurn): Turn {
  // The as-built backend sends one `content` column; API-SPEC instead splits
  // into message/response. Normalize both into our role-keyed message/response.
  const body =
    api.content ??
    (api.role === 'user' ? api.message : api.response) ??
    '';
  return {
    id: api.id,
    userId: api.user_id,
    role: api.role,
    message: api.role === 'user' ? body : (api.message ?? ''),
    response: api.role === 'assistant' ? body : (api.response ?? ''),
    committed: Boolean(api.committed),
    contextTurns: api.context_turns,
    createdAt: api.created_at,
    modelName: api.model_name,
    tokenCount: api.token_count,
    tags: parseTags(api.tags),
    parentTurnId: api.parent_turn_id ?? null,
    paragraphIndex: api.paragraph_index ?? null,
    paragraphs: api.paragraphs ?? [],
  };
}

export function toTreeNode(api: ApiTreeNode): TreeNode {
  return {
    id: api.id,
    role: api.role,
    content: api.content,
    preview: api.preview,
    paragraphs: api.paragraphs ?? [],
    parentTurnId: api.parent_turn_id ?? null,
    paragraphIndex: api.paragraph_index ?? null,
    contextBoundary: api.context_boundary === true,
    branched: api.branched === true,
    recall: api.recall ? toRecallBlock(api.recall) : null,
    children: (api.children ?? []).map(toTreeNode),
  };
}

export function toTree(api: ApiTree): ConversationTree {
  return {
    roots: (api.roots ?? []).map(toTreeNode),
    count: api.count,
    contextWindow:
      typeof api.context_turns === 'number' ? api.context_turns : null,
  };
}

export function toTurnsPage(api: ApiTurnsResponse): TurnsPage {
  return {
    turns: api.turns.map(toTurn),
    count: api.count,
    contextWindow:
      typeof api.context_turns_used === 'number'
        ? api.context_turns_used
        : null,
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
    contextTurnsUsed: api.context_turns_used?.map(toTurn),
    systemPrompt: api.system_prompt,
    agentsMd: api.agents_md_content,
  };
}
