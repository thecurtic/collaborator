import {
  ArrowUpDown,
  BookOpen,
  Calculator,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Coins,
  Globe,
  Loader2,
  MessageSquare,
  PenLine,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ActionSheet } from '@/components/ActionSheet';
import { ActiveFilter, ListFilterButton } from '@/components/ListFilter';
import { Button } from '@/components/ui/button';
import { useModalA11y } from '@/lib/useModalA11y';
import { cn } from '@/lib/utils';
import { PageBar } from '@/components/PageBar';
import { useBack } from '@/lib/back';
import {
  toolLogApi,
  type ToolCall,
  type ToolCallDetail,
  type ToolCategory,
  type ToolFilters,
  type ToolOutcome,
  type ToolSort,
  type ToolSource,
  type ToolStat,
  type ToolStats,
} from './toolLogApi';
import {
  argLines,
  CATEGORY_LABEL,
  dayLabel,
  fmtChars,
  fmtDateTime,
  fmtMs,
  fmtTime,
  groupByDay,
  prettyPreview,
  sinceFor,
  type TimeRange,
} from './toolLogFormat';

const PAGE = 100;

const CATEGORY_ICON: Record<ToolCategory, ComponentType<{ className?: string }>> = {
  money: Coins,
  outbound: Globe,
  writes: PenLine,
  reads: BookOpen,
  compute: Calculator,
  other: CircleHelp,
};

const CATEGORY_TONE: Record<ToolCategory, string> = {
  money: 'text-amber-600',
  outbound: 'text-sky-600',
  writes: 'text-violet-600',
  reads: 'text-muted-foreground',
  compute: 'text-muted-foreground/70',
  other: 'text-destructive',
};

const SOURCE_LABEL: Record<ToolSource, string> = {
  chat: 'Chat',
  call: 'Voice call',
  scratch: 'Scratch action',
};

const RANGES: { key: TimeRange; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All' },
];

const CALL_SORTS: { sort: ToolSort; order: 'asc' | 'desc'; label: string }[] = [
  { sort: 'time', order: 'desc', label: 'Newest first' },
  { sort: 'time', order: 'asc', label: 'Oldest first' },
  { sort: 'uses', order: 'desc', label: 'Most-used tools first' },
  { sort: 'tool', order: 'asc', label: 'Tool name' },
  { sort: 'category', order: 'asc', label: 'Kind of tool' },
  { sort: 'duration', order: 'desc', label: 'Slowest first' },
  { sort: 'outcome', order: 'asc', label: 'Outcome (errors first)' },
];

type StatSort = 'count' | 'last' | 'errors' | 'slowest' | 'name';
const STAT_SORTS: { key: StatSort; label: string }[] = [
  { key: 'count', label: 'Most used' },
  { key: 'last', label: 'Recently used' },
  { key: 'errors', label: 'Error rate' },
  { key: 'slowest', label: 'Slowest (average)' },
  { key: 'name', label: 'Name' },
];

/** One quiet filter at a time, like the other lists: a kind, an outcome or a source. */
type FilterKey = `cat:${ToolCategory}` | `out:${ToolOutcome}` | `src:${ToolSource}`;
const FILTERS: { key: FilterKey; label: string }[] = [
  ...(Object.keys(CATEGORY_LABEL) as ToolCategory[]).map((c) => ({
    key: `cat:${c}` as FilterKey,
    label: CATEGORY_LABEL[c],
  })),
  { key: 'out:error', label: 'Failed or blocked' },
  { key: 'out:empty', label: 'Found nothing' },
  ...(Object.keys(SOURCE_LABEL) as ToolSource[]).map((s) => ({
    key: `src:${s}` as FilterKey,
    label: `From ${SOURCE_LABEL[s].toLowerCase()}`,
  })),
];

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function OutcomeChip({ outcome, recovered }: { outcome: ToolOutcome; recovered?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {recovered && (
        <span
          title="The model wrote this call as text; it was recovered"
          className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
        >
          recovered
        </span>
      )}
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-[10px] font-medium',
          outcome === 'ok' && 'bg-primary/10 text-primary',
          outcome === 'empty' && 'bg-muted text-muted-foreground',
          outcome === 'error' && 'bg-destructive/10 text-destructive',
          outcome === 'unknown' && 'bg-muted text-muted-foreground',
        )}
      >
        {outcome === 'ok' ? 'ok' : outcome === 'empty' ? 'nothing found' : outcome === 'error' ? 'failed' : '—'}
      </span>
    </span>
  );
}

