import {
  Check,
  ChevronLeft,
  Inbox,
  Loader2,
  MessageSquare,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Note, NoteFieldsPatch, NoteMeta } from '@/domain/models';
import { categoryOf, NOTE_CATEGORIES } from './categories';
import {
  draftToPatch,
  FieldsEditor,
  fieldsToDraft,
  FieldsSummary,
  type FieldsDraft,
} from './FieldsEditor';
import { CalendarView } from './CalendarView';
import { GraphView } from './GraphView';
import { InboxView } from './InboxView';
import { PeopleView } from './PeopleView';
import { ProfileView } from './ProfileView';
import { ProjectsView } from './ProjectsView';
import { StateListView } from './StateListView';
import { invalidateTagVocabulary } from './tags';
import { TagAssist } from './TagAssist';
import { NoteBody } from './NoteBody';

/** Which screen the Notes tab is showing. */
type Screen =
  | { kind: 'list' }
  | { kind: 'note'; title: string }
  | { kind: 'inbox'; runId: string | null }
  | { kind: 'graph' };

interface NotesViewProps {
  pendingCount: number;
  /** Deep link into the inbox (bump nonce to re-trigger with a new runId). */
  inboxRequest: { runId: string | null; nonce: number } | null;
  /** Refresh the app-level pending-drafts badge. */
  onBadgeRefresh: () => void;
  /** Jump to a turn in the conversation (source links). */
  onOpenTurn: (turnId: number) => void;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

function NoteScreen({
  title,
  onBack,
  onOpenNote,
  onOpenTurn,
  onRetitle,
  onDeleted,
}: {
  title: string;
  onBack: () => void;
  onOpenNote: (title: string) => void;
  onOpenTurn: (turnId: number) => void;
  /** A rename went through — repoint this screen at the new title. */
  onRetitle: (newTitle: string) => void;
  /** The note was deleted — leave this screen and update the list. */
  onDeleted: (title: string, unresolvedIn: string[]) => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Edit mode (approved notes are editable since backend aa86110). `fields0`
  // is the entry snapshot — draftToPatch diffs against it on save (1f18a9b).
  const [draft, setDraft] = useState<{
    title: string;
    body: string;
    tagsText: string;
    fields: FieldsDraft;
    fields0: FieldsDraft;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Which title the current `note` belongs to — after a rename we repoint the
  // screen without refetching (the PATCH response is fresher, and a refetch
  // would wipe the links-rewritten notice).
  const loadedTitle = useRef<string | null>(null);

  useEffect(() => {
    if (loadedTitle.current === title) return;
    let cancelled = false;
    setNote(null);
    setError(null);
    setDraft(null);
    setNotice(null);
    api
      .getNote(title)
      .then((n) => {
        if (!cancelled) {
          loadedTitle.current = title;
          setNote(n);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(errMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [title]);

  const save = async () => {
    if (!note || !draft) return;
    // Send only what changed (all PATCH fields are optional).
    const tags = draft.tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const patch: {
      title?: string;
      body?: string;
      tags?: string[];
      fields?: NoteFieldsPatch;
    } = {};
    if (draft.title.trim() !== note.title) patch.title = draft.title.trim();
    if (draft.body !== note.body) patch.body = draft.body;
    if (tags.join(',') !== note.tags.join(',')) patch.tags = tags;
    const fieldsPatch = draftToPatch(draft.fields, draft.fields0);
    if (fieldsPatch) patch.fields = fieldsPatch;
    if (Object.keys(patch).length === 0) {
      setDraft(null);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.updateNote(note.title, patch);
      loadedTitle.current = res.note.title;
      invalidateTagVocabulary(); // edited tags may extend the global set
      setNote(res.note);
      setDraft(null);
      if (res.linksRewritten.length > 0) {
        setNotice(
          `Also updated ${res.linksRewritten.length} linking ${
            res.linksRewritten.length === 1 ? 'note' : 'notes'
          }: ${res.linksRewritten.join(', ')}`,
        );
      }
      if (res.renamed) onRetitle(res.note.title);
    } catch (err) {
      // 409 collision / 422 invalid title — keep editing so it can be fixed.
      setSaveError(errMessage(err));
    } finally {
      setSaving(false);
    }
  };

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
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h2>
        {note && !draft && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete note"
            title={
              note.title === 'USER'
                ? 'Delete USER — resets the profile hub (re-scaffolds empty on next reindex)'
                : 'Delete this note (links to it become unresolved)'
            }
            onClick={() => {
              // House style: no confirm; the list restores via reload if the
              // call fails.
              api.deleteNote(note.title).then(
                (res) => onDeleted(note.title, res.linksNowUnresolvedIn),
                (err: unknown) => setError(errMessage(err)),
              );
            }}
            className="h-8 w-8 text-destructive/70 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
        {note && !draft && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Edit note"
            title="Edit note"
            onClick={() => {
              const f = fieldsToDraft(
                categoryOf(note.tags)?.tag ?? null,
                note.fields,
                note.title === 'USER',
              );
              setDraft({
                title: note.title,
                body: note.body,
                tagsText: note.tags.join(', '),
                fields: f,
                fields0: f,
              });
            }}
            className="h-8 w-8 text-muted-foreground"
          >
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        {draft && (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Cancel edit"
              onClick={() => {
                setDraft(null);
                setSaveError(null);
              }}
              disabled={saving}
              className="h-8 w-8 text-muted-foreground"
            >
              <X className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={saving || !draft.title.trim()}
              className="h-8 gap-1.5 px-2.5"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Save
            </Button>
          </>
        )}
      </div>
      {draft && note ? (
        // Edit mode fills the screen (body textarea takes the remainder).
        <div className="min-h-0 flex-1">
          <div className="mx-auto flex h-full max-w-3xl flex-col gap-2 px-4 py-3">
            {saveError && <p className="text-xs text-destructive">{saveError}</p>}
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              aria-label="Note title"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-base font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
            />
            <input
              value={draft.tagsText}
              onChange={(e) => setDraft({ ...draft, tagsText: e.target.value })}
              placeholder="tags, comma, separated"
              aria-label="Tags"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <TagAssist
              tagsText={draft.tagsText}
              originalTags={note.tags}
              onComplete={(t) => setDraft({ ...draft, tagsText: t })}
            />
            <FieldsEditor
              category={categoryOf(note.tags)?.tag ?? null}
              draft={draft.fields}
              onChange={(fields) => setDraft({ ...draft, fields })}
              isUserHub={note.title === 'USER'}
            />
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              aria-label="Note body"
              className="min-h-0 w-full flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Renaming is safe — notes that link here get their links rewritten
              automatically.
            </p>
          </div>
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-4 py-4">
          {error ? (
            <p className="text-sm text-destructive">
              {error} — the note may have been renamed in Obsidian; try a
              reindex from the notes list.
            </p>
          ) : note === null ? (
            <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading note…
            </div>
          ) : (
            <>
              {notice && (
                <p className="mb-3 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
                  {notice}
                </p>
              )}
              {note.tags.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {note.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded bg-accent px-1.5 py-0.5 text-xs text-accent-foreground"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <FieldsSummary
                category={categoryOf(note.tags)?.tag ?? null}
                fields={note.fields}
                onOpenNote={onOpenNote}
                onStateChange={(next) => {
                  // Optimistic per house style; resync on failure.
                  setNote((n) =>
                    n?.fields ? { ...n, fields: { ...n.fields, state: next } } : n,
                  );
                  api
                    .updateNote(note.title, { fields: { state: next } })
                    .catch((err) => {
                      setNotice(null);
                      setSaveError(errMessage(err));
                      loadedTitle.current = null; // force refetch on next render
                      api
                        .getNote(note.title)
                        .then((n) => {
                          loadedTitle.current = note.title;
                          setNote(n);
                        })
                        .catch(() => {});
                    });
                }}
              />
              <NoteBody body={note.body} onOpenNote={onOpenNote} />
              {note.backlinks.length > 0 && (
                <div className="mt-6 border-t border-border pt-3">
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Linked from
                  </p>
                  <ul className="space-y-1">
                    {note.backlinks.map((b) => (
                      <li key={b}>
                        <button
                          type="button"
                          onClick={() => onOpenNote(b)}
                          className="text-sm text-primary underline-offset-2 hover:underline"
                        >
                          {b}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {note.sourceTurns.length > 0 && (
                <div className="mt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenTurn(note.sourceTurns[0])}
                    className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    View source conversation
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

/** The Notes tab: vault browser (search/list/read) with the drafts inbox nested. */
export function NotesView({
  pendingCount,
  inboxRequest,
  onBadgeRefresh,
  onOpenTurn,
}: NotesViewProps) {
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'semantic' | 'keyword'>('semantic');
  // Reserved-category chip (5b3e491): null = all notes.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexNotice, setReindexNotice] = useState<string | null>(null);
  const searchSeq = useRef(0);

  // Deep link from the app (synthesis banner / chat proposal chip).
  useEffect(() => {
    if (inboxRequest) setScreen({ kind: 'inbox', runId: inboxRequest.runId });
  }, [inboxRequest]);

  // Load the full list, or search (debounced) when there's a query.
  useEffect(() => {
    const seq = ++searchSeq.current;
    const q = query.trim();
    const run = async () => {
      setError(null);
      try {
        const result = q
          ? await api.searchNotes(q, mode, 20, tagFilter ?? undefined)
          : await api.listNotes(tagFilter ?? undefined);
        if (searchSeq.current === seq) setNotes(result);
      } catch (err) {
        if (searchSeq.current === seq) {
          setError(errMessage(err));
          setNotes([]);
        }
      }
    };
    if (!q) {
      void run();
      return;
    }
    const t = setTimeout(() => void run(), 300);
    return () => clearTimeout(t);
  }, [query, mode, tagFilter]);

  // Fresh full list (used after a reindex; also clears any active search).
  const reload = useCallback(() => {
    searchSeq.current++;
    setQuery('');
    setTagFilter(null);
    void (async () => {
      try {
        setNotes(await api.listNotes());
      } catch (err) {
        setError(errMessage(err));
      }
    })();
  }, []);

  const reindex = async () => {
    setReindexing(true);
    setReindexNotice(null);
    try {
      const r = await api.reindexNotes();
      setReindexNotice(
        `Reindexed: +${r.added} · ~${r.updated} · −${r.removed} (${r.total} notes)`,
      );
      reload();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setReindexing(false);
    }
  };

  const openNote = (title: string) => setScreen({ kind: 'note', title });

  if (screen.kind === 'inbox') {
    return (
      <InboxView
        runId={screen.runId}
        onBack={() => setScreen({ kind: 'list' })}
        onClearFilter={() => setScreen({ kind: 'inbox', runId: null })}
        onChanged={onBadgeRefresh}
        onOpenNote={openNote}
        onOpenTurn={onOpenTurn}
      />
    );
  }

  if (screen.kind === 'note') {
    return (
      <NoteScreen
        title={screen.title}
        onBack={() => setScreen({ kind: 'list' })}
        onOpenNote={openNote}
        onOpenTurn={onOpenTurn}
        onRetitle={(t) => setScreen({ kind: 'note', title: t })}
        onDeleted={(t, unresolvedIn) => {
          setNotes((prev) => prev?.filter((n) => n.title !== t) ?? prev);
          setScreen({ kind: 'list' });
          setReindexNotice(
            unresolvedIn.length > 0
              ? `Deleted “${t}” — ${unresolvedIn.length} linking ${
                  unresolvedIn.length === 1 ? 'note now has' : 'notes now have'
                } unresolved links`
              : `Deleted “${t}”`,
          );
        }}
      />
    );
  }

  if (screen.kind === 'graph') {
    return (
      <GraphView
        onClose={() => setScreen({ kind: 'list' })}
        onOpenNote={openNote}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-2xl font-semibold">Mind</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Graph View"
            title="Graph View — the vault as a network"
            onClick={() => setScreen({ kind: 'graph' })}
            className="h-8 w-8 text-muted-foreground"
          >
            <Waypoints className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Reindex vault"
            title="Reindex (after external Obsidian edits)"
            onClick={() => void reindex()}
            disabled={reindexing}
            className="h-8 w-8 text-muted-foreground"
          >
            <RefreshCw className={cn('h-4 w-4', reindexing && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setScreen({ kind: 'inbox', runId: null })}
            className="relative h-8 gap-1.5 px-2.5"
          >
            <Inbox className="h-4 w-4" />
            Inbox
            {pendingCount > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                {pendingCount}
              </span>
            )}
          </Button>
        </div>
      </div>

      <div className="border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notes…"
              className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
            />
          </div>
          {query.trim() && (
            <button
              type="button"
              onClick={() =>
                setMode((m) => (m === 'semantic' ? 'keyword' : 'semantic'))
              }
              title="Toggle search mode"
              className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {mode}
            </button>
          )}
        </div>
        {/* Category chips (reserved extended-cognition tags, 5b3e491).
            A chip alone browses the category; with a query it scopes search. */}
        <div className="-mx-1 mt-2 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            onClick={() => setTagFilter(null)}
            className={cn(
              'shrink-0 rounded-full border px-2.5 py-1 text-xs',
              tagFilter === null
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            All
          </button>
          {NOTE_CATEGORIES.map((c) => (
            <button
              key={c.tag}
              type="button"
              onClick={() =>
                setTagFilter((t) => (t === c.tag ? null : c.tag))
              }
              className={cn(
                'shrink-0 rounded-full border px-2.5 py-1 text-xs',
                tagFilter === c.tag
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        {reindexNotice && (
          <p className="mt-1.5 text-xs text-muted-foreground">{reindexNotice}</p>
        )}
      </div>

      {/* Typed surfaces (1f18a9b): with a category chip active and no query,
          the chip IS the view — calendar, goals, people, profile… A typed
          query drops back to the scoped flat search list below. */}
      {!query.trim() && tagFilter === 'event' ? (
        <div className="min-h-0 flex-1">
          <CalendarView onOpenNote={openNote} />
        </div>
      ) : !query.trim() && tagFilter === 'project' ? (
        <div className="min-h-0 flex-1">
          <ProjectsView onOpenNote={openNote} />
        </div>
      ) : !query.trim() &&
        (tagFilter === 'goal' || tagFilter === 'question') ? (
        <div className="min-h-0 flex-1">
          <StateListView category={tagFilter} onOpenNote={openNote} />
        </div>
      ) : !query.trim() && tagFilter === 'social-graph' ? (
        <div className="min-h-0 flex-1">
          <PeopleView onOpenNote={openNote} />
        </div>
      ) : !query.trim() && tagFilter === 'user-profile' ? (
        <div className="min-h-0 flex-1">
          <ProfileView onOpenNote={openNote} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {error && (
          <p className="px-4 py-3 text-sm text-destructive">{error}</p>
        )}
        {notes === null ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading notes…
          </div>
        ) : notes.length === 0 && !error ? (
          <div className="py-16 text-center text-muted-foreground">
            <p className="text-lg font-medium text-foreground">
              {query.trim() ? 'No matches' : 'No notes yet'}
            </p>
            <p className="mt-1 text-sm">
              {query.trim()
                ? 'Try the other search mode, or fewer words.'
                : 'Approve drafts from the inbox to grow your vault.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {notes.map((n) => (
              <li key={n.filename}>
                <button
                  type="button"
                  onClick={() => openNote(n.title)}
                  className="flex w-full flex-col gap-0.5 px-4 py-3 text-left hover:bg-muted/60 active:bg-muted"
                >
                  <span className="truncate text-sm font-medium text-foreground">
                    {n.title}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {n.created && <span>{n.created}</span>}
                    {n.tags.slice(0, 4).map((t) => (
                      <span
                        key={t}
                        className="rounded bg-accent px-1 py-px text-[10px] text-accent-foreground"
                      >
                        {t}
                      </span>
                    ))}
                    {n.score != null && (
                      <span className="ml-auto tabular-nums">
                        {Math.round(n.score * 100)}%
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      )}
    </div>
  );
}
