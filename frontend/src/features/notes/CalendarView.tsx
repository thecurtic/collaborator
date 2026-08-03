import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  MapPin,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { NoteMeta } from '@/domain/models';
import { formatEventRange, parseWallClock } from './eventFields';

/**
 * Calendar over event notes (85c508c): an agenda (rolling window, grouped by
 * day) and a month grid, both backed by api.listEvents — which returns events
 * OVERLAPPING [from, to] sorted by start. Multi-day events render under their
 * START day only (agenda + month) — acceptable v1; formatEventRange already
 * shows the full cross-day range on the row itself.
 */

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

// ---- Local-date helpers (never `new Date('YYYY-MM-DD')` — UTC shift) ----

const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());

const addDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local calendar date as the API's inclusive ISO `YYYY-MM-DD`. */
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** "Today" / "Tomorrow" / "Sat, Aug 2" (year appended when it differs). */
function dayLabel(d: Date, now = new Date()): string {
  const today = startOfDay(now);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, addDays(today, 1))) return 'Tomorrow';
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Start day of an event, parsed as LOCAL wall clock. Null = unschedulable. */
function eventStartDate(n: NoteMeta): Date | null {
  return n.fields?.start ? parseWallClock(n.fields.start) : null;
}

/** Within a day: all-day events first, then by start time, then title. */
function sortDayEvents(list: NoteMeta[]): NoteMeta[] {
  return [...list].sort((a, b) => {
    const aAll = a.fields?.allDay ? 0 : 1;
    const bAll = b.fields?.allDay ? 0 : 1;
    if (aAll !== bAll) return aAll - bAll;
    const sa = a.fields?.start ?? '';
    const sb = b.fields?.start ?? '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/** Bucket events by their (local) start day; keys sorted ascending. */
function groupByStartDay(
  events: NoteMeta[],
): { key: string; date: Date; events: NoteMeta[] }[] {
  const map = new Map<string, { date: Date; events: NoteMeta[] }>();
  for (const e of events) {
    const start = eventStartDate(e);
    if (!start) continue; // no parseable start — nothing to place it on
    const day = startOfDay(start);
    const key = isoDay(day);
    const bucket = map.get(key);
    if (bucket) bucket.events.push(e);
    else map.set(key, { date: day, events: [e] });
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, g]) => ({ key, date: g.date, events: sortDayEvents(g.events) }));
}

/** One tappable event row (agenda + month selected-day panel). */
function EventRow({
  event,
  onOpenNote,
}: {
  event: NoteMeta;
  onOpenNote: (title: string) => void;
}) {
  const f = event.fields;
  return (
    <button
      type="button"
      onClick={() => onOpenNote(event.title)}
      className="flex w-full flex-col gap-0.5 px-4 py-2.5 text-left hover:bg-muted/60 active:bg-muted"
    >
      <span className="truncate text-sm font-medium text-foreground">
        {event.title}
      </span>
      {f?.start && (
        <span className="text-xs text-muted-foreground">
          {formatEventRange(f)}
        </span>
      )}
      {f?.location && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="h-3 w-3 shrink-0" />
          <span className="truncate">{f.location}</span>
        </span>
      )}
      {f && f.people.length > 0 && (
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
          <Users className="h-3 w-3 shrink-0 text-muted-foreground" />
          {f.people.map((p) => (
            <span
              key={p}
              className="rounded bg-accent px-1 py-px text-[10px] text-accent-foreground"
            >
              {p}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function EmptyEvents() {
  return (
    <div className="py-16 text-center text-muted-foreground">
      <CalendarDays className="mx-auto mb-3 h-8 w-8 opacity-40" />
      <p className="text-lg font-medium text-foreground">No events yet</p>
      <p className="mt-1 px-8 text-sm">
        Ask the agent to schedule something, or approve an event draft.
      </p>
    </div>
  );
}

// ---- Agenda ----

const AGENDA_BACK_DAYS = 14;
const AGENDA_AHEAD_DAYS = 60;

function AgendaList({
  onOpenNote,
}: {
  onOpenNote: (title: string) => void;
}) {
  const [events, setEvents] = useState<NoteMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Window: fixed 14 days back, extendable forward ("Load more" adds 60).
  const [aheadDays, setAheadDays] = useState(AGENDA_AHEAD_DAYS);
  const seq = useRef(0);
  const todayAnchor = useRef<HTMLDivElement | null>(null);
  const didScroll = useRef(false);

  useEffect(() => {
    const s = ++seq.current;
    setLoading(true);
    setError(null);
    const today = startOfDay(new Date());
    api
      .listEvents(
        isoDay(addDays(today, -AGENDA_BACK_DAYS)),
        isoDay(addDays(today, aheadDays)),
      )
      .then((res) => {
        if (seq.current === s) setEvents(res);
      })
      .catch((err) => {
        if (seq.current === s) {
          setError(errMessage(err));
          setEvents((prev) => prev ?? []);
        }
      })
      .finally(() => {
        if (seq.current === s) setLoading(false);
      });
  }, [aheadDays]);

  const groups = useMemo(
    () => (events === null ? null : groupByStartDay(events)),
    [events],
  );

  // First group on/after today — where the initial scroll lands.
  const todayKey = isoDay(new Date());
  const anchorKey = groups?.find((g) => g.key >= todayKey)?.key ?? null;

  // Jump to today once, on first load (not on "Load more" refetches).
  useEffect(() => {
    if (!groups || didScroll.current) return;
    didScroll.current = true;
    todayAnchor.current?.scrollIntoView({ block: 'start' });
  }, [groups]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
      {groups === null ? (
        <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading events…
        </div>
      ) : groups.length === 0 && !error ? (
        <EmptyEvents />
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.key} ref={g.key === anchorKey ? todayAnchor : null}>
              <p
                className={cn(
                  'border-b border-border bg-muted/40 px-4 py-1.5 text-xs font-medium uppercase tracking-wide',
                  g.key === todayKey ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                {dayLabel(g.date)}
              </p>
              <ul className="divide-y divide-border border-b border-border">
                {g.events.map((e) => (
                  <li key={e.filename}>
                    <EventRow event={e} onOpenNote={onOpenNote} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="flex justify-center py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAheadDays((d) => d + 60)}
              disabled={loading}
              className="h-8 gap-1.5 px-3 text-xs text-muted-foreground"
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Load more
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Month ----

function MonthGrid({
  onOpenNote,
}: {
  onOpenNote: (title: string) => void;
}) {
  // First of the visible month.
  const [anchor, setAnchor] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [events, setEvents] = useState<NoteMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>(isoDay(new Date()));
  const seq = useRef(0);

  // Grid cells: Monday on/before the 1st through Sunday on/after month end.
  const cells = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const start = addDays(first, -((first.getDay() + 6) % 7)); // back to Monday
    const end = addDays(last, (7 - last.getDay()) % 7); // forward to Sunday
    const out: Date[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
    return out;
  }, [anchor]);

  // Fetch the visible grid range (padded to its edges), per month.
  const fromIso = isoDay(cells[0]);
  const toIso = isoDay(cells[cells.length - 1]);
  useEffect(() => {
    const s = ++seq.current;
    setError(null);
    api
      .listEvents(fromIso, toIso)
      .then((res) => {
        if (seq.current === s) setEvents(res);
      })
      .catch((err) => {
        if (seq.current === s) {
          setError(errMessage(err));
          setEvents((prev) => prev ?? []);
        }
      });
  }, [fromIso, toIso]);

  // Events keyed by start day (multi-day spill-over is a v1 non-goal).
  const byDay = useMemo(() => {
    const map = new Map<string, NoteMeta[]>();
    if (events) {
      for (const g of groupByStartDay(events)) map.set(g.key, g.events);
    }
    return map;
  }, [events]);

  const todayKey = isoDay(new Date());
  const selectedDate = parseWallClock(selectedKey);
  const selectedEvents = byDay.get(selectedKey) ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="flex items-center justify-between px-4 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous month"
          onClick={() =>
            setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))
          }
          className="h-8 w-8 text-muted-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <p className="text-sm font-semibold text-foreground">
          {anchor.toLocaleDateString([], { month: 'long', year: 'numeric' })}
        </p>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next month"
          onClick={() =>
            setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))
          }
          className="h-8 w-8 text-muted-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      {error && <p className="px-4 pb-2 text-sm text-destructive">{error}</p>}

      <div className="px-2">
        <div className="grid grid-cols-7">
          {cells.slice(0, 7).map((d) => (
            <p
              key={d.getDay()}
              className="pb-1 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {d.toLocaleDateString([], { weekday: 'short' })}
            </p>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border bg-border">
          {cells.map((d) => {
            const key = isoDay(d);
            const inMonth = d.getMonth() === anchor.getMonth();
            const dayEvents = byDay.get(key) ?? [];
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedKey(key)}
                className={cn(
                  'flex min-h-16 flex-col items-stretch gap-0.5 bg-background p-1 text-left hover:bg-muted/60 active:bg-muted',
                  key === selectedKey && 'bg-primary/5',
                )}
              >
                <span
                  className={cn(
                    'self-start text-xs tabular-nums',
                    key === todayKey
                      ? 'flex h-5 w-5 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground'
                      : inMonth
                        ? 'px-0.5 text-foreground'
                        : 'px-0.5 text-muted-foreground/50',
                  )}
                >
                  {d.getDate()}
                </span>
                {dayEvents.slice(0, 2).map((e) => (
                  <span
                    key={e.filename}
                    className={cn(
                      'truncate rounded bg-primary/10 px-1 py-px text-[10px] leading-tight text-primary',
                      !inMonth && 'opacity-50',
                    )}
                  >
                    {e.title}
                  </span>
                ))}
                {dayEvents.length > 2 && (
                  <span className="px-1 text-[10px] text-muted-foreground">
                    +{dayEvents.length - 2}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected-day panel: that day's events, tappable through to the note. */}
      <div className="mt-2 border-t border-border">
        <p className="px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {selectedDate ? dayLabel(selectedDate) : selectedKey}
        </p>
        {events === null ? (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : selectedEvents.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            No events this day.
          </p>
        ) : (
          <ul className="divide-y divide-border border-b border-border">
            {selectedEvents.map((e) => (
              <li key={e.filename}>
                <EventRow event={e} onOpenNote={onOpenNote} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The calendar panel (renders in the Notes list area, below search + chips):
 * Agenda/Month toggle, ICS export, and the two views above.
 */
export function CalendarView({
  onOpenNote,
}: {
  onOpenNote: (title: string) => void;
}) {
  const [mode, setMode] = useState<'agenda' | 'month'>('agenda');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // RFC 5545 export (85c508c): fetch the blob, click a temporary <a download>.
  const exportIcs = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const blob = await api.downloadEventsIcs();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'collaborator.ics';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(errMessage(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <CalendarDays className="h-4 w-4 text-primary/70" />
          Calendar
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Export calendar (.ics)"
            title="Export all events as an .ics file"
            onClick={() => void exportIcs()}
            disabled={exporting}
            className="h-8 w-8 text-muted-foreground"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </Button>
          <div className="flex rounded-md border border-border p-0.5">
            {(['agenda', 'month'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs capitalize',
                  mode === m
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>
      {exportError && (
        <p className="px-4 pb-2 text-xs text-destructive">
          Export failed: {exportError}
        </p>
      )}
      {mode === 'agenda' ? (
        <AgendaList onOpenNote={onOpenNote} />
      ) : (
        <MonthGrid onOpenNote={onOpenNote} />
      )}
    </div>
  );
}