function CategoryIcon({ category }: { category: ToolCategory }) {
  const Icon = CATEGORY_ICON[category] ?? CircleHelp;
  return (
    <span title={CATEGORY_LABEL[category]}>
      <Icon className={cn('h-4 w-4 shrink-0', CATEGORY_TONE[category])} />
    </span>
  );
}

function CallRow({ c, onOpen }: { c: ToolCall; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/60 active:bg-muted"
    >
      <CategoryIcon category={c.category} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{c.label}</span>
        {c.trigger && (
          <span className="block truncate text-xs text-muted-foreground">
            after “{c.trigger}”
          </span>
        )}
        <span className="block truncate text-[11px] text-muted-foreground">
          {[
            fmtTime(c.ts),
            c.tool,
            fmtMs(c.durationMs),
            c.source !== 'chat' ? SOURCE_LABEL[c.source] : null,
            c.uses != null && c.uses > 1 ? `${c.uses}× in view` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <OutcomeChip outcome={c.outcome} recovered={c.recovered} />
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

function CallDetail({
  id,
  onBack,
  onOpenCall,
  onOpenTurn,
}: {
  id: number;
  onBack: () => void;
  onOpenCall: (id: number) => void;
  onOpenTurn?: (turnId: number) => void;
}) {
  const [item, setItem] = useState<ToolCallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    toolLogApi
      .get(id)
      .then((d) => !cancelled && setItem(d))
      .catch((err) => !cancelled && setError(errMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-3">
        <Button variant="ghost" size="icon" aria-label="Back to the log" onClick={onBack} className="h-9 w-9">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{item?.tool ?? 'Tool call'}</h2>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!item && !error && (
          <p className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {item && (
          <>
            <div className="flex items-start gap-3">
              <CategoryIcon category={item.category} />
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium text-foreground">{item.label}</p>
                <p className="text-xs text-muted-foreground">
                  {[CATEGORY_LABEL[item.category], fmtDateTime(item.ts)].join(' · ')}
                </p>
              </div>
              <OutcomeChip outcome={item.outcome} recovered={item.recovered} />
            </div>

            {item.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{item.error}</p>
            )}

            <Field label="Asked">
              {item.trigger ? (
                <p className="rounded-md bg-muted px-3 py-2 italic">“{item.trigger}”</p>
              ) : (
                <span className="text-muted-foreground">Not recorded</span>
              )}
              {item.turnId != null &&
                (item.turnExists && onOpenTurn ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => onOpenTurn(item.turnId!)}
                  >
                    <MessageSquare className="mr-1.5 h-4 w-4" /> Open the conversation
                  </Button>
                ) : (
                  !item.turnExists && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      The reply this belonged to has since been deleted.
                    </p>
                  )
                ))}
            </Field>

            <Field label="Arguments">
              {argLines(item.args).length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <dl className="space-y-2">
                  {argLines(item.args).map((a) => (
                    <div key={a.key}>
                      <dt className="text-xs text-muted-foreground">{a.key}</dt>
                      <dd className="whitespace-pre-wrap break-words font-mono text-[13px]">{a.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Field>

            <Field label="Result">
              {item.backfilled ? (
                <span className="text-muted-foreground">
                  Logged before the tool log existed: no result was kept.
                </span>
              ) : (
                <>
                  <p className="mb-1 text-xs text-muted-foreground">
                    {fmtChars(item.resultChars)} in full; the start is kept here.
                  </p>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-[12px]">
                    {prettyPreview(item.resultPreview ?? '')}
                  </pre>
                </>
              )}
            </Field>

            <Field label="Details">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">From</dt>
                <dd>{SOURCE_LABEL[item.source] ?? item.source}</dd>
                <dt className="text-muted-foreground">Model</dt>
                <dd className="break-all">{item.model ?? '—'}</dd>
                <dt className="text-muted-foreground">Took</dt>
                <dd>{fmtMs(item.durationMs) ?? '—'}</dd>
                {item.round != null && (
                  <>
                    <dt className="text-muted-foreground">Step</dt>
                    <dd>{item.round + 1}</dd>
                  </>
                )}
              </dl>
            </Field>

            {item.siblings.length > 1 && (
              <Field label="All calls in this reply">
                <ol className="space-y-1">
                  {item.siblings.map((s, i) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        disabled={s.id === item.id}
                        onClick={() => onOpenCall(s.id)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm',
                          s.id === item.id ? 'bg-primary/10 font-medium' : 'hover:bg-muted',
                        )}
                      >
                        <span className="w-5 text-xs text-muted-foreground">{i + 1}.</span>
                        <span className="min-w-0 flex-1 truncate">{s.tool}</span>
                        <OutcomeChip outcome={s.outcome} />
                      </button>
                    </li>
                  ))}
                </ol>
              </Field>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** What each kind of tool can do, in the order the help sheet lists them. */
const KIND_HELP: { category: ToolCategory; risk: boolean; examples: string }[] = [
  { category: 'money', risk: true, examples: 'paying or requesting from the wallet, paid search' },
  { category: 'outbound', risk: true, examples: 'web search, reading or screenshotting a page, downloading a video, filing a git issue' },
  { category: 'writes', risk: true, examples: 'drafting a note or an edit, staging a note to send to an agent (all wait for your approval)' },
  { category: 'other', risk: true, examples: 'a tool the log doesn\'t know yet, counted as risky until it\'s sorted' },
  { category: 'reads', risk: false, examples: 'searching memory and notes, reading notes, transcripts, files, the calendar and logs, checking the balance' },
  { category: 'compute', risk: false, examples: 'arithmetic, the date, summarizing what it already found' },
];

/** The "?" explainer: what Risk only screens for and what the badges mean. */
function RiskHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useModalA11y<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="About risk"
        tabIndex={-1}
        className="pb-safe relative max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card px-5 py-4 outline-none sm:max-w-md sm:rounded-2xl"
      >
        <div className="mb-3 flex items-center gap-2">
          <h2 className="flex-1 text-base font-semibold">What counts as risky</h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Every tool call is sorted by what the tool <em>can</em> do, not by whether this call went
          wrong. <strong className="text-foreground">Risk only</strong> shows the kinds worth a
          glance; <strong className="text-foreground">Riskier calls</strong> counts them in the
          current range and filters. Risky doesn&rsquo;t mean bad. Check that you asked for it.
        </p>
        <ul className="mt-4 space-y-3">
          {KIND_HELP.map((k) => (
            <li key={k.category} className="flex gap-3">
              <CategoryIcon category={k.category} />
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  {CATEGORY_LABEL[k.category]}
                  {k.risk && (
                    <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      risk only
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{k.examples}</div>
              </div>
            </li>
          ))}
        </ul>
        <h3 className="mt-5 text-sm font-semibold">The badges</h3>
        <dl className="mt-2 space-y-1.5 text-sm">
          {(
            [
              ['ok', 'ran and returned something'],
              ['nothing found', 'ran and came back empty'],
              ['failed', 'errored, was blocked by a guard (fetch budget, wallet cap…), or was malformed'],
              ['recovered', 'the model wrote the call as text instead of calling it properly; it was run anyway'],
            ] as const
          ).map(([term, meaning]) => (
            <div key={term} className="flex gap-2">
              <dt className="w-28 shrink-0 font-medium">{term}</dt>
              <dd className="text-muted-foreground">{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">
          Arguments are kept in full; results only as their size and their start. Only the model
          inside Collaborator is logged, never connected agents.
        </p>
      </div>
    </div>,
    document.body,
  );
}

function Tile({
  label,
  value,
  tone,
  onHelp,
}: {
  label: string;
  value: number | string;
  tone?: string;
  onHelp?: () => void;
}) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <div className={cn('text-lg font-semibold tabular-nums', tone)}>{value}</div>
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {label}
        {onHelp && (
          <button
            type="button"
            aria-label={`What “${label}” means`}
            onClick={onHelp}
            className="rounded-full text-muted-foreground/70 hover:text-foreground"
          >
            <CircleHelp className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function sortStats(tools: ToolStat[], by: StatSort): ToolStat[] {
  const out = [...tools];
  const cmp: Record<StatSort, (a: ToolStat, b: ToolStat) => number> = {
    count: (a, b) => b.count - a.count,
    last: (a, b) => b.lastUsed.localeCompare(a.lastUsed),
    errors: (a, b) => b.errorRate - a.errorRate || b.errors - a.errors,
    slowest: (a, b) => (b.avgMs ?? -1) - (a.avgMs ?? -1),
    name: (a, b) => a.tool.localeCompare(b.tool),
  };
  return out.sort(cmp[by]);
}

function StatsPanel({
  stats,
  sort,
  onPickTool,
  onHelp,
}: {
  stats: ToolStats;
  sort: StatSort;
  onPickTool: (tool: string) => void;
  onHelp: () => void;
}) {
  const t = stats.totals;
  const max = Math.max(1, ...stats.daily.map((d) => d.count));
  const days = stats.daily.slice(-30);
  return (
    <div className="space-y-4 px-4 py-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Calls" value={t.calls} />
        <Tile
          label="Riskier calls"
          value={t.risk}
          tone={t.risk ? 'text-amber-600' : undefined}
          onHelp={onHelp}
        />
        <Tile label="Failed or blocked" value={t.errors} tone={t.errors ? 'text-destructive' : undefined} />
        <Tile label="Recovered from text" value={t.recovered} />
      </div>

      {days.length > 1 && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Calls per day</div>
          <div className="flex h-16 items-end gap-0.5" role="img" aria-label="Calls per day">
            {days.map((d) => (
              <div
                key={d.day}
                title={`${d.day}: ${d.count}`}
                className="min-w-[3px] flex-1 rounded-t bg-primary/60"
                style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }}
              />
            ))}
          </div>
        </div>
      )}

      <ul className="divide-y divide-border rounded-lg border border-border">
        {sortStats(stats.tools, sort).map((s) => (
          <li key={s.tool}>
            <button
              type="button"
              onClick={() => onPickTool(s.tool)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/60"
            >
              <CategoryIcon category={s.category} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.tool}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {[
                    `last ${dayLabel(s.lastUsed).toLowerCase()} ${fmtTime(s.lastUsed)}`,
                    s.avgMs != null ? `avg ${fmtMs(s.avgMs)}` : null,
                    s.p95Ms != null ? `p95 ${fmtMs(s.p95Ms)}` : null,
                    s.errors ? `${Math.round(s.errorRate * 100)}% failed` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums">{s.count}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>

      {Object.keys(t.byModel).length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          By model:{' '}
          {Object.entries(t.byModel)
            .sort((a, b) => b[1] - a[1])
            .map(([m, n]) => `${m} (${n})`)
            .join(', ')}
        </p>
      )}
    </div>
  );
}

/**
 * The tool log (menu → Tool log): every tool call Collaborator's own model
 * made, for auditing first and usage second. Agent backends never appear.
 * Calls is the audit trail; Usage the per-tool stats. "Risk only" narrows
 * both to calls that spend, leave the machine, propose changes, or are
 * unrecognized.
 */
export function ToolLogView({ onOpenTurn }: { onOpenTurn?: (turnId: number) => void }) {
  const [tab, setTab] = useState<'calls' | 'usage'>('calls');
  const [riskOnly, setRiskOnly] = useState(false);
  const [range, setRange] = useState<TimeRange>('7d');
  const [filter, setFilter] = useState<FilterKey | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sortIdx, setSortIdx] = useState(0);
  const [statSort, setStatSort] = useState<StatSort>('count');
  const [sortOpen, setSortOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const [calls, setCalls] = useState<ToolCall[] | null>(null);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ToolStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const filters = useMemo<ToolFilters>(() => {
    const [kind, value] = filter ? (filter.split(':') as [string, string]) : [null, null];
    return {
      risk: riskOnly,
      since: sinceFor(range),
      tool,
      q: debounced,
      category: kind === 'cat' ? (value as ToolCategory) : null,
      outcome: kind === 'out' ? (value as ToolOutcome) : null,
      source: kind === 'src' ? (value as ToolSource) : null,
    };
  }, [riskOnly, range, tool, debounced, filter]);
  const { sort, order } = CALL_SORTS[sortIdx];

  const load = useCallback(async () => {
    setError(null);
    try {
      if (tab === 'calls') {
        const page = await toolLogApi.list(filters, sort, order, 0, PAGE);
        setCalls(page.calls);
        setTotal(page.total);
      } else {
        setStats(await toolLogApi.stats(filters));
      }
    } catch (err) {
      setError(errMessage(err));
    }
  }, [tab, filters, sort, order]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!calls) return;
    setLoadingMore(true);
    try {
      const page = await toolLogApi.list(filters, sort, order, calls.length, PAGE);
      setCalls([...calls, ...page.calls]);
      setTotal(page.total);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  useBack(selectedId != null, () => setSelectedId(null));

  if (selectedId != null) {
    return (
      <CallDetail
        id={selectedId}
        onBack={() => setSelectedId(null)}
        onOpenCall={setSelectedId}
        onOpenTurn={onOpenTurn}
      />
    );
  }

  const activeLabel = [tool, filter ? FILTERS.find((f) => f.key === filter)?.label : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex h-full flex-col">
      <PageBar title="Tool log" />
      <div className="space-y-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <div role="tablist" className="flex rounded-lg bg-muted p-0.5 text-sm">
            {(['calls', 'usage'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  'rounded-md px-3 py-1',
                  tab === t ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground',
                )}
              >
                {t === 'calls' ? 'Calls' : 'Usage'}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-pressed={riskOnly}
            title="Only calls that spend money, leave the machine, propose changes, or are unrecognized"
            onClick={() => setRiskOnly((r) => !r)}
            className={cn(
              'flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs',
              riskOnly
                ? 'border-amber-500/40 bg-amber-500/10 font-medium text-amber-700'
                : 'border-border text-muted-foreground',
            )}
          >
            <ShieldAlert className="h-3.5 w-3.5" /> Risk only
          </button>
          <button
            type="button"
            aria-label="What counts as risky"
            title="What counts as risky"
            onClick={() => setHelpOpen(true)}
            className="-ml-1 rounded-full p-1 text-muted-foreground/70 hover:text-foreground"
          >
            <CircleHelp className="h-4 w-4" />
          </button>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sort"
            title="Sort"
            onClick={() => setSortOpen(true)}
            className="h-8 w-8 text-muted-foreground"
          >
            <ArrowUpDown className="h-4 w-4" />
          </Button>
          <ListFilterButton
            title="Show only"
            options={FILTERS}
            value={filter}
            onChange={setFilter}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh"
            onClick={() => void load()}
            className="h-8 w-8 text-muted-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1 text-xs">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                'rounded-full px-2.5 py-0.5',
                range === r.key ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 rounded-md border border-input bg-background px-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search arguments, tools and messages"
            aria-label="Search the tool log"
            className="min-h-[2.25rem] min-w-0 flex-1 bg-transparent text-base text-foreground outline-none sm:text-sm"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
      </div>
      <ActiveFilter
        label={activeLabel || null}
        count={tab === 'calls' ? total : (stats?.totals.calls ?? 0)}
        onClear={() => {
          setFilter(null);
          setTool(null);
        }}
      />
      <ActionSheet
        open={sortOpen}
        title="Sort by"
        actions={
          tab === 'calls'
            ? CALL_SORTS.map((s, i) => ({
                label: (i === sortIdx ? '✓ ' : '') + s.label,
                onSelect: () => setSortIdx(i),
              }))
            : STAT_SORTS.map((s) => ({
                label: (s.key === statSort ? '✓ ' : '') + s.label,
                onSelect: () => setStatSort(s.key),
              }))
        }
        onClose={() => setSortOpen(false)}
      />
      <RiskHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
        {tab === 'usage' ? (
          stats === null ? (
            <Spinner />
          ) : stats.totals.calls === 0 ? (
            <Empty filtered={Boolean(activeLabel || debounced || riskOnly || range !== 'all')} />
          ) : (
            <StatsPanel
              stats={stats}
              sort={statSort}
              onPickTool={(t) => {
                setTool(t);
                setTab('calls');
              }}
              onHelp={() => setHelpOpen(true)}
            />
          )
        ) : calls === null ? (
          <Spinner />
        ) : calls.length === 0 ? (
          <Empty filtered={Boolean(activeLabel || debounced || riskOnly || range !== 'all')} />
        ) : (
          <>
            {sort === 'time' ? (
              groupByDay(calls).map((g) => (
                <section key={g.day}>
                  <h3 className="sticky top-0 z-10 bg-background/95 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
                    {g.day}
                  </h3>
                  <ul className="divide-y divide-border">
                    {g.calls.map((c) => (
                      <li key={c.id}>
                        <CallRow c={c} onOpen={() => setSelectedId(c.id)} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            ) : (
              <ul className="divide-y divide-border">
                {calls.map((c) => (
                  <li key={c.id}>
                    <CallRow c={c} onOpen={() => setSelectedId(c.id)} />
                  </li>
                ))}
              </ul>
            )}
            {calls.length < total && (
              <div className="flex justify-center py-4">
                <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  Show more ({total - calls.length} left)
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <p className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </p>
  );
}

function Empty({ filtered }: { filtered: boolean }) {
  return filtered ? (
    <p className="px-4 py-10 text-center text-sm text-muted-foreground">No tool calls match.</p>
  ) : (
    <div className="py-16 text-center text-muted-foreground">
      <ShieldAlert className="mx-auto mb-3 h-8 w-8 opacity-40" />
      <p className="text-lg font-medium text-foreground">No tool calls yet</p>
      <p className="mt-1 px-8 text-sm">Every tool the model uses in chat, calls and Scratch actions shows up here.</p>
    </div>
  );
}
