import { api } from '@/api/collaborator';
import { ApiRequestError, request } from '@/api/http';
import { toQuestion } from '@/domain/adapters';

/**
 * The agent seam, the app's side (API-SPEC.md §26). Collaborator knows
 * nothing about any agent backend: it renders what each channel declares
 * (label, accepts input, firehose, status, busy, midturn input) and nothing more.
 */

/** A question passed through from whatever harness asked it. */
export interface AgentQuestion {
  id: string;
  prompt: string;
  header?: string;
  options: { id: string; label: string; description?: string }[];
  multiple: boolean;
  freeform: boolean;
  placeholder?: string;
  prefill?: string;
  /** A merge question from the PM: Merge signs exactly this body. */
  proposal?: MergeProposal;
}

export interface MergeProposal {
  approveOption: string;
  body: { project: string; from?: string; to?: string; from_sha?: string; to_sha?: string;
          [k: string]: unknown };
  summary?: string;
  commits?: number;
}

export type TeamRequestKind = 'create_project' | 'merge' | 'withdraw';
export type TeamRequestState = 'sending' | 'accepted' | 'progress' | 'waiting' | 'done'
  | 'refused' | 'failed' | 'withdrawn';
export const FINAL_REQUEST_STATES: TeamRequestState[] = ['done', 'refused', 'failed', 'withdrawn'];

/** A signed request to the team, carried by the PM endpoint (Settings → Agents). */
export interface TeamRequest {
  id: string;
  kind: TeamRequestKind;
  project: string | null;
  /** A withdrawal: the request it names. */
  target: string | null;
  state: TeamRequestState;
  step: string | null;
  text: string | null;
  messageId: number | null;
  createdAt: string;
  updatedAt: string;
  hidden: boolean;
  /** A creation: the note it started from (Collaborator's own record, never signed). */
  noteTitle: string | null;
}

/** Whether agents can be started on a project from here, or why not. */
export type TeamStart = 'ok' | 'no_endpoints' | 'no_pm' | 'no_capability' | 'no_key';

/** A project's team at a glance: GET /api/agents/projects/{tag}/team. */
export interface ProjectTeam {
  project: string;
  /** An endpoint's discovery names this project: it has agents. */
  served: boolean;
  start: TeamStart;
  /** The latest request to start agents on it, finished or not. */
  startRequest: TeamRequest | null;
  /** Open questions, merge (and test) cards first, each with its channel label. */
  questions: (AgentMessage & { label: string })[];
  lastMerge: { text: string; at: string } | null;
  /** Cost and tokens so far across roles; null when none was recorded. */
  usage: { input: number; output: number; cacheRead: number; calls: number; cost: number;
           roles: number } | null;
}

export interface SigningKey {
  keyId: string;
  publicKey: string;
  fingerprint: string;
}

export interface NewProjectForm {
  name: string;
  description: string;
  roles?: string[];
  intentsMd: string;
  kickoff?: string;
  /** The note the intents came from, so the note can show what it started. */
  noteTitle?: string;
}

export interface AgentHealth {
  state: 'ok' | 'degraded' | 'unreachable' | 'paused';
  detail?: string;
  since?: string;
  connecting?: boolean;
}

export interface ProjectHealth {
  state: 'ok' | 'degraded' | 'paused';
  detail?: string;
  /** The endpoints at fault (all of them while paused). */
  endpoints: { id: string; name: string; health: AgentHealth }[];
}

export interface AgentProject {
  tag: string;
  state: 'active' | 'idle';
  /** Open questions + flagged messages not yet seen: the badge. */
  waiting: number;
  health: ProjectHealth;
}

export interface AgentChannel {
  endpointId: string;
  endpointName: string;
  channel: string;
  label: string;
  acceptsInput: boolean;
  firehose: boolean;
  status: string;
  busy: boolean;
  /** What a message sent while busy does: delivered into the turn, or after it. */
  midturnInput: 'steers' | 'queues';
  previewUrl: string | null;
  previewText: string | null;
  unread: number;
  waiting: number;
  connected: boolean;
}

export interface AgentProjectDetail {
  tag: string;
  channels: AgentChannel[];
  /** The channel that accepts input (the user's pick when several); null = watch-only. */
  default: { endpointId: string; channel: string } | null;
  health: ProjectHealth;
}

