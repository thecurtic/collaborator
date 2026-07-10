import {
  AlertTriangle,
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
import type { NoteDraft } from '@/domain/models';
import { getDraftOrigin } from './draftOrigins';
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
  onOpenNote,
  onOpenTurn,
}: {
  draft: NoteDraft;
  onBack: () => void;
  onDecided: (id: number, notice: string) => void;
  onOpenNote: (title: string) => void;
  onOpenTurn: (turnId: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [tagsText, setTagsText] = useState(draft.tags.join(', '));
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    title !== draft.title ||
    body !== draft.body ||
    tagsText !== draft.tags.join(', ');

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
        });
      }
      const { filename } = await api.approveDraft(draft.id);
      onDecided(draft.id, `Approved — saved to vault as “${filename}”`);
    } catch (err) {
      // 422 invalid title / 409 collision: stay pending; drop into edit mode
      // so the title can be fixed and re-approved.
      setError(errMessage(err));
      setEditing(true);
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setBusy('reject');
    setError(null);
    try {
      await api.rejectDraft(draft.id);
      onDecided(draft.id, `Rejected “${draft.title}”`);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // Server attribution first (synthesis drafts); chat-proposed drafts fall
  // back to the client-side origin recorded when the proposal streamed.
  const sourceTurn =
    draft.sourceTurns[0] ?? getDraftOrigin(draft.id) ?? draft.treeRootId;
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
            <NoteBody body={body} onOpenNote={onOpenNote} />
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
            onClick={() => void reject()}
            className="flex-1 gap-1.5"
          >
            {busy === 'reject' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
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

  if (selected) {
    return (
      <DraftView
        draft={selected}
        onBack={() => setSelectedId(null)}
        onDecided={(id, msg) => {
          setDrafts((prev) => prev?.filter((d) => d.id !== id) ?? null);
          setSelectedId(null);
          setNotice(msg);
          onChanged();
        }}
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
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                      {d.body}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      {d.duplicateOf.length > 0 && (
                        <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700">
                          <AlertTriangle className="h-3 w-3" />
                          possible duplicate
                        </span>
                      )}
                      {d.tags.slice(0, 4).map((t) => (
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
