import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Loader2,
  MessageSquare,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import type { NoteDraft } from '@/domain/models';

interface InboxViewProps {
  /** Deep-link filter (one synthesis run / one chat turn), or null for all. */
  runId: string | null;
  onBack: () => void;
  onClearFilter: () => void;
  /** Called after any approve/reject so the app badge stays accurate. */
  onChanged: () => void;
  /** Open an existing vault note (duplicate comparison). */
  onOpenNote: (title: string) => void;
  /** Jump to a source turn in the conversation. */
  onOpenTurn: (turnId: number) => void;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

function DraftCard({
  draft,
  onDecided,
  onOpenNote,
  onOpenTurn,
}: {
  draft: NoteDraft;
  onDecided: (id: number, notice: string) => void;
  onOpenNote: (title: string) => void;
  onOpenTurn: (turnId: number) => void;
}) {
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
      // 422 = invalid title, 409 = title collision: the draft stays pending —
      // surface the backend's message and let the user edit + retry.
      setError(errMessage(err));
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

  const sourceTurn = draft.sourceTurns[0] ?? draft.treeRootId;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="Note title"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-base font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
      />

      {draft.duplicateOf.length > 0 && (
        <div className="mt-2 space-y-1">
          {draft.duplicateOf.map((d) => (
            <button
              key={d.title}
              type="button"
              onClick={() => onOpenNote(d.title)}
              className="flex w-full items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-left text-xs text-amber-700 hover:bg-amber-500/20"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                Possible duplicate of <span className="font-medium">{d.title}</span>{' '}
                ({Math.round(d.score * 100)}%) — tap to compare
              </span>
            </button>
          ))}
        </div>
      )}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        aria-label="Note body"
        className="mt-2 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <input
        value={tagsText}
        onChange={(e) => setTagsText(e.target.value)}
        placeholder="tags, comma, separated"
        aria-label="Tags"
        className="mt-2 w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <div className="mt-3 flex items-center gap-2">
        {sourceTurn != null && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenTurn(sourceTurn)}
            title="Open the conversation this note came from"
            className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Source
          </Button>
        )}
        <span className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy != null}
            onClick={() => void reject()}
            className="h-9 gap-1.5"
          >
            {busy === 'reject' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
            Reject
          </Button>
          <Button
            size="sm"
            disabled={busy != null || !title.trim()}
            onClick={() => void approve()}
            className="h-9 gap-1.5"
          >
            {busy === 'approve' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Approve
          </Button>
        </span>
      </div>
    </div>
  );
}

/**
 * The curation gate: pending drafts awaiting review. The vault only ever
 * contains approved notes — approve/reject here is the only path in.
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
    void load();
  }, [load]);

  const handleDecided = (id: number, msg: string) => {
    setDrafts((prev) => prev?.filter((d) => d.id !== id) ?? null);
    setNotice(msg);
    onChanged();
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
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-4">
          {notice && (
            <p className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
              {notice}
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
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
            drafts.map((d) => (
              <DraftCard
                key={d.id}
                draft={d}
                onDecided={handleDecided}
                onOpenNote={onOpenNote}
                onOpenTurn={onOpenTurn}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
