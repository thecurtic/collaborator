import { Repeat } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteMeta } from '@/domain/models';
import { cn } from '@/lib/utils';
import {
  addDays,
  allDayOn,
  atMinutes,
  eventKey,
  isoDay,
  placeDayEvents,
  sameDay,
  snapMinutes,
} from './calendarDates';

const HOUR_PX = 48;
const MIN_PX = HOUR_PX / 60;
const HOLD_MS = 300;         // touch: hold this long before a drag selects
const MOVE_CANCEL_PX = 10;   // touch: moving sooner than that is a scroll

interface Selection {
  dayIndex: number;
  anchor: number;            // minutes where the press started
  current: number;           // minutes under the pointer now
}

/**
 * The week time-grid (UX doc, Events: "the calendar is the form"). Tap a
 * slot for a one-hour event; drag (mouse) or hold-then-drag (touch) to size
 * it; either way only the title is typed. Taps on an event open it.
 * Multi-day timed events show on their start day, cut at midnight (v1).
 */
export function WeekGrid({
  weekStart,
  events,
  onCreate,
  onOpenEvent,
}: {
  weekStart: Date;
  events: NoteMeta[];
  onCreate: (range: { start: Date; end: Date; allDay: boolean }) => void;
  onOpenEvent: (event: NoteMeta) => void;
}) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]);
  const today = new Date();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const selRef = useRef<Selection | null>(null);
  selRef.current = sel;
  const press = useRef<{ x: number; y: number; dayIndex: number; minutes: number;
    timer: ReturnType<typeof setTimeout> | null; touch: boolean; armed: boolean;
    dragged: boolean } | null>(null);

  // Land on the working day, not midnight.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX;
  }, []);

  // Once a touch selection is armed, stop the page from scrolling under it.
  // (React's touchmove is passive, so this needs a native listener.)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      if (press.current?.armed) e.preventDefault();
    };
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, []);

  const minutesAt = (clientY: number, column: HTMLElement) => {
    const rect = column.getBoundingClientRect();
    return snapMinutes((clientY - rect.top) / MIN_PX);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, dayIndex: number) => {
    if (e.button !== 0) return;
    const minutes = minutesAt(e.clientY, e.currentTarget);
    const touch = e.pointerType !== 'mouse';
    press.current = { x: e.clientX, y: e.clientY, dayIndex, minutes, timer: null, touch,
                      armed: !touch, dragged: false };
    if (touch) {
      press.current.timer = setTimeout(() => {
        if (!press.current) return;
        press.current.armed = true;
        setSel({ dayIndex, anchor: minutes, current: minutes + 60 });
        navigator.vibrate?.(10);
      }, HOLD_MS);
    } else {
      e.currentTarget.setPointerCapture(e.pointerId);
      setSel({ dayIndex, anchor: minutes, current: minutes + SNAP });
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.armed) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_CANCEL_PX) {
        if (p.timer) clearTimeout(p.timer);
        press.current = null;                       // it's a scroll
      }
      return;
    }
    const s = selRef.current;
    if (!s) return;
    if (Math.abs(e.clientY - p.y) > 4) p.dragged = true;
    const minutes = minutesAt(e.clientY, e.currentTarget);
    setSel({ ...s, current: minutes >= s.anchor ? minutes + SNAP : minutes });
  };

  const onPointerUp = () => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    const s = selRef.current;
    setSel(null);
    const day = days[p.dayIndex];
    // A touch hold without a drag sized it to an hour already; a mouse
    // click (no drag) is a plain tap.
    if (!p.armed || !s || (!p.touch && !p.dragged)) {
      // A plain tap: a one-hour event at the tapped half hour.
      const start = Math.min(snapMinutes(p.minutes, 30), 23 * 60);
      onCreate({ start: atMinutes(day, start), end: atMinutes(day, start + 60), allDay: false });
      return;
    }
    const lo = Math.min(s.anchor, s.current);
    const hi = Math.max(s.anchor, s.current);
    onCreate({ start: atMinutes(day, lo), end: atMinutes(day, Math.max(hi, lo + SNAP)),
               allDay: false });
  };

  const cancelPress = () => {
    if (press.current?.timer) clearTimeout(press.current.timer);
    press.current = null;
    setSel(null);
  };

  const hasAllDay = days.some((d) => allDayOn(events, d).length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day headers */}
      <div className="flex border-b border-border pl-10 pr-1">
        {days.map((d) => (
          <div key={isoDay(d)} className="flex-1 py-1.5 text-center">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {d.toLocaleDateString([], { weekday: 'short' })}
            </p>
            <p className={cn('mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-sm tabular-nums',
              sameDay(d, today) ? 'bg-primary font-semibold text-primary-foreground' : 'text-foreground')}>
              {d.getDate()}
            </p>
          </div>
        ))}
      </div>

      {/* All-day row (tap empty space to add an all-day event) */}
      <div className="flex border-b border-border pl-10 pr-1">
        {days.map((d) => {
          const list = allDayOn(events, d);
          return (
            <button
              key={isoDay(d)}
              type="button"
              aria-label={`Add an all-day event on ${d.toLocaleDateString()}`}
              onClick={() => onCreate({ start: d, end: d, allDay: true })}
              className={cn('min-h-[1.75rem] flex-1 space-y-0.5 border-l border-border/60 p-0.5 text-left',
                !hasAllDay && 'min-h-[1.25rem]')}
            >
              {list.map((e) => (
                <span
                  key={eventKey(e)}
                  role="button"
                  tabIndex={0}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onOpenEvent(e);
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') {
                      ev.stopPropagation();
                      onOpenEvent(e);
                    }
                  }}
                  className="block truncate rounded bg-primary/15 px-1 text-[10px] leading-4 text-primary"
                >
                  {e.title}
                </span>
              ))}
            </button>
          );
        })}
      </div>

      {/* The grid */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="relative flex pr-1" style={{ height: 24 * HOUR_PX }}>
          <div className="relative w-10 shrink-0">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              // Centred on its hour line, positioned absolutely so labels
              // never drift from the lines they name.
              <p key={h} className="absolute right-1 text-[10px] leading-3 tabular-nums text-muted-foreground"
                 style={{ top: h * HOUR_PX - 6 }}>
                {new Date(2026, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}
              </p>
            ))}
          </div>
          {days.map((d, dayIndex) => {
            const placed = placeDayEvents(events, d);
            const s = sel && sel.dayIndex === dayIndex ? sel : null;
            return (
              <div
                key={isoDay(d)}
                className={cn('relative flex-1 select-none border-l border-border/60 [-webkit-touch-callout:none]',
                  sameDay(d, today) && 'bg-primary/[0.03]')}
                style={{
                  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, var(--color-border) ${HOUR_PX - 1}px, var(--color-border) ${HOUR_PX}px)`,
                }}
                onPointerDown={(e) => onPointerDown(e, dayIndex)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={cancelPress}
                onContextMenu={(e) => e.preventDefault()}
              >
                {placed.map((p) => (
                  <button
                    key={eventKey(p.event)}
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onOpenEvent(p.event)}
                    className="absolute overflow-hidden rounded border border-primary/30 bg-primary/15 px-1 py-0.5 text-left text-[10px] leading-tight text-primary hover:bg-primary/25"
                    style={{
                      top: p.top * MIN_PX,
                      height: Math.max(18, (p.bottom - p.top) * MIN_PX - 1),
                      left: `${(p.lane / p.lanes) * 100}%`,
                      width: `${100 / p.lanes}%`,
                    }}
                  >
                    <span className="flex items-center gap-0.5 font-medium">
                      {p.event.recurring && <Repeat className="h-2.5 w-2.5 shrink-0" />}
                      <span className="truncate">{p.event.title}</span>
                    </span>
                  </button>
                ))}
                {s && (
                  <div
                    className="pointer-events-none absolute inset-x-0.5 rounded border-2 border-primary bg-primary/20"
                    style={{
                      top: Math.min(s.anchor, s.current) * MIN_PX,
                      height: Math.max(SNAP, Math.abs(s.current - s.anchor)) * MIN_PX,
                    }}
                  />
                )}
                {sameDay(d, today) && (
                  <div className="pointer-events-none absolute inset-x-0 h-px bg-destructive"
                       style={{ top: (today.getHours() * 60 + today.getMinutes()) * MIN_PX }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const SNAP = 15;
