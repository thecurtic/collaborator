import { Loader2, Repeat } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import type {
  NoteFieldsPatch,
  NoteMeta,
  OccurrenceException,
  RepeatFreq,
  RepeatRule,
} from '@/domain/models';
import { formatEventRange, parseWallClock } from '@/features/notes/eventFields';
import { useModalA11y } from '@/lib/useModalA11y';
import { describeRepeat, isoDay, isoLocal, weekdayCode } from './calendarDates';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function Sheet({ open, label, onClose, children }: {
  open: boolean; label: string; onClose: () => void; children: React.ReactNode;
}) {
  const ref = useModalA11y<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
           className="pb-safe relative max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card p-4 outline-none sm:max-w-sm sm:rounded-2xl">
        {children}
      </div>
    </div>,
    document.body,
  );
}

const INPUT = 'min-h-[2.25rem] w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm';

const FREQS: { value: RepeatFreq | ''; label: string }[] = [
  { value: '', label: "Doesn't repeat" },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

/**
 * The calendar's create step: the slot set the time, so the title is the
 * only thing typed (repeat is optional and one tap).
 */
export function CreateEventSheet({ range, onClose, onCreated }: {
  range: { start: Date; end: Date; allDay: boolean } | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [freq, setFreq] = useState<RepeatFreq | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (range) {
      setTitle('');
      setFreq('');
      setError(null);
    }
  }, [range]);

  if (!range) return null;
  const when = range.allDay
    ? formatEventRange({ start: isoDay(range.start), end: null, allDay: true })
    : formatEventRange({ start: isoLocal(range.start), end: isoLocal(range.end), allDay: false });

  const save = () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    const repeat: RepeatRule | null = freq
      ? { freq, ...(freq === 'weekly' ? { byDay: [weekdayCode(range.start)] } : {}) }
      : null;
    api
      .createEvent({
        title: title.trim(),
        start: range.allDay ? isoDay(range.start) : isoLocal(range.start),
        end: range.allDay ? null : isoLocal(range.end),
        allDay: range.allDay,
        repeat,
      })
      .then(() => {
        onCreated();
        onClose();
      })
      .catch((err) => setError(errMessage(err)))
      .finally(() => setSaving(false));
  };

  return (
    <Sheet open label="New event" onClose={onClose}>
      <p className="mb-3 text-sm text-muted-foreground">{when}</p>
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
        }}
        placeholder="Title"
        aria-label="Event title"
        className={INPUT}
      />
      <div className="mt-3 flex items-center gap-2">
        <Repeat className="h-4 w-4 shrink-0 text-muted-foreground" />
        <select value={freq} onChange={(e) => setFreq(e.target.value as RepeatFreq | '')}
                aria-label="Repeat" className={INPUT}>
          {FREQS.map((f) => (
            <option key={f.value} value={f.value}>{f.value === 'weekly'
              ? `Weekly on ${range.start.toLocaleDateString([], { weekday: 'long' })}` : f.label}</option>
          ))}
        </select>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={saving || !title.trim()}>
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </Sheet>
  );
}

const timeOf = (v: string | null | undefined) => {
  const d = v ? parseWallClock(v) : null;
  return d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
};

/**
 * Tapping one occurrence of a recurring event (UX doc: "this one or all of
 * them", the way Google does). One-offs never come here — they open their
 * note directly.
 */
export function OccurrenceSheet({ event, onClose, onChanged, onOpenNote }: {
  event: NoteMeta | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenNote: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (event) {
      setEditing(false);
      setStart(timeOf(event.fields?.start));
      setEnd(timeOf(event.fields?.end));
      setError(null);
    }
  }, [event]);

  if (!event || !event.fields || !event.occurrence) return null;
  const f = event.fields;
  const occ = event.occurrence;
  const allDay = f.allDay;

  const patch = (fields: NoteFieldsPatch) => {
    setBusy(true);
    setError(null);
    api
      .updateNote(event.title, { fields })
      .then(() => {
        onChanged();
        onClose();
      })
      .catch((err) => setError(errMessage(err)))
      .finally(() => setBusy(false));
  };

  const withException = (entry: OccurrenceException) => [
    ...f.exceptions.filter((e) => e.date !== occ),
    entry,
  ];

  const cancelThisOne = () => patch({ exceptions: withException({ date: occ, cancelled: true }) });

  const saveThisOne = () => {
    if (!start) return;
    patch({ exceptions: withException({ date: occ, start: `${occ}T${start}`,
                                          ...(end ? { end: `${occ}T${end}` } : {}) }) });
  };

  // "All of them": the series keeps its first date; only time of day changes.
  const saveAll = async () => {
    if (!start) return;
    setBusy(true);
    try {
      const series = await api.getNote(event.title);
      const first = series.fields?.start ? parseWallClock(series.fields.start) : null;
      if (!first) throw new Error('the series has no start');
      const day = isoDay(first);
      patch({ start: `${day}T${start}`, ...(end ? { end: `${day}T${end}` } : { end: '' }) });
    } catch (err) {
      setError(errMessage(err));
      setBusy(false);
    }
  };

  return (
    <Sheet open label={event.title} onClose={onClose}>
      <p className="text-base font-semibold">{event.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{formatEventRange(f)}</p>
      {f.repeat && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Repeat className="h-3.5 w-3.5" /> {describeRepeat(f.repeat)}
          {event.moved && ' · this one moved'}
        </p>
      )}
      {editing && !allDay ? (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted-foreground">Starts
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={INPUT} />
            </label>
            <label className="text-xs text-muted-foreground">Ends
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={INPUT} />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">Change this one, or all of them?</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Back</Button>
            <Button variant="secondary" onClick={saveThisOne} disabled={busy || !start}>This one</Button>
            <Button onClick={() => void saveAll()} disabled={busy || !start}>All of them</Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="secondary" onClick={() => { onClose(); onOpenNote(event.title); }}>
            Open the note
          </Button>
          {!allDay && (
            <Button variant="secondary" onClick={() => setEditing(true)}>Change the time…</Button>
          )}
          <Button variant="ghost" className="text-destructive" onClick={cancelThisOne} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Cancel this one ({parseWallClock(occ)?.toLocaleDateString([], { month: 'short', day: 'numeric' })})
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </Sheet>
  );
}
