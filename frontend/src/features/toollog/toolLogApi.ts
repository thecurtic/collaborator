import { request } from '@/api/http';

/** What a tool can do; money, outbound, writes and other form the risk scope. */
export type ToolCategory = 'money' | 'outbound' | 'writes' | 'reads' | 'compute' | 'other';
export type ToolOutcome = 'ok' | 'empty' | 'error' | 'unknown';
export type ToolSource = 'chat' | 'call' | 'scratch';
export type ToolSort = 'time' | 'tool' | 'category' | 'duration' | 'outcome' | 'uses';

/** One logged call (GET /api/tool-calls). */
export interface ToolCall {
  id: number;
  ts: string;
  source: ToolSource;
  rootId: number | null;
  turnId: number | null;
  round: number | null;
  tool: string;
  category: ToolCategory;
  outcome: ToolOutcome;
  error: string | null;
  resultChars: number | null;
  durationMs: number | null;
  model: string | null;
  args: Record<string, unknown>;
  /** The readable sentence ("Searching notes for “garden”"). */
  label: string;
  risk: boolean;
  /** The model wrote the call as text and it had to be recovered. */
  recovered: boolean;
  /** From the per-reply Sources that predate the log (no timing, no preview). */
  backfilled: boolean;
  /** The start of the message that set the call off. */
  trigger: string | null;
  /** How often this tool appears in the filtered set. */
  uses?: number;
}

export interface ToolCallDetail extends ToolCall {
  resultPreview: string | null;
  turnExists: boolean;
  siblings: { id: number; tool: string; outcome: ToolOutcome }[];
}

export interface ToolStat {
  tool: string;
  category: ToolCategory;
  risk: boolean;
  count: number;
  errors: number;
  empty: number;
  recovered: number;
  firstUsed: string;
  lastUsed: string;
  avgMs: number | null;
  p95Ms: number | null;
  avgResultChars: number;
  errorRate: number;
}

export interface ToolStats {
  tools: ToolStat[];
  totals: {
    calls: number;
    errors: number;
    empty: number;
    risk: number;
    recovered: number;
    byCategory: Record<string, number>;
    bySource: Record<string, number>;
    byModel: Record<string, number>;
  };
  daily: { day: string; count: number }[];
}

export interface ToolFilters {
  tool?: string | null;
  category?: ToolCategory | null;
  risk?: boolean;
  outcome?: ToolOutcome | null;
  source?: ToolSource | null;
  since?: string | null;
  q?: string | null;
}

interface ApiCall {
  id: number;
  ts: string;
  source: ToolSource;
  root_id: number | null;
  turn_id: number | null;
  round: number | null;
  tool: string;
  category: ToolCategory;
  outcome: ToolOutcome;
  error: string | null;
  result_chars: number | null;
  duration_ms: number | null;
  model: string | null;
  args: Record<string, unknown>;
  label: string;
  risk: boolean;
  recovered: boolean;
  backfilled: boolean;
  trigger: string | null;
  uses?: number;
  result_preview?: string | null;
  turn_exists?: boolean;
  siblings?: { id: number; tool: string; outcome: ToolOutcome }[];
}

interface ApiStat {
  tool: string;
  category: ToolCategory;
  risk: boolean;
  count: number;
  errors: number;
  empty: number;
  recovered: number;
  first_used: string;
  last_used: string;
  avg_ms: number | null;
  p95_ms: number | null;
  avg_result_chars: number;
  error_rate: number;
}

function toCall(c: ApiCall): ToolCall {
  return {
    id: c.id,
    ts: c.ts,
    source: c.source,
    rootId: c.root_id,
    turnId: c.turn_id,
    round: c.round,
    tool: c.tool,
    category: c.category,
    outcome: c.outcome,
    error: c.error,
    resultChars: c.result_chars,
    durationMs: c.duration_ms,
    model: c.model,
    args: c.args ?? {},
    label: c.label,
    risk: c.risk,
    recovered: c.recovered,
    backfilled: c.backfilled,
    trigger: c.trigger,
    uses: c.uses,
  };
}

function query(filters: ToolFilters, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  if (filters.tool) p.set('tool', filters.tool);
  if (filters.category) p.set('category', filters.category);
  if (filters.risk) p.set('risk', 'true');
  if (filters.outcome) p.set('outcome', filters.outcome);
  if (filters.source) p.set('source', filters.source);
  if (filters.since) p.set('since', filters.since);
  if (filters.q?.trim()) p.set('q', filters.q.trim());
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const toolLogApi = {
  async list(
    filters: ToolFilters,
    sort: ToolSort,
    order: 'asc' | 'desc',
    offset = 0,
    limit = 100,
  ): Promise<{ calls: ToolCall[]; total: number }> {
    const r = await request<{ calls: ApiCall[]; total: number }>(
      `/api/tool-calls${query(filters, { sort, order, offset, limit })}`,
    );
    return { calls: r.calls.map(toCall), total: r.total };
  },

  async stats(filters: ToolFilters): Promise<ToolStats> {
    const r = await request<{
      tools: ApiStat[];
      totals: {
        calls: number;
        errors: number;
        empty: number;
        risk: number;
        recovered: number;
        by_category: Record<string, number>;
        by_source: Record<string, number>;
        by_model: Record<string, number>;
      };
      daily: { day: string; count: number }[];
    }>(`/api/tool-calls/stats${query(filters)}`);
    return {
      tools: r.tools.map((t) => ({
        tool: t.tool,
        category: t.category,
        risk: t.risk,
        count: t.count,
        errors: t.errors,
        empty: t.empty,
        recovered: t.recovered,
        firstUsed: t.first_used,
        lastUsed: t.last_used,
        avgMs: t.avg_ms,
        p95Ms: t.p95_ms,
        avgResultChars: t.avg_result_chars,
        errorRate: t.error_rate,
      })),
      totals: {
        calls: r.totals.calls,
        errors: r.totals.errors,
        empty: r.totals.empty,
        risk: r.totals.risk,
        recovered: r.totals.recovered,
        byCategory: r.totals.by_category,
        bySource: r.totals.by_source,
        byModel: r.totals.by_model,
      },
      daily: r.daily,
    };
  },

  async get(id: number): Promise<ToolCallDetail> {
    const c = await request<ApiCall>(`/api/tool-calls/${id}`);
    return {
      ...toCall(c),
      resultPreview: c.result_preview ?? null,
      turnExists: Boolean(c.turn_exists),
      siblings: c.siblings ?? [],
    };
  },
};
