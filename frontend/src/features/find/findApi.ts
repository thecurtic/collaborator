import { request } from '@/api/http';

/** The piles unified search reaches (GET /api/find). */
export type FindScope = 'chats' | 'notes' | 'scratch' | 'transcripts' | 'attachments';

export interface FindHit {
  type: 'chat' | 'note' | 'scratch' | 'transcript' | 'attachment';
  /** chat: root id · note: title · scratch/transcript/attachment: id. */
  id: number | string;
  title: string;
  snippet: string;
  when?: string | null;
  tags?: string[];
  /** chat: the best-matching turn, and how many turns matched. */
  turn_id?: number;
  matches?: number;
  kind?: string;
  mime?: string | null;
  size?: number | null;
  channel?: string | null;
}

export interface FindGroup {
  scope: FindScope;
  total: number;
  items: FindHit[];
}

export async function find(
  q: string,
  opts: { scope?: FindScope; limit?: number; signal?: AbortSignal } = {},
): Promise<FindGroup[]> {
  const params = new URLSearchParams({ q });
  if (opts.scope) params.set('scope', opts.scope);
  if (opts.limit) params.set('limit', String(opts.limit));
  const res = await request<{ groups: FindGroup[] }>(`/api/find?${params}`, {
    signal: opts.signal,
  });
  return res.groups ?? [];
}
