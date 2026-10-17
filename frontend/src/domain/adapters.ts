import type {
  ApiAttachment,
  ApiChatCard,
  ApiFeed,
  ApiFeedItem,
  ApiHealth,
  ApiNotificationSettings,
  ApiModelsResponse,
  ApiNoteFields,
  ApiRepeatRule,
  ApiScratchItem,
  ApiSession,
  ApiNoteDraft,
  ApiNoteMeta,
  ApiNoteResponse,
  ApiPromptEntry,
  ApiRecall,
  ApiTranscript,
  ApiTree,
  ApiTreeNode,
  ApiTurn,
  ApiTurnAttachment,
  ApiTtsVoices,
  ApiTurnTool,
  ApiTurnsResponse,
} from '@/api/types';
import type {
  Attachment,
  AttachmentKind,
  ChatCard,
  Feed,
  FeedItem,
  ConversationTree,
  DeviceSession,
  HealthStatus,
  ModelsInfo,
  Note,
  NoteDraft,
  NoteFields,
  NoteMeta,
  RepeatRule,
  NotificationSettings,
  PromptInfo,
  RecallBlock,
  ScratchItem,
  ToolActivity,
  Transcript,
  TreeNode,
  TtsVoices,
  Turn,
  TurnAttachment,
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

const ATTACHMENT_KINDS: AttachmentKind[] = [
  'image', 'pdf', 'document', 'text', 'audio', 'video', 'file',
];

export function toTurnAttachment(api: ApiTurnAttachment): TurnAttachment {
  return {
    id: api.id,
    filename: api.filename,
    mime: api.mime ?? null,
    kind: ATTACHMENT_KINDS.includes(api.kind as AttachmentKind)
      ? (api.kind as AttachmentKind)
      : 'file',
    size: api.size ?? 0,
  };
}

const TEXT_STATUSES = ['pending', 'working', 'done', 'failed', 'none'] as const;

export function toAttachment(api: ApiAttachment): Attachment {
  return {
    ...toTurnAttachment(api),
    createdAt: api.created_at,
    textStatus: (TEXT_STATUSES as readonly string[]).includes(api.text_status)
      ? (api.text_status as Attachment['textStatus'])
      : 'none',
    textError: api.text_error ?? null,
    textVia: api.text_via ?? null,
    pages: api.pages ?? null,
    chars: api.chars ?? 0,
    firstTurnId: api.first_turn_id ?? null,
    text: api.text,
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
    name: typeof api.name === 'string' ? api.name : null,
    title: typeof api.title === 'string' && api.title ? api.title : null,
    chatTags: Array.isArray(api.chat_tags)
      ? api.chat_tags.filter((t): t is string => typeof t === 'string')
      : [],
    // Unknown/absent state → treat as an established conversation.
    state: api.state === 'seed' ? 'seed' : 'tree',
    recall: api.recall ? toRecallBlock(api.recall) : null,
    tools: toTurnTools(api.tools),
    attachments: (api.attachments ?? []).map(toTurnAttachment),
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
  // Boolean() (not === true): tolerate 0/1 serialization like `committed`.
  return {
    status: api.status,
    version: api.version,
    capabilities: {
      sttStream: Boolean(api.capabilities?.stt_stream),
      ttsStream: Boolean(api.capabilities?.tts_stream),
      phrases: Boolean(api.capabilities?.phrases),
    },
  };
}

export function toDeviceSession(api: ApiSession): DeviceSession {
  return {
    id: api.id,
    label: api.label || 'Unnamed device',
    createdAt: api.created_at,
    lastSeen: api.last_seen,
    expiresAt: api.expires_at,
    current: Boolean(api.current),
  };
}

export function toModelsInfo(api: ApiModelsResponse): ModelsInfo {
  const loaded = (api.loaded ?? []).filter((m) => typeof m === 'string');
  return {
    current: api.current,
    available: api.available ?? [],
    models: (api.models ?? []).map((m) => ({
      id: m.id,
      type: typeof m.type === 'string' ? m.type : null,
      loaded: m.state === 'loaded',
      quantization:
        typeof m.quantization === 'string' ? m.quantization : null,
      maxContextLength:
        typeof m.max_context_length === 'number' ? m.max_context_length : null,
      loadedContextLength:
        typeof m.loaded_context_length === 'number'
          ? m.loaded_context_length
          : null,
    })),
    loaded,
    // Absent ≠ false: non-LM-Studio endpoints report nothing — no claims.
    currentLoaded:
      typeof api.current_loaded === 'boolean' ? api.current_loaded : null,
  };
}

const SCRATCH_KINDS = new Set(['text', 'url', 'image', 'audio', 'video', 'file']);
const SCRATCH_STATUSES = new Set([
  'inert',
  'pending',
  'committed',
  'done',
  'refused',
]);

export function toScratchItem(api: ApiScratchItem): ScratchItem {
  return {
    id: api.id,
    createdAt: api.created_at,
    kind: SCRATCH_KINDS.has(api.kind)
      ? (api.kind as ScratchItem['kind'])
      : 'text',
    content: typeof api.content === 'string' ? api.content : '',
    mediaMime: api.media_mime ?? null,
    mediaHash: api.media_hash ?? null,
    transcript: api.transcript ?? null,
    status:
      api.status && SCRATCH_STATUSES.has(api.status)
        ? (api.status as ScratchItem['status'])
        : 'inert',
    llmReadable: Boolean(api.llm_readable),
    actionResult: api.action_result?.kind
      ? {
          kind: api.action_result.kind,
          note: api.action_result.note ?? null,
          draftTitle: api.action_result.draft_title ?? null,
        }
      : null,
    draftId: api.draft_id ?? null,
    transcriptId: api.transcript_id ?? null,
    pinned: Boolean(api.pinned),
    transcriptJob: api.transcript_status
      ? {
          status: api.transcript_status,
          title: api.transcript_title ?? null,
          channel: api.transcript_channel ?? null,
        }
      : null,
  };
}

export function toTranscript(api: ApiTranscript): Transcript {
  return {
    id: api.id,
    url: typeof api.url === 'string' ? api.url : '',
    title: api.title ?? null,
    channel: typeof api.channel === 'string' && api.channel ? api.channel : null,
    durationS: typeof api.duration_s === 'number' ? api.duration_s : null,
    status:
      api.status === 'done' || api.status === 'error'
        ? api.status
        : 'processing',
    error: typeof api.error === 'string' && api.error ? api.error : null,
    chars: typeof api.chars === 'number' ? api.chars : null,
    snippet: typeof api.snippet === 'string' && api.snippet ? api.snippet : null,
    tags: Array.isArray(api.tags) ? api.tags.filter((t) => typeof t === 'string') : [],
    createdAt: api.created_at,
    finishedAt: api.finished_at ?? null,
    text: typeof api.text === 'string' ? api.text : null,
  };
}

export function toTtsVoices(api: ApiTtsVoices): TtsVoices {
  return {
    voices: api.voices ?? [],
    defaultVoice: api.default || null,
    enabled: Boolean(api.enabled),
  };
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
    // Shared mapper: empty/contentless fields dicts (every draft carries the
    // column) collapse to null so plain drafts don't grow typed editors.
    fields: toNoteFields(api.fields),
  };
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Typed frontmatter (1f18a9b) — one flat superset, defensively mapped.
 * Returns null when nothing meaningful is set (the backend serializes an
 * empty fields dict on plain notes; that must not read as "has fields").
 */
export function toNoteFields(
  api: ApiNoteFields | null | undefined,
): NoteFields | null {
  if (!api) return null;
  const f: NoteFields = {
    start: str(api.start),
    end: str(api.end),
    allDay: Boolean(api.all_day),
    location: str(api.location),
    people: strList(api.people),
    repeat: toRepeatRule(api.repeat),
    exceptions: Array.isArray(api.exceptions)
      ? api.exceptions.filter((e) => e && typeof e.date === 'string')
      : [],
    aliases: strList(api.aliases),
    kind: str(api.kind),
    relation: str(api.relation),
    birthday: str(api.birthday),
    area: str(api.area),
    name: str(api.name),
    dob: str(api.dob),
    residesIn: str(api.resides_in),
    timezone: str(api.timezone),
  };
  const meaningful =
    f.start != null ||
    f.location != null ||
    f.people.length > 0 ||
    f.repeat != null ||
    f.aliases.length > 0 ||
    f.kind != null ||
    f.relation != null ||
    f.birthday != null ||
    f.area != null ||
    f.name != null ||
    f.dob != null ||
    f.residesIn != null ||
    f.timezone != null;
  return meaningful ? f : null;
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
    occurrence: typeof api.occurrence === 'string' ? api.occurrence : null,
    recurring: api.recurring === true,
    moved: api.moved === true,
    // Event times arrive as top-level event_* columns, NOT inside the
    // backend's fields dict (INDEXED_FIELD_KEYS excludes them) — merge them
    // so NoteFields.start is the one truth the UI reads. Without this the
    // calendar saw every event as start-less and dropped it.
    fields: toNoteFields({
      ...(api.fields ?? {}),
      start: api.fields?.start ?? api.event_start,
      end: api.fields?.end ?? api.event_end,
      all_day: api.fields?.all_day ?? api.event_all_day,
    }),
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

export function toChatCard(api: ApiChatCard): ChatCard {
  const s = api.summary;
  return {
    rootId: api.root_id,
    tags: api.tags ?? [],
    summary: s
      ? {
          text: s.text,
          proposedTags: s.proposed_tags ?? [],
          generatedAt: s.generated_at ?? null,
          stale: s.stale === true,
        }
      : null,
  };
}

export function toNotificationSettings(
  api: ApiNotificationSettings,
): NotificationSettings {
  return {
    kinds: (api.kinds ?? []).map((k) => ({
      kind: k.kind,
      label: k.label,
      description: k.description,
      enabled: k.enabled === true,
    })),
    ntfyConfigured: api.delivery?.ntfy === true,
  };
}

const FEED_TYPES = new Set([
  'chat', 'note', 'event', 'approval', 'transcript', 'merged',
]);

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export function toFeedItem(api: ApiFeedItem): FeedItem {
  const r = api.ref ?? {};
  return {
    key: api.key,
    type: (FEED_TYPES.has(api.type) ? api.type : 'note') as FeedItem['type'],
    title: api.title,
    subtitle: api.subtitle ?? null,
    warmth: api.warmth ?? null,
    tags: api.tags ?? [],
    pinned: api.pinned === true,
    ref: {
      rootId: num(r.root_id),
      leafId: num(r.leaf_id),
      title: typeof r.title === 'string' ? r.title : undefined,
      start: typeof r.start === 'string' ? r.start : undefined,
      draftId: num(r.draft_id),
      runId: typeof r.run_id === 'string' ? r.run_id : null,
      transcriptId: num(r.transcript_id),
      project: typeof r.project === 'string' ? r.project : null,
    },
  };
}

export function toFeed(api: ApiFeed): Feed {
  return {
    pinned: (api.pinned ?? []).map(toFeedItem),
    items: (api.items ?? []).map(toFeedItem),
  };
}

export function toRepeatRule(api: ApiRepeatRule | null | undefined): RepeatRule | null {
  if (!api || typeof api !== 'object' || !api.freq) return null;
  return {
    freq: api.freq,
    ...(typeof api.interval === 'number' ? { interval: api.interval } : {}),
    ...(Array.isArray(api.by_day) ? { byDay: api.by_day } : {}),
    ...(typeof api.by_month_day === 'number' ? { byMonthDay: api.by_month_day } : {}),
    ...(typeof api.until === 'string' ? { until: api.until } : {}),
    ...(typeof api.count === 'number' ? { count: api.count } : {}),
  };
}

/** RepeatRule -> the wire shape PATCH fields / POST /api/events take. */
export function fromRepeatRule(rule: RepeatRule): ApiRepeatRule {
  return {
    freq: rule.freq,
    ...(rule.interval && rule.interval !== 1 ? { interval: rule.interval } : {}),
    ...(rule.byDay?.length ? { by_day: rule.byDay } : {}),
    ...(rule.byMonthDay ? { by_month_day: rule.byMonthDay } : {}),
    ...(rule.until ? { until: rule.until } : {}),
    ...(rule.count ? { count: rule.count } : {}),
  };
}
