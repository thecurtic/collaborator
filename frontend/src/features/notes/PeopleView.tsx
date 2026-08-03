import { Building2, Cake, Loader2, User, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import type { NoteMeta } from '@/domain/models';
import { parseWallClock } from './eventFields';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Birthdays are 'YYYY-MM-DD' or 'MM-DD' (year unknown). */
const MONTH_DAY = /^(\d{1,2})-(\d{1,2})$/;

/** Month/day (0-based month) of a birthday value, or null if unparseable. */
function birthdayMonthDay(
  value: string,
): { month: number; day: number } | null {
  const md = MONTH_DAY.exec(value);
  if (md) return { month: Number(md[1]) - 1, day: Number(md[2]) };
  const d = parseWallClock(value);
  return d ? { month: d.getMonth(), day: d.getDate() } : null;
}

/** The next occurrence of a birthday on/after `today` (local midnight). */
function nextBirthday(value: string, today: Date): Date | null {
  const md = birthdayMonthDay(value);
  if (!md) return null;
  const next = new Date(today.getFullYear(), md.month, md.day);
  return next < today
    ? new Date(today.getFullYear() + 1, md.month, md.day)
    : next;
}

interface UpcomingBirthday {
  title: string;
  date: Date;
  daysAway: number;
}

/** People (not orgs) with a birthday in the next 30 days, soonest first. */
function upcomingBirthdays(
  notes: NoteMeta[],
  now = new Date(),
): UpcomingBirthday[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out: UpcomingBirthday[] = [];
  for (const n of notes) {
    if (n.fields?.kind === 'org') continue;
    const bday = n.fields?.birthday;
    if (!bday) continue;
    const date = nextBirthday(bday, today);
    if (!date) continue;
    const daysAway = Math.round(
      (date.getTime() - today.getTime()) / 86_400_000,
    );
    if (daysAway <= 30) out.push({ title: n.title, date, daysAway });
  }
  return out.sort(
    (a, b) => a.daysAway - b.daysAway || a.title.localeCompare(b.title),
  );
}

function PersonRow({
  note,
  onOpenNote,
}: {
  note: NoteMeta;
  onOpenNote: (title: string) => void;
}) {
  const isOrg = note.fields?.kind === 'org';
  const Icon = isOrg ? Building2 : User;
  const relation = note.fields?.relation ?? null;
  const aliases = note.fields?.aliases ?? [];
  return (
    <button
      type="button"
      onClick={() => onOpenNote(note.title)}
      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/60 active:bg-muted"
    >
      <Icon className="h-4 w-4 shrink-0 text-primary/70" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">
            {note.title}
          </span>
          {aliases.length > 0 && (
            <span className="truncate text-xs text-muted-foreground">
              aka {aliases.join(', ')}
            </span>
          )}
        </span>
        {relation && (
          <span className="block truncate text-xs text-muted-foreground">
            {relation}
          </span>
        )}
      </span>
    </button>
  );
}

function Section({
  label,
  notes,
  onOpenNote,
}: {
  label: string;
  notes: NoteMeta[];
  onOpenNote: (title: string) => void;
}) {
  if (notes.length === 0) return null;
  return (
    <div>
      <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <ul className="divide-y divide-border">
        {notes.map((n) => (
          <li key={n.filename}>
            <PersonRow note={n} onOpenNote={onOpenNote} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Social-graph directory: upcoming-birthday pills, then People and
 * Organizations (fields.kind 'org'). Renders in the Notes list area — the
 * host owns the header, search bar, and category chips.
 */
export function PeopleView({
  onOpenNote,
}: {
  onOpenNote: (title: string) => void;
}) {
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listNotes('social-graph')
      .then((res) => {
        if (!cancelled) setNotes(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(errMessage(err));
          setNotes([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (notes === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading people…
      </div>
    );
  }

  if (notes.length === 0) {
    return (
      <>
        {error && (
          <p className="px-4 py-3 text-sm text-destructive">{error}</p>
        )}
        {!error && (
          <div className="py-16 text-center text-muted-foreground">
            <Users className="mx-auto mb-3 h-8 w-8 opacity-40" />
            <p className="text-lg font-medium text-foreground">
              No people yet
            </p>
            <p className="mt-1 px-8 text-sm">
              Mention someone in a chat and approve the draft.
            </p>
          </div>
        )}
      </>
    );
  }

  const birthdays = upcomingBirthdays(notes);
  const sorted = [...notes].sort((a, b) => a.title.localeCompare(b.title));
  const people = sorted.filter((n) => n.fields?.kind !== 'org');
  const orgs = sorted.filter((n) => n.fields?.kind === 'org');

  return (
    <div className="pb-4">
      {birthdays.length > 0 && (
        <div className="border-b border-border px-4 py-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Cake className="h-3.5 w-3.5" />
            Upcoming birthdays
          </p>
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {birthdays.map((b) => (
              <button
                key={b.title}
                type="button"
                onClick={() => onOpenNote(b.title)}
                className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {b.title} ·{' '}
                {b.date.toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                })}
              </button>
            ))}
          </div>
        </div>
      )}
      <Section label="People" notes={people} onOpenNote={onOpenNote} />
      <Section label="Organizations" notes={orgs} onOpenNote={onOpenNote} />
    </div>
  );
}
