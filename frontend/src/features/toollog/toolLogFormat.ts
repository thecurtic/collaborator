import type { ToolCall, ToolCategory } from './toolLogApi';

export type TimeRange = '24h' | '7d' | '30d' | 'all';

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  money: 'Spends money',
  outbound: 'Leaves the machine',
  writes: 'Proposes changes',
  reads: 'Reads your data',
  compute: 'Harmless',
  other: 'Unrecognized',
};

/** SQLite's UTC "YYYY-MM-DD HH:MM:SS" → Date. */
export function parseUtc(sqlUtc: string): Date {
  return new Date(`${sqlUtc.replace(' ', 'T')}Z`);
}

/** The `since` bound for a range, in the log's UTC form; null = no bound. */
export function sinceFor(range: TimeRange, now: Date = new Date()): string | null {
  const hours = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, all: 0 }[range];
  if (!hours) return null;
  return new Date(now.getTime() - hours * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}

export function fmtMs(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function fmtChars(n: number | null): string | null {
  if (n == null) return null;
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k chars`;
}

export function fmtTime(sqlUtc: string): string {
  return parseUtc(sqlUtc).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fmtDateTime(sqlUtc: string): string {
  return parseUtc(sqlUtc).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "Today", "Yesterday" or a short local date. */
export function dayLabel(sqlUtc: string, now: Date = new Date()): string {
  const d = parseUtc(sqlUtc);
  const key = (x: Date) => x.toDateString();
  if (key(d) === key(now)) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (key(d) === key(y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Consecutive calls under one local-day heading (for the time sort). */
export function groupByDay(calls: ToolCall[], now: Date = new Date()): { day: string; calls: ToolCall[] }[] {
  const groups: { day: string; calls: ToolCall[] }[] = [];
  for (const c of calls) {
    const day = dayLabel(c.ts, now);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.calls.push(c);
    else groups.push({ day, calls: [c] });
  }
  return groups;
}

/** Arguments as readable key/value lines: strings as-is, the rest as JSON. */
export function argLines(args: Record<string, unknown>): { key: string; value: string }[] {
  return Object.entries(args)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([key, v]) => ({
      key: key === '_unparsed' ? 'unparsed arguments' : key.replace(/_/g, ' '),
      value: typeof v === 'string' ? v : JSON.stringify(v, null, 2),
    }));
}

/** A result preview, pretty-printed when it's complete JSON. */
export function prettyPreview(preview: string): string {
  try {
    return JSON.stringify(JSON.parse(preview), null, 2);
  } catch {
    return preview;
  }
}