export interface AgentMessage {
  id: number;
  endpointId: string;
  project: string;
  channel: string;
  from: 'agent' | 'you';
  text: string;
  needsReply: boolean;
  question: AgentQuestion | null;
  questionState: 'open' | 'answered' | 'closed' | null;
  outcome: { option_ids?: string[]; text?: string; reason?: string } | null;
  note: { id: string; title: string } | null;
  /** A merge question's signed request, once Merge was pressed. */
  request: TeamRequest | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface FirehoseItem {
  ts: string;
  kind: string;
  text: string;
  seq?: number;
  replay?: boolean;
  /** Event markers: what happened, and a preview link when there is one. */
  event?: string;
  url?: string;
}

export interface AgentEndpoints {
  paired: { id: string; name: string; fingerprint: string; connected: boolean;
            lastSeen: string | null; health: AgentHealth;
            /** Marked by the user as the PM: where team requests go. */
            pm: boolean;
            /** What it declared in discovery (create_project, merge). */
            capabilities: string[] }[];
  pending: { id: string; name: string; fingerprint: string; connectedAt: string | null }[];
}

export interface NoteSendState {
  title: string;
  canSend: boolean;
  target: { project: string; endpointId: string; channel: string; label: string } | null;
  /** What Collaborator's model staged; nothing goes out until the user sends. */
  staged: { id: number; project: string; comment: string | null; createdAt: string } | null;
  lastSent: { messageId: number; project: string; sentAt: string;
              deliveredAt: string | null } | null;
}

type Raw = Record<string, any>;

export function toChannel(c: Raw): AgentChannel {
  return {
    endpointId: c.endpoint_id, endpointName: c.endpoint_name ?? '', channel: c.channel,
    label: c.label, acceptsInput: !!c.accepts_input, firehose: !!c.firehose,
    status: c.status ?? '', busy: !!c.busy,
    midturnInput: c.midturn_input === 'steers' ? 'steers' : 'queues', previewUrl: c.preview_url ?? null,
    previewText: c.preview_text ?? null, unread: c.unread ?? 0, waiting: c.waiting ?? 0,
    connected: c.connected !== false,
  };
}

export function toRequest(r: Raw): TeamRequest {
  return {
    id: r.id, kind: r.kind, project: r.project ?? null, target: r.target ?? null,
    state: r.state, step: r.step ?? null, text: r.text ?? null,
    messageId: r.message_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    hidden: !!r.hidden, noteTitle: r.note_title ?? null,
  };
}

export function toTeam(t: Raw): ProjectTeam {
  const u = t.usage;
  return {
    project: t.project, served: !!t.served, start: t.start ?? 'no_endpoints',
    startRequest: t.start_request ? toRequest(t.start_request) : null,
    questions: (t.questions ?? []).map((m: Raw) => ({ ...toMessage(m), label: m.label ?? m.channel })),
    lastMerge: t.last_merge ? { text: t.last_merge.text ?? '', at: t.last_merge.at } : null,
    usage: u ? { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cache_read ?? 0,
                 calls: u.calls ?? 0, cost: u.cost ?? 0, roles: u.roles ?? 0 } : null,
  };
}

export function toMessage(m: Raw): AgentMessage {
  return {
    id: m.id, endpointId: m.endpoint_id, project: m.project, channel: m.channel,
    from: m.from === 'you' ? 'you' : 'agent', text: m.text ?? '', needsReply: !!m.needs_reply,
    question: toQuestion(m.question), questionState: m.question_state ?? null,
    outcome: m.outcome ?? null,
    note: m.note ? { id: m.note.id, title: m.note.title } : null,
    request: m.request ? toRequest(m.request) : null,
    createdAt: m.created_at, deliveredAt: m.delivered_at ?? null, readAt: m.read_at ?? null,
  };
}

function toDetail(p: Raw): AgentProjectDetail {
  return {
    tag: p.tag, channels: (p.channels ?? []).map(toChannel),
    default: p.default ? { endpointId: p.default.endpoint_id, channel: p.default.channel } : null,
    health: p.health,
  };
}

function toNoteState(s: Raw): NoteSendState {
  const t = s.target;
  return {
    title: s.title, canSend: !!s.can_send,
    target: t ? { project: t.project, endpointId: t.endpoint_id, channel: t.channel,
                  label: t.label } : null,
    staged: s.staged ? { id: s.staged.id, project: s.staged.project,
                         comment: s.staged.comment ?? null, createdAt: s.staged.created_at } : null,
    lastSent: s.last_sent ? { messageId: s.last_sent.message_id, project: s.last_sent.project,
                              sentAt: s.last_sent.sent_at,
                              deliveredAt: s.last_sent.delivered_at ?? null } : null,
  };
}

const enc = encodeURIComponent;
const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const agentsApi = {
  async projects(): Promise<AgentProject[]> {
    return (await request<{ projects: AgentProject[] }>('/api/agents/projects')).projects ?? [];
  },
  async project(tag: string): Promise<AgentProjectDetail> {
    return toDetail(await request<Raw>(`/api/agents/projects/${enc(tag)}`));
  },
  async messages(tag: string, c: { endpointId: string; channel: string },
                 before?: number): Promise<AgentMessage[]> {
    const q = new URLSearchParams({ endpoint_id: c.endpointId, channel: c.channel });
    if (before) q.set('before', String(before));
    const res = await request<{ messages: Raw[] }>(`/api/agents/projects/${enc(tag)}/messages?${q}`);
    return (res.messages ?? []).map(toMessage);
  },
  async send(tag: string, c: { endpointId: string; channel: string },
             text: string): Promise<AgentMessage> {
    const res = await request<{ message: Raw }>(`/api/agents/projects/${enc(tag)}/messages`,
      json({ text, endpoint_id: c.endpointId, channel: c.channel }));
    return toMessage(res.message);
  },
  async read(tag: string, c: { endpointId: string; channel: string }): Promise<void> {
    await request(`/api/agents/projects/${enc(tag)}/read`,
      json({ endpoint_id: c.endpointId, channel: c.channel }));
  },
  async setDefault(tag: string, c: { endpointId: string; channel: string }): Promise<void> {
    await request(`/api/agents/projects/${enc(tag)}/default`, {
      method: 'PUT', body: JSON.stringify({ endpoint_id: c.endpointId, channel: c.channel }) });
  },
  async firehose(tag: string, c: { endpointId: string; channel: string }): Promise<FirehoseItem[]> {
    const q = new URLSearchParams({ endpoint_id: c.endpointId, channel: c.channel });
    return (await request<{ items: FirehoseItem[] }>(
      `/api/agents/projects/${enc(tag)}/firehose?${q}`)).items ?? [];
  },
  /** Ask the backend to replay a channel's firehose from a sequence number. */
  async history(tag: string, c: { endpointId: string; channel: string },
                fromSeq = 0): Promise<boolean> {
    const res = await request<{ requested: boolean }>(`/api/agents/projects/${enc(tag)}/history`,
      json({ endpoint_id: c.endpointId, channel: c.channel, from_seq: fromSeq }));
    return !!res.requested;
  },
  async answer(messageId: number, optionIds: string[], text: string): Promise<AgentMessage> {
    const res = await request<{ question: Raw }>(`/api/agents/questions/${messageId}/answer`,
      json({ option_ids: optionIds, text }));
    return toMessage(res.question);
  },
  async endpoints(): Promise<AgentEndpoints> {
    const r = await request<Raw>('/api/agents/endpoints');
    return {
      paired: (r.paired ?? []).map((e: Raw) => ({
        id: e.id, name: e.name, fingerprint: e.fingerprint, connected: !!e.connected,
        lastSeen: e.last_seen ?? null, health: e.health, pm: !!e.pm,
        capabilities: e.capabilities ?? [] })),
      pending: (r.pending ?? []).map((e: Raw) => ({
        id: e.id, name: e.name, fingerprint: e.fingerprint, connectedAt: e.connected_at ?? null })),
    };
  },
  async setPm(id: string | null): Promise<void> {
    await request('/api/agents/pm', { method: 'PUT', body: JSON.stringify({ endpoint_id: id }) });
  },
  /** The request signing key's public half, or null before one exists. */
  async signingKey(): Promise<SigningKey | null> {
    try {
      const k = await request<Raw>('/api/agents/signing-key');
      return { keyId: k.key_id, publicKey: k.public_key, fingerprint: k.fingerprint };
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) return null;
      throw err;
    }
  },
  async createSigningKey(replace = false): Promise<SigningKey> {
    const k = await request<Raw>('/api/agents/signing-key', json({ replace }));
    return { keyId: k.key_id, publicKey: k.public_key, fingerprint: k.fingerprint };
  },
  async requests(): Promise<TeamRequest[]> {
    return ((await request<{ requests: Raw[] }>('/api/agents/requests')).requests ?? [])
      .map(toRequest);
  },
  async createProject(f: NewProjectForm): Promise<TeamRequest> {
    const res = await request<{ request: Raw }>('/api/agents/requests', json({
      kind: 'create_project', name: f.name, description: f.description,
      roles: f.roles?.length ? f.roles : undefined, intents_md: f.intentsMd,
      kickoff: f.kickoff?.trim() ? f.kickoff : undefined,
      note_title: f.noteTitle || undefined }));
    return toRequest(res.request);
  },
  async team(tag: string): Promise<ProjectTeam> {
    return toTeam(await request<Raw>(`/api/agents/projects/${enc(tag)}/team`));
  },
  async withdraw(target: string): Promise<TeamRequest> {
    return toRequest((await request<{ request: Raw }>('/api/agents/requests',
      json({ kind: 'withdraw', target }))).request);
  },
  async hideRequest(id: string): Promise<TeamRequest> {
    return toRequest((await request<{ request: Raw }>(
      `/api/agents/requests/${enc(id)}/hide`, { method: 'POST' })).request);
  },
  async approve(id: string): Promise<void> {
    await request(`/api/agents/endpoints/${enc(id)}/approve`, { method: 'POST' });
  },
  async remove(id: string): Promise<void> {
    await request(`/api/agents/endpoints/${enc(id)}`, { method: 'DELETE' });
  },
  async noteState(title: string): Promise<NoteSendState> {
    return toNoteState(await request<Raw>(`/api/agents/notes/${enc(title)}`));
  },
  async sendNote(title: string, comment?: string): Promise<NoteSendState> {
    return toNoteState(await request<Raw>(`/api/agents/notes/${enc(title)}/send`,
      json(comment === undefined ? {} : { comment })));
  },
  async discardStaged(title: string): Promise<NoteSendState> {
    return toNoteState(await request<Raw>(`/api/agents/notes/${enc(title)}/staged`,
      { method: 'DELETE' }));
  },
};

