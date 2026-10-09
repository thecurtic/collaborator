import {
  CircleHelp,
  FolderKanban,
  Loader2,
  Target,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { cn } from '@/lib/utils';
import type { NoteFields, NoteMeta } from '@/domain/models';
import { CATEGORY_STATES } from './categories';
import { parseWallClock } from './eventFields';
import { StateChip } from './StateChip';

type StateCategory = 'goal' | 'question' | 'project';

/**
 * Section order per category: CATEGORY_STATES order, but active states pulled
 * ahead of 'proposed' so the list leads with what's in motion.
 */
const SECTION_ORDER: Record<StateCategory, string[]> = {
  goal: ['started', 'proposed', 'finished', 'discarded'],
  question: ['open', 'answered'],
  project: ['started', 'proposed', 'paused', 'done', 'abandoned'],
};

/** States that end a note's lifecycle — collapsed behind a toggle by default. */
const TERMINAL_STATES = new Set([
  'finished',
  'discarded',
  'done',
  'abandoned',
  'answered',
]);

const CATEGORY_UI: Record<
  StateCategory,
  { icon: LucideIcon; emptyTitle: string; emptyHint: string }
> = {
  goal: {
    icon: Target,
    emptyTitle: 'No goals yet',
    emptyHint: "Say 'I want to…' in a chat and approve the draft.",
  },
  question: {
    icon: CircleHelp,
    emptyTitle: 'No questions yet',
    emptyHint: "Raise something unresolved in a chat and approve the draft.",
  },
  project: {
    icon: FolderKanban,
    emptyTitle: 'No projects yet',
    emptyHint: "Describe what you're building in a chat and approve the draft.",
  },
};

/** Baseline for optimistically setting `state` on a note with no fields yet. */
const EMPTY_FIELDS: NoteFields = {
  start: null,
  end: null,
  allDay: false,
  location: null,
  people: [],
  state: null,
  due: null,
  aliases: [],
  kind: null,
  relation: null,
  birthday: null,
  area: null,
  name: null,
  dob: null,
  residesIn: null,
  timezone: null,
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** "Aug 15" (year appended when it isn't this year). Wall-clock parse — never
 *  `new Date('YYYY-MM-DD')`, which reads as UTC and day-shifts west of GMT. */
function fmtDue(due: string): string {
  const d = parseWallClock(due);
  if (!d) return due;
  const withYear = d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** Strictly before today (local) — due today is not overdue. */
function isOverdue(due: string): boolean {
  const d = parseWallClock(due);
  if (!d) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime() < today.getTime();
}

/**
 * Kanban-flavored list for the stateful categories (goal/question/project):
 * one component, three vocabularies (CATEGORY_STATES). Rows group into
 * sections by `fields.state`, terminal sections fold away, and the StateChip
 * moves a row between sections optimistically (PATCH in the background;
 * failure resyncs from the server — no rollback bookkeeping). Renders inside
 * NotesView's list area, below the search bar and category chips.
 */
export function StateListView({
  category,
  onOpenNote,
}: {
  category: StateCategory;
  onOpenNote: (title: string) => void;
}) {
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed state PATCH — kept separate so the resync doesn't clear it.
  const [patchError, setPatchError] = useState<string | null>(null);
  // Terminal sections the user opened (keyed by state value).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const rows = await api.listNotes(category);
      if (loadSeq.current === seq) {
        setNotes(rows);
        setError(null);
      }
    } catch (err) {
      if (loadSeq.current === seq) {
        setError(errMessage(err));
        setNotes([]);
      }
    }
  }, [category]);

  useEffect(() => {
    setNotes(null);
    setError(null);
    setPatchError(null);
    setExpanded({});
    void load();
  }, [load]);

  const changeState = (title: string, next: string) => {
    setPatchError(null);
    // Optimistic: the row moves to its new section immediately.
    setNotes((prev) =>
      prev
        ? prev.map((n) =>
            n.title === title
              ? { ...n, fields: { ...(n.fields ?? EMPTY_FIELDS), state: next } }
              : n,
          )
        : prev,
    );
    api.updateNote(title, { fields: { state: next } }).catch((err) => {
      setPatchError(`Couldn't update “${title}”: ${errMessage(err)}`);
      void load(); // resync from the server rather than rolling back locally
    });
  };

  const vocab = CATEGORY_STATES[category];
  const order = SECTION_ORDER[category];
  const ui = CATEGORY_UI[category];
  const Icon = ui.icon;

  // Group rows by state; null/unknown = the vocabulary's first value.
  const grouped = new Map<string, NoteMeta[]>(order.map((s) => [s, []]));
  for (const n of notes ?? []) {
    const s = n.fields?.state;
    grouped.get(s && vocab.includes(s) ? s : vocab[0])?.push(n);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {(error ?? patchError) && (
          <p className="px-4 py-3 text-sm text-destructive">
            {error ?? patchError}
          </p>
        )}
        {notes === null ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : notes.length === 0 && !error ? (
          <div className="py-16 text-center text-muted-foreground">
            <Icon className="mx-auto mb-3 h-8 w-8 opacity-40" />
            <p className="text-lg font-medium text-foreground">
              {ui.emptyTitle}
            </p>
            <p className="mt-1 px-8 text-sm">{ui.emptyHint}</p>
          </div>
        ) : (
          order.map((state) => {
            const rows = grouped.get(state) ?? [];
            if (rows.length === 0) return null;
            const terminal = TERMINAL_STATES.has(state);
            if (terminal && !expanded[state]) {
              return (
                <div key={state} className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((e) => ({ ...e, [state]: true }))
                    }
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Show {rows.length} {state}
                  </button>
                </div>
              );
            }
            return (
              <section key={state}>
                <div className="flex items-baseline justify-between px-4 pb-1 pt-4">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {state}
                  </h3>
                  {terminal && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((e) => ({ ...e, [state]: false }))
                      }
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Hide
                    </button>
                  )}
                </div>
                <ul className="divide-y divide-border">
                  {rows.map((n) => (
                    <li
                      key={n.filename}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-muted/60"
                    >
                      <button
                        type="button"
                        onClick={() => onOpenNote(n.title)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="block truncate text-sm font-medium text-foreground">
                          {n.title}
                        </span>
                        {category === 'goal' && n.fields?.due && (
                          <span
                            className={cn(
                              'block text-xs',
                              isOverdue(n.fields.due) && !terminal
                                ? 'text-destructive'
                                : 'text-muted-foreground',
                            )}
                          >
                            due {fmtDue(n.fields.due)}
                          </span>
                        )}
                      </button>
                      <StateChip
                        category={category}
                        state={n.fields?.state ?? null}
                        onChange={(next) => changeState(n.title, next)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
