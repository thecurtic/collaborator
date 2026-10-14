import { Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import type { ChatCard } from '@/domain/models';
import { TagEditor } from '@/features/notes/TagEditor';
import { useModalA11y } from '@/lib/useModalA11y';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/**
 * The three-dots card about one chat (UX doc, Chats): a short summary made
 * on demand by the small model, and the chat's tags, editable here. The
 * summary is generated the first time the card opens and cached; once the
 * chat has grown it shows as out of date with a refresh, rather than
 * re-running on every open. Its tag proposals are offered, never applied.
 * Tag edits save immediately; a first tag promotes a seed chat.
 */
export function ChatCardSheet({
  open,
  turnId,
  label,
  vocabulary,
  onTagsSaved,
  onClose,
}: {
  open: boolean;
  /** Any turn in the chat: the active leaf inside a chat, else the root. */
  turnId: number | null;
  label: string;
  /** Tags already on chats, for completion and near-miss warnings. */
  vocabulary: string[];
  onTagsSaved: (rootId: number, tags: string[]) => void;
  onClose: () => void;
}) {
  const panelRef = useModalA11y<HTMLDivElement>(open, onClose);
  const [card, setCard] = useState<ChatCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summarize = (id: number) => {
    setSummarizing(true);
    setError(null);
    api
      .summarizeChat(id)
      .then(setCard)
      .catch((err) => setError(errMessage(err)))
      .finally(() => setSummarizing(false));
  };

  useEffect(() => {
    if (!open || turnId == null) return;
    let cancelled = false;
    setCard(null);
    setError(null);
    setLoading(true);
    api
      .getChat(turnId)
      .then((c) => {
        if (cancelled) return;
        setCard(c);
        if (!c.summary) summarize(turnId);
      })
      .catch((err) => {
        if (!cancelled) setError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, turnId]);

  if (!open) return null;

  const saveTags = (next: string[]) => {
    if (!card) return;
    const prev = card;
    setCard({ ...card, tags: next }); // optimistic
    setError(null);
    api
      .setChatTags(card.rootId, next)
      .then((c) => {
        setCard(c);
        onTagsSaved(c.rootId, c.tags);
      })
      .catch((err) => {
        setCard(prev);
        setError(errMessage(err));
      });
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`About ${label}`}
        tabIndex={-1}
        className="pb-safe relative max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card p-4 outline-none sm:max-w-md sm:rounded-2xl"
      >
        <div className="mb-3 flex items-start gap-2">
          <p className="min-w-0 flex-1 text-base font-semibold">{label}</p>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 -mt-1 h-8 w-8 shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Summary */}
        <div className="mb-4 rounded-md bg-muted/50 px-3 py-2.5 text-sm">
          {loading || (summarizing && !card?.summary) ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {loading ? 'Loading…' : 'Summarizing…'}
            </span>
          ) : card?.summary ? (
            <>
              <p className="text-foreground">{card.summary.text}</p>
              {(card.summary.stale || summarizing) && (
                <button
                  type="button"
                  disabled={summarizing}
                  onClick={() => turnId != null && summarize(turnId)}
                  className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  {summarizing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {summarizing ? 'Refreshing…' : 'Out of date — refresh'}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => turnId != null && summarize(turnId)}
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <Sparkles className="h-4 w-4" />
              Summarize this chat
            </button>
          )}
        </div>

        {/* Tags */}
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Tags
        </p>
        <TagEditor
          key={card?.rootId ?? 'none'}
          tags={card?.tags ?? []}
          onChange={saveTags}
          vocabulary={vocabulary}
          proposals={card?.summary?.proposedTags ?? []}
          disabled={!card}
        />

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}
