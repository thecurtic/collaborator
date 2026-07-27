import type { EventDraftFields } from '@/domain/models';

/**
 * Display/edit helpers for event-draft times (85c508c). Values are wall-clock
 * ISO strings without offsets (the backend stamps offsets at approval), so
 * date-only strings must be parsed as LOCAL dates — `new Date('2026-08-02')`
 * would read as UTC midnight and show the previous day west of Greenwich.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseWallClock(value: string): Date | null {
  const m = DATE_ONLY.exec(value);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

function fmtDay(d: Date, withYear: boolean): string {
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Human-readable range: "Sun, Aug 2 · 2:00 PM – 3:00 PM", "Sun, Aug 2 ·
 * all day", "Sun, Aug 2, 2:00 PM – Mon, Aug 3, 9:00 AM". Falls back to the
 * raw string for anything unparseable (never hide a value under review).
 */
export function formatEventRange(f: EventDraftFields, now = new Date()): string {
  if (!f.start) return '';
  const start = parseWallClock(f.start);
  if (!start) return f.start;
  const end = f.end ? parseWallClock(f.end) : null;
  const withYear = start.getFullYear() !== now.getFullYear();

  if (f.allDay) {
    if (end && !sameDay(start, end)) {
      return `${fmtDay(start, withYear)} – ${fmtDay(end, withYear)} · all day`;
    }
    return `${fmtDay(start, withYear)} · all day`;
  }
  if (end && !sameDay(start, end)) {
    return `${fmtDay(start, withYear)}, ${fmtTime(start)} – ${fmtDay(end, withYear)}, ${fmtTime(end)}`;
  }
  const times = end ? `${fmtTime(start)} – ${fmtTime(end)}` : fmtTime(start);
  return `${fmtDay(start, withYear)} · ${times}`;
}

/** Value for <input type="datetime-local"> (local wall clock, minutes). */
export function toDateTimeLocalInput(value: string): string {
  const d = parseWallClock(value);
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Value for <input type="date">. */
export function toDateInput(value: string): string {
  return toDateTimeLocalInput(value).slice(0, 10);
}
