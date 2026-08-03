import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageSquare,
  Pencil,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Note, NoteDraft } from '@/domain/models';
import { categoryOf } from './categories';
import {
  formatEventRange,
  toDateInput,
  toDateTimeLocalInput,
} from './eventFields';
import { lineDiff } from './lineDiff';
import { NoteBody } from './NoteBody';

interface InboxViewProps {
  /** Deep-link filter (one synthesis run / one chat turn), or null for all. */
  runId: string | null;
  onBack: () => void;
  onClearFilter: () => void;
  /** Called after any approve/reject so the app badge stays accurate. */
  onChanged: () => void;
  /** Open an existing vault note (duplicate comparison / wikilinks). */
  onOpenNote: (title: string) => void;
  /** Jump to a source turn in the conversation. */
  onOpenTurn: (turnId: number) => void;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/**
 * The atomic view of ONE pending draft: reads like a note (markdown, tags,
 * duplicate warnings, source link), edits behind the pencil, approve/reject
 * pinned at the bottom. Only ever one draft in edit state — by construction.
 */
function DraftView({
  draft,
  onBack,
  onDecided,
  onReject,
  onOpenNote,
  onOpenTurn,
}: {
  draft: NoteDraft;
  onBack: () => void;
  onDecided: (id: number, notice: string) => void;
  /** Optimistic reject, owned by the parent (card restore on failure). */
  onReject: () => void;
  onOpenNote: (title: string) => void;
  onOpenTurn: (turnId: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [tagsText, setTagsText] = useState(draft.tags.join(', '));
  // Event drafts (85c508c): structured times, editable during review. Input
  // values are wall-clock ISO (what datetime-local/date inputs emit) — the
  // backend validates and stamps the offset at approval.
  const ef = draft.fields;
  const [allDay, setAllDay] = useState(ef?.allDay ?? false);
  const [startText, setStartText] = useState(
    ef?.start
      ? ef.allDay
        ? toDateInput(ef.start)
        : toDateTimeLocalInput(ef.start)
      : '',
  );
  const [endText, setEndText] = useState(
    ef?.end
      ? ef.allDay
        ? toDateInput(ef.end)
        : toDateTimeLocalInput(ef.end)
      : '',
  );
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);
  // Edit drafts diff against the CURRENT note (snapshot semantics: the draft
  // holds the full proposed state, so current-vs-draft is the review).
  const isEdit = draft.kind === 'edit';
  const [target, setTarget] = useState<Note | null>(null);
  const [targetGone, setTargetGone] = useState(false);

  useEffect(() => {
    if (!isEdit || !draft.targetTitle) return;
    let cancelled = false;
    api
      .getNote(draft.targetTitle)
      .then((n) => {
        if (!cancelled) setTarget(n);
      })
      .catch(() => {
        // Deleted/renamed since the proposal — approval would 409.
        if (!cancelled) setTargetGone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isEdit, draft.targetTitle]);

  // Live field values in wall-clock form, for display and dirty-checking.
  const liveFields = ef
    ? { start: startText || null, end: endText || null, allDay }
    : null;
  const fieldsDirty =
    ef != null &&
    (allDay !== ef.allDay ||
      startText !==
        (ef.start
          ? ef.allDay
            ? toDateInput(ef.start)
            : toDateTimeLocalInput(ef.start)
          : '') ||
      endText !==
        (ef.end
          ? ef.allDay
            ? toDateInput(ef.end)
            : toDateTimeLocalInput(ef.end)
          : ''));
  const dirty =
    title !== draft.title ||
    body !== draft.body ||
    tagsText !== draft.tags.join(', ') ||
    fieldsDirty;

  const approve = async () => {
    setBusy('approve');
    setError(null);
    try {
      if (dirty) {
        await api.updateDraft(draft.id, {
          title: title.trim(),
          body,
          tags: tagsText
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          ...(fieldsDirty
            ? {
                // '' clears a key server-side (1f18a9b patch semantics).
                fields: {
                  start: startText,
                  end: endText,
                  all_day: allDay,
                },
              }
            : {}),
        });
      }
      const res = await api.approveDraft(draft.id);
      const rewrites =
        res.linksRewritten.length > 0
          ? ` (also updated ${res.linksRewritten.length} linking ${
              res.linksRewritten.length === 1 ? 'note' : 'notes'
            })`
          : '';
      onDecided(
        draft.id,
        isEdit
          ? `Approved — updated “${title.trim()}”${rewrites}`
          : `Approved — saved to vault as “${res.filename}”`,
      );
    } catch (err) {
      // 422 invalid title / 409 collision: stay pending; drop into edit mode
      // so the title can be fixed and re-approved.
      setError(errMessage(err));
      setEditing(true);
    } finally {
      setBusy(null);
    }
  };


  // Provenance is server-stamped for all draft kinds now (3275100).
  const sourceTurn = draft.sourceTurns[0] ?? draft.treeRootId;
  const tags = tagsText
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to inbox"
          onClick={onBack}
          className="h-9 w-9"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
          {editing ? 'Edit draft' : title}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={editing ? 'Done editing' : 'Edit draft'}
          title={editing ? 'Done editing' : 'Edit draft'}
          onClick={() => setEditing((e) => !e)}
          className="h-9 w-9 text-muted-foreground"
        >
          {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
        </Button>
      </div>

      {editing ? (
        // Edit mode fills the screen — the body textarea takes every
        // remaining pixel instead of floating in whitespace.
        <div className="min-h-0 flex-1">
          <div className="mx-auto flex h-full max-w-3xl flex-col gap-2 px-4 py-3">
            {error && <p className="text-xs text-destructive">{error}</p>}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Note title"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-base font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
            />
            <input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="tags, comma, separated"
              aria-label="Tags"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {/* Event times (85c508c) — native pickers; a wrong date in a
                structured field is exactly what review exists to catch. */}
            {ef && (
              <div className="space-y-2 rounded-md border border-border px-3 py-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={allDay}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setAllDay(v);
                      // date ↔ datetime-local: truncate, or default to noon.
                      const convert = (s: string) =>
                        !s ? s : v ? s.slice(0, 10) : `${s.slice(0, 10)}T12:00`;
                      setStartText(convert);
                      setEndText(convert);
                    }}
                  />
                  All day
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Starts</span>
                    <input
                      type={allDay ? 'date' : 'datetime-local'}
                      value={startText}
                      onChange={(e) => setStartText(e.target.value)}
                      aria-label="Event start"
                      className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">
                      Ends (optional)
                    </span>
                    <input
                      type={allDay ? 'date' : 'datetime-local'}
                      value={endText}
                      onChange={(e) => setEndText(e.target.value)}
                      aria-label="Event end"
                      className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                </div>
              </div>
            )}
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-label="Note body"
              className="min-h-0 w-full flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-3xl px-4 py-4">
            {draft.duplicateOf.length > 0 && (
              <div className="mb-3 space-y-1">
                {draft.duplicateOf.map((d) => (
                  <button
                    key={d.title}
                    type="button"
                    onClick={() => onOpenNote(d.title)}
                    className="flex w-full items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-left text-xs text-amber-700 hover:bg-amber-500/20"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">
                      Possible duplicate of{' '}
                      <span className="font-medium">{d.title}</span> (
                      {Math.round(d.score * 100)}%) — tap to compare
                    </span>
                  </button>
                ))}
              </div>
            )}
            {isEdit && (
              <div className="mb-3 space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  Proposes changes to{' '}
                  <button
                    type="button"
                    onClick={() =>
                      draft.targetTitle && onOpenNote(draft.targetTitle)
                    }
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {draft.targetTitle}
                  </button>
                </p>
                {draft.reason && (
                  <p className="rounded-md bg-primary/5 px-2.5 py-1.5 text-xs italic text-muted-foreground">
                    Why: {draft.reason}
                  </p>
                )}
                {targetGone && (
                  <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700">
                    The target note no longer exists (renamed or deleted since
                    the proposal) — approving will fail; consider rejecting.
                  </p>
                )}
              </div>
            )}
            {/* Event times, front and center (85c508c: "render prominently"). */}
            {liveFields?.start && (
              <div className="mb-3 flex items-center gap-2 rounded-md bg-primary/10 px-2.5 py-2 text-sm font-medium text-foreground">
                <CalendarDays className="h-4 w-4 shrink-0 text-primary" />
                {formatEventRange(liveFields)}
              </div>
            )}
            {tags.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="rounded bg-accent px-1.5 py-0.5 text-xs text-accent-foreground"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            {isEdit && target ? (
              <>
                {target.title !== title.trim() && (
                  <p className="mb-2 text-sm">
                    <span className="text-destructive line-through">
                      {target.title}
                    </span>{' '}
                    → <span className="font-medium">{title.trim()}</span>
                  </p>
                )}
                {target.tags.join(',') !== tags.join(',') && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    tags:{' '}
                    <span className="line-through opacity-60">
                      {target.tags.join(', ') || '—'}
                    </span>{' '}
                    → {tags.join(', ') || '—'}
                  </p>
                )}
                <div className="rounded-md border border-border px-3 py-2 text-sm leading-relaxed">
                  {lineDiff(target.body, body).map((l, i) => (
                    <p
                      key={i}
                      className={cn(
                        'whitespace-pre-wrap break-words',
                        l.type === 'add' &&
                          'bg-emerald-500/10 text-emerald-700',
                        l.type === 'del' &&
                          'bg-destructive/10 text-destructive line-through',
                      )}
                    >
                      {l.text || ' '}
                    </p>
                  ))}
                </div>
              </>
            ) : isEdit && !targetGone ? (
              <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading the current note for comparison…
              </div>
            ) : (
              <NoteBody body={body} onOpenNote={onOpenNote} />
            )}
            {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
            {sourceTurn != null && (
              <div className="mt-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenTurn(sourceTurn)}
                  title="Open the conversation this note came from"
                  className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  View source conversation
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Decision bar — the point of the whole screen. */}
      <div className="pb-safe border-t border-border bg-background px-4 py-3">
        <div className="mx-auto flex max-w-3xl gap-2">
          <Button
            variant="outline"
            disabled={busy != null}
            onClick={onReject}
            className="flex-1 gap-1.5"
          >
            <X className="h-4 w-4" />
            Reject
          </Button>
          <Button
            disabled={busy != null || !title.trim()}
            onClick={() => void approve()}
            className="flex-1 gap-1.5"
          >
            {busy === 'approve' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The curation gate: a LIST of pending drafts (title + preview) — tap one to
 * enter its atomic read/edit/decide view. Never more than one draft editable
 * at a time.
 */
export function InboxView({
  runId,
  onBack,
  onClearFilter,
  onChanged,
  onOpenNote,
  onOpenTurn,
}: InboxViewProps) {
  const [drafts, setDrafts] = useState<NoteDraft[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDrafts(
        await api.listDrafts({ status: 'pending', runId: runId ?? undefined }),
      );
    } catch (err) {
      setError(errMessage(err));
      setDrafts([]);
    }
  }, [runId]);

  useEffect(() => {
    setDrafts(null);
    setSelectedId(null);
    void load();
  }, [load]);

  const selected = drafts?.find((d) => d.id === selectedId) ?? null;

  // Optimistic reject: the card leaves immediately; a failure puts it back
  // where it was with a notice. (Approve stays pessimistic on purpose — its
  // 409/422 fix-and-retry flow needs the server's answer first.)
  const rejectDraft = useCallback(
    (draft: NoteDraft) => {
      const idx = drafts?.findIndex((d) => d.id === draft.id) ?? -1;
      setDrafts((prev) => prev?.filter((d) => d.id !== draft.id) ?? null);
      setSelectedId(null);
      setNotice(`Rejected “${draft.title}”`);
      onChanged();
      api.rejectDraft(draft.id).catch((err: unknown) => {
        setDrafts((prev) => {
          const next = prev ? [...prev] : [];
          next.splice(Math.min(Math.max(idx, 0), next.length), 0, draft);
          return next;
        });
        setNotice(`Couldn't reject “${draft.title}” — ${errMessage(err)}`);
        onChanged();
      });
    },
    [drafts, onChanged],
  );

  if (selected) {
    return (
      <DraftView
        key={selected.id} // fresh edit state per draft
        draft={selected}
        onBack={() => setSelectedId(null)}
        onDecided={(id, msg) => {
          setDrafts((prev) => prev?.filter((d) => d.id !== id) ?? null);
          setSelectedId(null);
          setNotice(msg);
          onChanged();
        }}
        onReject={() => rejectDraft(selected)}
        onOpenNote={onOpenNote}
        onOpenTurn={onOpenTurn}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to notes"
          onClick={onBack}
          className="h-9 w-9"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h2 className="text-2xl font-semibold">Drafts inbox</h2>
        {runId && (
          <button
            type="button"
            onClick={onClearFilter}
            className="ml-2 flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            this run only <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {notice && (
          <p className="mx-4 mt-3 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
            {notice}
          </p>
        )}
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
        {drafts === null ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading drafts…
          </div>
        ) : drafts.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground">
            <p className="text-lg font-medium text-foreground">Inbox zero</p>
            <p className="mt-1 text-sm">
              {runId
                ? 'No pending drafts from this run.'
                : 'Synthesize a conversation (or let the chat propose a note) to fill it.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {drafts.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(d.id)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/60 active:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {d.title}
                    </span>
                    {/* Event times, prominent on the card (85c508c). */}
                    {d.fields?.start && (
                      <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-primary">
                        <CalendarDays className="h-3.5 w-3.5 shrink-0" />
                        {formatEventRange(d.fields)}
                      </span>
                    )}
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                      {d.kind === 'edit' ? (d.reason ?? d.body) : d.body}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      {d.kind === 'edit' && (
                        <span className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                          <Pencil className="h-3 w-3" />
                          edit · {d.targetTitle}
                        </span>
                      )}
                      {d.duplicateOf.length > 0 && (
                        <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700">
                          <AlertTriangle className="h-3 w-3" />
                          possible duplicate
                        </span>
                      )}
                      {/* Reserved category tag → prominent badge (5b3e491);
                          remaining tags keep the plain pills. */}
                      {categoryOf(d.tags) && (
                        <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                          {categoryOf(d.tags)!.label}
                        </span>
                      )}
                      {d.tags
                        .filter((t) => t !== categoryOf(d.tags)?.tag)
                        .slice(0, 4)
                        .map((t) => (
                          <span
                            key={t}
                            className="rounded bg-accent px-1 py-px text-[10px] text-accent-foreground"
                          >
                            {t}
                          </span>
                        ))}
                    </span>
                  </span>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
