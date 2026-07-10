import type {
  ApiHealth,
  ApiNoteDraft,
  ApiNoteMeta,
  ApiNoteResponse,
  ApiPromptEntry,
  ApiRecall,
  ApiTree,
  ApiTreeNode,
  ApiTurn,
  ApiTurnTool,
  ApiTurnsResponse,
} from '@/api/types';
import type {
  ConversationTree,
  HealthStatus,
  Note,
  NoteDraft,
  NoteMeta,
  PromptInfo,
  RecallBlock,
  ToolActivity,
  TreeNode,
  Turn,
  TurnsPage,
} from './models';

/**
 * Map a tree node's stored recall (or the recall SSE event) to a RecallBlock.
 * Defensive per-field checks: SSE payloads arrive unvalidated.
 */
export function toRecallBlock(api: ApiRecall): RecallBlock {
  const raw = Array.isArray(api.sources) ? api.sources : [];
  return {
    content: typeof api.content === 'string' ? api.content : '',
    sources: raw.map((s) => ({
      turnId: typeof s.turn_id === 'number' ? s.turn_id : 0,
      role: typeof s.role === 'string' ? s.role : '',
      tags: Array.isArray(s.tags) ? s.tags : [],
      branchRootId:
        typeof s.branch_root_id === 'number' ? s.branch_root_id : null,
      similarity: typeof s.similarity === 'number' ? s.similarity : 0,
      score: typeof s.score === 'number' ? s.score : 0,
      preview: typeof s.preview === 'string' ? s.preview : '',
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

/** Persisted tool records → the same ToolActivity shape the live feed uses. */
export function toTurnTools(api: ApiTurnTool[] | undefined): ToolActivity[] {
  return (api ?? []).map((t, i) => ({
    id: i,
    tool: t.tool ?? '',
    text: t.query ?? t.url ?? t.title ?? t.tool ?? '',
    outcome:
      t.outcome === 'ok' || t.outcome === 'empty' || t.outcome === 'error'
        ? t.outcome
        : // Tools that don't report outcomes (recall/notes reads).
          'none',
    detail:
      t.error ??
      (typeof t.count === 'number'
        ? `${t.count} ${t.count === 1 ? 'result' : 'results'}`
        : null),
    urls: Array.isArray(t.urls)
      ? t.urls.filter((u): u is string => typeof u === 'string')
      : undefined,
  }));
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
    name: typeof api.name === 'string' ? api.name : null,
    title: typeof api.title === 'string' && api.title ? api.title : null,
    // Unknown/absent state → treat as an established conversation.
    state: api.state === 'seed' ? 'seed' : 'tree',
    recall: api.recall ? toRecallBlock(api.recall) : null,
    tools: toTurnTools(api.tools),
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

export function toNoteDraft(api: ApiNoteDraft): NoteDraft {
  return {
    id: api.id,
    runId: api.run_id,
    treeRootId: api.tree_root_id ?? null,
    kind: api.kind === 'edit' ? 'edit' : 'new',
    targetTitle: api.target_title ?? null,
    reason: api.reason ?? null,
    title: api.title,
    body: api.body,
    tags: api.tags ?? [],
    links: api.links ?? [],
    sourceTurns: api.source_turns ?? [],
    status: api.status,
    createdAt: api.created_at,
    decidedAt: api.decided_at ?? null,
    duplicateOf: (api.duplicate_of ?? []).map((d) => ({
      title: d.title,
      score: d.score,
    })),
  };
}

export function toNoteMeta(api: ApiNoteMeta): NoteMeta {
  return {
    filename: api.filename,
    title: api.title,
    created: api.created ?? null,
    tags: api.tags ?? [],
    sourceTurns: api.source_turns ?? [],
    links: api.links ?? [],
    score: typeof api.score === 'number' ? api.score : null,
  };
}

export function toPromptInfo(api: ApiPromptEntry): PromptInfo {
  return {
    name: api.name,
    description: api.description ?? '',
    applies: api.applies ?? '',
    source:
      api.source === 'file' || api.source === 'config' ? api.source : 'default',
    file: api.file ?? null,
    content: api.content ?? '',
    note: api.note ?? null,
  };
}

export function toNote(api: ApiNoteResponse['note']): Note {
  return {
    ...toNoteMeta(api),
    body: api.body,
    // Backlinks may arrive as bare titles or note objects — normalize to titles.
    backlinks: (api.backlinks ?? [])
      .map((b) => (typeof b === 'string' ? b : b.title))
      .filter(Boolean),
  };
}
