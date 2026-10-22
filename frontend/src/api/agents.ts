import { api } from '@/api/collaborator';
import { request } from '@/api/http';

/**
 * The agent seam, the app's side (API-SPEC.md §26). Collaborator knows
 * nothing about any agent backend: it renders what each channel declares
 * (label, accepts input, firehose, status, busy) and nothing more.
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
            lastSeen: string | null; health: AgentHealth }[];
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
    status: c.status ?? '', busy: !!c.busy, previewUrl: c.preview_url ?? null,
    previewText: c.preview_text ?? null, unread: c.unread ?? 0, waiting: c.waiting ?? 0,
    connected: c.connected !== false,
  };
}

export function toMessage(m: Raw): AgentMessage {
  return {
    id: m.id, endpointId: m.endpoint_id, project: m.project, channel: m.channel,
    from: m.from === 'you' ? 'you' : 'agent', text: m.text ?? '', needsReply: !!m.needs_reply,
    question: m.question ?? null, questionState: m.question_state ?? null,
    outcome: m.outcome ?? null,
    note: m.note ? { id: m.note.id, title: m.note.title } : null,
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
        lastSeen: e.last_seen ?? null, health: e.health })),
      pending: (r.pending ?? []).map((e: Raw) => ({
        id: e.id, name: e.name, fingerprint: e.fingerprint, connectedAt: e.connected_at ?? null })),
    };
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
