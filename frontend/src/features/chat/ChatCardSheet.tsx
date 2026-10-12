import { Loader2, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import type { ChatCard } from '@/domain/models';
import { TagAssist } from '@/features/notes/TagAssist';
import { globalTagVocabulary, nearMissTags } from '@/features/notes/tags';
import { useModalA11y } from '@/lib/useModalA11y';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** Same normalization the backend applies (lowercase-hyphenated). */
function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  const [draft, setDraft] = useState('');
  const [noteVocab, setNoteVocab] = useState<string[]>([]);
  // A new tag that's a near-miss of an existing one asks before it's saved.
  const [nearMiss, setNearMiss] = useState<
    { tag: string; existing: string[] } | null
  >(null);

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
    setDraft('');
    setNearMiss(null);
    setError(null);
    void globalTagVocabulary().then((v) => {
      if (!cancelled) setNoteVocab(v);
    });
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

  const tags = card?.tags ?? [];
  const proposals = useMemo(
    () => (card?.summary?.proposedTags ?? []).filter((t) => !tags.includes(t)),
    [card, tags],
  );

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

  const addTags = (added: string[]) => {
    const fresh = [...new Set(added)].filter((t) => t && !tags.includes(t));
    if (fresh.length) saveTags([...tags, ...fresh]);
  };

  const addDraft = () => {
    const added = draft.split(',').map(normalizeTag).filter(Boolean);
    if (!added.length) return;
    const vocab = [...new Set([...noteVocab, ...vocabulary])];
    for (const t of added) {
      if (vocab.includes(t) || tags.includes(t)) continue;
      const near = nearMissTags(t, vocab);
      if (near.length) {
        setNearMiss({ tag: t, existing: near });
        return;
      }
    }
    setDraft('');
    addTags(added);
  };

  /** Resolve the near-miss question: `use` replaces the new tag (or keeps it). */
  const resolveNearMiss = (use: string) => {
    if (!nearMiss) return;
    const added = draft
      .split(',')
      .map(normalizeTag)
      .filter(Boolean)
      .map((t) => (t === nearMiss.tag ? use : t));
    setNearMiss(null);
    setDraft('');
    addTags(added);
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
        <div className="mb-2 flex flex-wrap gap-1.5">
          {tags.length === 0 && (
            <span className="text-xs italic text-muted-foreground">
              No tags yet
            </span>
          )}
          {tags.map((t) => (
            <span
              key={t}
              className="flex items-center gap-1 rounded-full bg-accent py-0.5 pl-2.5 pr-1 text-xs text-accent-foreground"
            >
              {t}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                onClick={() => saveTags(tags.filter((x) => x !== t))}
                className="rounded-full p-0.5 hover:bg-background/60"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>

        {proposals.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Suggested:</span>
            {proposals.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => saveTags([...tags, t])}
                className="flex items-center gap-0.5 rounded-full border border-dashed border-primary/50 px-2 py-0.5 text-xs text-primary hover:bg-primary/5"
              >
                <Plus className="h-3 w-3" />
                {t}
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setNearMiss(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addDraft();
            }}
            disabled={!card}
            placeholder="Add tags, comma-separated"
            aria-label="Add tags"
            className="min-h-[2.25rem] flex-1 rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          />
          <Button onClick={addDraft} disabled={!card || !draft.trim()}>
            Add
          </Button>
        </div>
        {nearMiss && (
          <div className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800">
            <p>
              Did you mean{' '}
              {nearMiss.existing.map((e) => `“${e}”`).join(' or ')} instead of
              “{nearMiss.tag}”?
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {nearMiss.existing.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => resolveNearMiss(e)}
                  className="rounded-full bg-amber-500/20 px-2 py-0.5 font-medium hover:bg-amber-500/30"
                >
                  Use {e}
                </button>
              ))}
              <button
                type="button"
                onClick={() => resolveNearMiss(nearMiss.tag)}
                className="rounded-full px-2 py-0.5 hover:bg-amber-500/20"
              >
                Keep {nearMiss.tag}
              </button>
            </div>
          </div>
        )}
        <div className="mt-1.5">
          <TagAssist
            tagsText={draft}
            originalTags={tags}
            onComplete={(next) => setDraft(next)}
            extraVocab={vocabulary}
          />
        </div>

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}