/** One live update from WS /api/agents/live (raw; see API-SPEC.md §26). */
export type AgentLiveEvent = Raw & { type: string };

/**
 * The live socket: messages, channel changes, firehose lines, events,
 * health. Reconnects with backoff; `onReconnect` tells the caller to reload
 * what it shows from HTTP (anything said while away is stored there).
 */
export function connectAgentsLive(onEvent: (e: AgentLiveEvent) => void,
                                  onReconnect: () => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = async () => {
    let ticket: string;
    try {
      ticket = await api.getWsTicket();
    } catch {
      schedule();
      return;
    }
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = import.meta.env.VITE_API_BASE_URL
      ? String(import.meta.env.VITE_API_BASE_URL).replace(/^http/, 'ws')
      : `${proto}://${location.host}`;
    ws = new WebSocket(`${base}/api/agents/live?ticket=${enc(ticket)}`);
    ws.onopen = () => {
      if (attempt > 0) onReconnect();
      attempt = 0;
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        onEvent(JSON.parse(e.data) as AgentLiveEvent);
      } catch {
        // a malformed frame is dropped; the stored record stands
      }
    };
    ws.onclose = () => {
      ws = null;
      schedule();
    };
  };
  const schedule = () => {
    if (closed) return;
    attempt += 1;
    timer = setTimeout(() => void open(), Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
  };
  void open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

/** Only http(s) links become tappable (they open in the system browser). */
export function isWebUrl(url: string | null | undefined): url is string {
  return !!url && /^https?:\/\/\S+$/i.test(url.trim());
}
