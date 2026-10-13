import type { NoteMeta } from '@/domain/models';
import { parseWallClock } from '@/features/notes/eventFields';

/** Local-date helpers (never `new Date('YYYY-MM-DD')` — that's UTC). */
export const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const addDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Monday of the week containing `d` (weeks run Monday–Sunday). */
export const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local calendar date as ISO `YYYY-MM-DD`. */
export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Local wall-clock `YYYY-MM-DDTHH:MM` — what the backend expects (it
 * stamps the offset itself). */
export const isoLocal = (d: Date) => `${isoDay(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

export const SNAP_MINUTES = 15;

/** Minutes since midnight, snapped down to the grid. */
export function snapMinutes(minutes: number, step = SNAP_MINUTES): number {
  return Math.max(0, Math.min(24 * 60, Math.floor(minutes / step) * step));
}

/** A day plus minutes-since-midnight as a local Date. */
export function atMinutes(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

/** Stable React key for a calendar row: one note can be many occurrences. */
export const eventKey = (e: NoteMeta) => `${e.filename}#${e.occurrence ?? ''}`;

export interface PlacedEvent {
  event: NoteMeta;
  /** Minutes since midnight, clamped to the day. */
  top: number;
  bottom: number;
  /** Side-by-side lane among overlapping events, and how many lanes. */
  lane: number;
  lanes: number;
}

/**
 * Timed events of ONE day laid out for the week grid: clamped to the day
 * (a multi-day event shows on its start day, cut at midnight — v1), at least
 * 30 minutes tall, overlaps split into lanes (greedy, per overlap cluster).
 */
export function placeDayEvents(events: NoteMeta[], day: Date): PlacedEvent[] {
  const items = events
    .map((event) => {
      const s = event.fields?.start ? parseWallClock(event.fields.start) : null;
      if (!s || event.fields?.allDay || !sameDay(s, day)) return null;
      const e = event.fields?.end ? parseWallClock(event.fields.end) : null;
      const top = s.getHours() * 60 + s.getMinutes();
      let bottom = e && e > s ? (sameDay(e, day) ? e.getHours() * 60 + e.getMinutes() : 24 * 60) : top + 60;
      bottom = Math.max(bottom, top + 30);
      return { event, top, bottom: Math.min(bottom, 24 * 60) };
    })
    .filter((x): x is { event: NoteMeta; top: number; bottom: number } => x !== null)
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);

  const placed: PlacedEvent[] = [];
  let cluster: PlacedEvent[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((p) => p.lane + 1));
    for (const p of cluster) p.lanes = lanes;
    placed.push(...cluster);
    cluster = [];
  };
  for (const it of items) {
    if (it.top >= clusterEnd && cluster.length) flush();
    const laneEnds: number[] = [];
    for (const p of cluster) laneEnds[p.lane] = Math.max(laneEnds[p.lane] ?? -1, p.bottom);
    let lane = laneEnds.findIndex((end) => end <= it.top);
    if (lane === -1) lane = laneEnds.length;
    cluster.push({ ...it, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, it.bottom);
  }
  if (cluster.length) flush();
  return placed;
}

/** All-day events (and date-only ones) touching `day`. */
export function allDayOn(events: NoteMeta[], day: Date): NoteMeta[] {
  return events.filter((event) => {
    if (!event.fields?.allDay || !event.fields.start) return false;
    const s = parseWallClock(event.fields.start);
    const e = event.fields.end ? parseWallClock(event.fields.end) : s;
    if (!s || !e) return false;
    return startOfDay(s) <= day && day <= startOfDay(e);
  });
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** "Weekly on Mon, Thu · until Dec 31" — a rule in words. */
export function describeRepeat(
  rule: { freq: string; interval?: number; byDay?: string[]; byMonthDay?: number; until?: string; count?: number },
): string {
  const every = rule.interval && rule.interval > 1;
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[rule.freq] ?? rule.freq;
  let text = every ? `Every ${rule.interval} ${unit}s` : rule.freq[0].toUpperCase() + rule.freq.slice(1);
  if (rule.byDay?.length) {
    const names = rule.byDay.map((c) => {
      const i = WEEKDAY_CODES.indexOf(c);
      return i < 0 ? c : new Date(2026, 0, 4 + i).toLocaleDateString([], { weekday: 'short' });
    });
    text += ` on ${names.join(', ')}`;
  }
  if (rule.byMonthDay) text += ` on day ${rule.byMonthDay}`;
  if (rule.until) {
    const u = parseWallClock(rule.until);
    text += ` · until ${u ? u.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : rule.until}`;
  }
  if (rule.count) text += ` · ${rule.count} times`;
  return text;
}

/** Weekday code (MO…SU) for a local date. */
export const weekdayCode = (d: Date) => WEEKDAY_CODES[d.getDay()];
