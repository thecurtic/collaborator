import {
  ChevronLeft,
  Inbox,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Note, NoteMeta } from '@/domain/models';
import { InboxView } from './InboxView';
import { NoteBody } from './NoteBody';

/** Which screen the Notes tab is showing. */
type Screen =
  | { kind: 'list' }
  | { kind: 'note'; title: string }
  | { kind: 'inbox'; runId: string | null };

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
}: {
  title: string;
  onBack: () => void;
  onOpenNote: (title: string) => void;
  onOpenTurn: (turnId: number) => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNote(null);
    setError(null);
    api
      .getNote(title)
      .then((n) => {
        if (!cancelled) setNote(n);
      })
      .catch((err) => {
        if (!cancelled) setError(errMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [title]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to notes"
          onClick={onBack}
          className="h-8 w-8"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
      </div>
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
          ? await api.searchNotes(q, mode)
          : await api.listNotes();
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
  }, [query, mode]);

  // Fresh full list (used after a reindex; also clears any active search).
  const reload = useCallback(() => {
    searchSeq.current++;
    setQuery('');
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
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold">Notes</h2>
        <div className="flex items-center gap-1">
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
        {reindexNotice && (
          <p className="mt-1.5 text-xs text-muted-foreground">{reindexNotice}</p>
        )}
      </div>

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
    </div>
  );
}
