import {
  Check,
  Copy,
  Eye,
  EyeOff,
  FileQuestion,
  Loader2,
  MessageSquare,
  Search,
  SendHorizontal,
  ShieldAlert,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
} from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import { useLongPress } from '@/lib/useLongPress';
import { cleanUrlsInText } from '@/lib/urlClean';
import { cn, parseApiDate } from '@/lib/utils';
import type { NoteDraft, ScratchItem } from '@/domain/models';
import { categoryOf } from '@/features/notes/categories';
import { FieldsSummary } from '@/features/notes/FieldsEditor';

const PAGE = 50;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function fmtWhen(createdAt: string): string {
  const d = parseApiDate(createdAt);
  return d
    ? d.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : createdAt;
}

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-700',
  committed: 'bg-green-500/10 text-green-700',
  done: 'bg-primary/10 text-primary',
  refused: 'bg-muted text-muted-foreground',
};

/**
 * The pending card body for a scratch-born note draft (action_result kind
 * 'proposed'): title, the model's note, typed fields, approve/reject through
 * the NORMAL draft endpoints. These drafts are excluded from the inbox —
 * this card is their only home. Pending is a valid resting state; no nagging.
 */
function ProposedCard({
  item,
  onDecided,
}: {
  item: ScratchItem;
  onDecided: () => void;
}) {
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (item.status !== 'pending') return;
    let cancelled = false;
    api
      .listDrafts({ status: 'pending', runId: `scratch-${item.id}` })
      .then((drafts) => {
        if (!cancelled) setDraft(drafts[0] ?? null);
      })
      .catch(() => {
        /* the note line below still renders */
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.status]);

  const decide = async (action: 'approve' | 'reject') => {
    if (!draft) return;
    setBusy(action);
    setError(null);
    try {
      if (action === 'approve') await api.approveDraft(draft.id);
      else await api.rejectDraft(draft.id);
      onDecided(); // item status derives from the draft — refetch the list
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2">
      <p className="text-sm font-medium text-foreground">
        {item.actionResult?.draftTitle ?? draft?.title ?? 'Proposed note'}
      </p>
      {item.actionResult?.note && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {item.actionResult.note}
        </p>
      )}
      {draft && (
        <div className="mt-2">
          <FieldsSummary
            category={categoryOf(draft.tags)?.tag ?? null}
            fields={draft.fields}
          />
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {item.status === 'pending' && (
        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy != null || !draft}
            onClick={() => void decide('reject')}
            className="h-8 flex-1 gap-1"
          >
            {busy === 'reject' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
            Reject
          </Button>
          <Button
            size="sm"
            disabled={busy != null || !draft}
            onClick={() => void decide('approve')}
            className="h-8 flex-1 gap-1"
          >
            {busy === 'approve' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}

/** The action_result section of a card, by result kind. */
function ActionResult({
  item,
  onDecided,
  onStartChat,
  onOpenTranscripts,
}: {
  item: ScratchItem;
  onDecided: () => void;
  onStartChat: (draft: string) => void;
  onOpenTranscripts: () => void;
}) {
  const r = item.actionResult;
  if (!r) return null;
  switch (r.kind) {
    case 'proposed':
      return <ProposedCard item={item} onDecided={onDecided} />;
    case 'transcript':
      return (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{r.note ?? 'Transcript'}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenTranscripts}
            className="h-7 px-2 text-xs"
          >
            View transcript
          </Button>
        </div>
      );
    case 'chat_suggestion':
      return (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{r.note ?? ''}</span>
          <Button
            size="sm"
            onClick={() => onStartChat(item.content)}
            className="h-7 gap-1 px-2 text-xs"
          >
            <MessageSquare className="h-3 w-3" />
            Start chat
          </Button>
        </div>
      );
    case 'secret':
      return (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          {r.note ?? 'Looks like a secret — left untouched, never shown to the model.'}
        </p>
      );
    case 'flagged':
    case 'unsupported':
      return (
        <p className="mt-2 flex items-center gap-1.5 text-xs italic text-muted-foreground">
          <FileQuestion className="h-3.5 w-3.5 shrink-0" />
          {r.note ?? 'Left as a note.'}
        </p>
      );
    case 'error':
      return (
        <p className="mt-2 text-xs text-destructive">
          {r.note ?? 'The action failed — the note is unchanged. Hold send on it to retry.'}
        </p>
      );
    default:
      return r.note ? (
        <p className="mt-2 text-xs text-muted-foreground">{r.note}</p>
      ) : null;
  }
}

/**
 * Scratch — notes to self (7444138). Tap send = inert capture (zero model
 * contact, ever); HOLD send = capture + one-shot agent action, mirroring the
 * app-wide "hold escalates to the model" gesture. Cards render the action's
 * outcome; deletes are plain-tap per house style.
 */
export function ScratchView({
  onStartChat,
  onOpenTranscripts,
}: {
  onStartChat: (draft: string) => void;
  onOpenTranscripts: () => void;
}) {
  const [items, setItems] = useState<ScratchItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Items with an /act call in flight (processing overlay on the card).
  const [acting, setActing] = useState<Set<number>>(new Set());
  const seqRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (q: string) => {
    const seq = ++seqRef.current;
    setError(null);
    try {
      const page = await api.listScratch({ q: q || undefined, limit: PAGE });
      if (seqRef.current !== seq) return;
      setItems(page);
      setHasMore(page.length === PAGE);
    } catch (err) {
      if (seqRef.current !== seq) return;
      setError(errMessage(err));
      setItems([]);
    }
  }, []);

  // Full list immediately; searches debounced.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      void load('');
      return;
    }
    const t = setTimeout(() => void load(q), 300);
    return () => clearTimeout(t);
  }, [query, load]);

  const loadMore = async () => {
    if (!items || items.length === 0) return;
    setLoadingMore(true);
    try {
      const older = await api.listScratch({
        q: query.trim() || undefined,
        before: items[items.length - 1].id,
        limit: PAGE,
      });
      setItems((prev) => [...(prev ?? []), ...older]);
      setHasMore(older.length === PAGE);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const replaceItem = (next: ScratchItem) =>
    setItems((prev) =>
      prev ? prev.map((i) => (i.id === next.id ? next : i)) : prev,
    );

  /** Capture; with `act` (hold-send) the agent gets one shot at the item. */
  const send = async (act: boolean) => {
    const text = value.trim();
    if (!text || sending) return;
    setValue('');
    setSending(true);
    setError(null);
    try {
      const item = await api.addScratch(text);
      setItems((prev) => [item, ...(prev ?? [])]);
      if (act) {
        setActing((prev) => new Set(prev).add(item.id));
        try {
          replaceItem(await api.actScratch(item.id));
        } catch (err) {
          setError(errMessage(err));
        } finally {
          setActing((prev) => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
        }
      }
    } catch (err) {
      setError(errMessage(err));
      setValue((v) => (v ? v : text)); // capture failed — restore the draft
    } finally {
      setSending(false);
    }
  };

  // Tap = inert capture; hold = capture + one-shot agent action. Both routes
  // go through useLongPress so a hold never also fires the tap.
  const sendHold = useLongPress(() => void send(true), {
    onClick: () => void send(false),
  });

  // Pasted links get tracking params stripped at the door (same as chat).
  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const raw = e.clipboardData.getData('text/plain');
    if (!raw || !/https?:\/\//i.test(raw)) return;
    const cleaned = cleanUrlsInText(raw);
    if (cleaned === raw) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setValue((v) => v.slice(0, start) + cleaned + v.slice(end));
    requestAnimationFrame(() => {
      const caret = start + cleaned.length;
      el.setSelectionRange(caret, caret);
    });
  }

  const remove = (item: ScratchItem) => {
    const idx = items?.findIndex((i) => i.id === item.id) ?? -1;
    setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
    api.deleteScratch(item.id).catch((err: unknown) => {
      setItems((prev) => {
        const next = prev ? [...prev] : [];
        next.splice(Math.min(Math.max(idx, 0), next.length), 0, item);
        return next;
      });
      setError(errMessage(err));
    });
  };

  const toggleReadable = (item: ScratchItem) => {
    replaceItem({ ...item, llmReadable: !item.llmReadable });
    api.setScratchReadable(item.id, !item.llmReadable).then(replaceItem, () => {
      replaceItem(item); // revert
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-2xl font-semibold">Scratch</h2>
      </div>

      <div className="border-b border-border px-4 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes to self…"
            className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {error && (
          <p className="px-4 py-2 text-sm text-destructive">{error}</p>
        )}
        {items === null ? (
          <p className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-8 py-16 text-center text-muted-foreground">
            <StickyNote className="h-10 w-10 opacity-40" />
            <p className="text-lg font-medium text-foreground">
              {query.trim() ? 'No matches' : 'Notes to self'}
            </p>
            {!query.trim() && (
              <p className="max-w-sm text-sm">
                Anything you'd message yourself: links, addresses, snippets.
                Tap send to save it silently — hold send to let the agent act
                on it.
              </p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.id} className="px-4 py-3">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{fmtWhen(item.createdAt)}</span>
                  {item.kind !== 'text' && (
                    <span className="rounded bg-accent px-1 py-px text-[10px] text-accent-foreground">
                      {item.kind}
                    </span>
                  )}
                  {item.status !== 'inert' && (
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-px text-[10px] font-medium',
                        STATUS_TONE[item.status],
                      )}
                    >
                      {item.status}
                    </span>
                  )}
                  {acting.has(item.id) && (
                    <span className="flex items-center gap-1 text-[10px]">
                      <Loader2 className="h-3 w-3 animate-spin" /> agent
                      working…
                    </span>
                  )}
                  <span className="ml-auto flex items-center">
                    <button
                      type="button"
                      aria-label={
                        item.llmReadable
                          ? 'The agent has seen this — tap to mark unread'
                          : 'The agent has never seen this — tap to allow'
                      }
                      title={
                        item.llmReadable
                          ? 'Seen by the agent'
                          : 'Never seen by the agent'
                      }
                      onClick={() => toggleReadable(item)}
                      className="rounded p-1.5 opacity-60 hover:opacity-100"
                    >
                      {item.llmReadable ? (
                        <Eye className="h-3.5 w-3.5 text-primary" />
                      ) : (
                        <EyeOff className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <CopyButton text={item.content} />
                    <button
                      type="button"
                      aria-label="Delete"
                      title="Delete"
                      onClick={() => remove(item)}
                      className="rounded p-1.5 opacity-60 hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
                {item.kind === 'url' && /^https?:\/\//i.test(item.content) ? (
                  <a
                    href={item.content}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block break-all text-sm text-primary underline-offset-2 hover:underline"
                  >
                    {item.content}
                  </a>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
                    {item.content ||
                      (item.mediaMime ? `(${item.mediaMime})` : '')}
                  </p>
                )}
                <ActionResult
                  item={item}
                  onDecided={() => void load(query.trim())}
                  onStartChat={onStartChat}
                  onOpenTranscripts={onOpenTranscripts}
                />
              </li>
            ))}
            {hasMore && (
              <li className="px-4 py-3 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  className="h-8 text-xs text-muted-foreground"
                >
                  {loadingMore ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    'Load older'
                  )}
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Capture bar. Tap send: inert. Hold send: the agent gets one shot. */}
      <div className="px-safe pb-safe border-t border-border bg-background">
        <div className="px-3 pb-5 pt-3 sm:px-4">
          <div className="flex items-end gap-2 rounded-2xl border border-input bg-card px-3 py-2 focus-within:ring-2 focus-within:ring-ring">
            <textarea
              ref={textareaRef}
              rows={1}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                const el = e.currentTarget;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
              }}
              onPaste={handlePaste}
              placeholder="Note to self…"
              className="max-h-40 min-h-[2.25rem] w-full resize-none border-0 bg-transparent px-1 py-1.5 text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
            />
            <Button
              type="button"
              size="icon"
              disabled={sending || !value.trim()}
              {...sendHold}
              aria-label="Save note to self (hold to let the agent act on it)"
              title="Tap: save silently · Hold: let the agent act on it"
              className="h-9 w-9 shrink-0 select-none rounded-full"
            >
              <SendHorizontal className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Per-item copy — the whole point of a device-to-device scratchpad. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      aria-label="Copy"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded p-1.5 opacity-60 hover:opacity-100"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-primary" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
