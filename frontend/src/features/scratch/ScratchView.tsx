import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  FileQuestion,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  Mic,
  Paperclip,
  Pin,
  PinOff,
  Play,
  Search,
  SendHorizontal,
  ShieldAlert,
  Square,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { api } from '@/api/collaborator';
import {
  ActiveFilter,
  ListFilterButton,
  type FilterOption,
} from '@/components/ListFilter';
import { Button } from '@/components/ui/button';
import { useLongPress } from '@/lib/useLongPress';
import { cleanUrlsInText } from '@/lib/urlClean';
import { cn, parseApiDate } from '@/lib/utils';
import type { NoteDraft, ScratchFilter, ScratchItem } from '@/domain/models';
import { categoryOf } from '@/features/notes/categories';
import {
  draftToFields,
  draftToPatch,
  FieldsEditor,
  fieldsToDraft,
  FieldsSummary,
  type FieldsDraft,
} from '@/features/notes/FieldsEditor';
import { useDictation } from '@/features/voice/useDictation';
import { scratchMediaUrl, scratchPreviewUrl } from './mediaCache';

const PAGE = 50;

// Derived filters (UX doc: "no manual categories"): what each item already is.
const FILTERS: FilterOption<ScratchFilter>[] = [
  { key: 'links', label: 'Links' },
  { key: 'photos', label: 'Photos and videos' },
  { key: 'documents', label: 'Documents' },
  { key: 'text', label: 'Text' },
  { key: 'voice', label: 'Voice' },
];

// A transcription event's live state, from its linked job.
const JOB_LABEL: Record<string, { label: string; tone: string }> = {
  processing: { label: 'transcribing', tone: 'bg-amber-500/10 text-amber-700' },
  done: { label: 'transcribed', tone: 'bg-green-500/10 text-green-700' },
  failed: {
    label: 'transcription failed',
    tone: 'bg-destructive/10 text-destructive',
  },
};

const PINS_OPEN_KEY = 'scratch.pinsOpen';

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
  // One hold-send can propose SEVERAL notes (66ae41e re-tags every sibling
  // with this run_id) — the card is the whole set's only home.
  const [drafts, setDrafts] = useState<NoteDraft[] | null>(null);

  useEffect(() => {
    if (item.status !== 'pending') return;
    let cancelled = false;
    api
      .listDrafts({ status: 'pending', runId: `scratch-${item.id}` })
      .then((all) => {
        if (!cancelled) setDrafts(all);
      })
      .catch(() => {
        if (!cancelled) setDrafts([]); // the note line below still renders
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.status]);

  return (
    <div className="mt-2 space-y-2">
      {(item.actionResult?.note || item.status !== 'pending') && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2">
          {item.status !== 'pending' && (
            <p className="text-sm font-medium text-foreground">
              {item.actionResult?.draftTitle ?? 'Proposed note'}
            </p>
          )}
          {item.actionResult?.note && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {item.actionResult.note}
            </p>
          )}
        </div>
      )}
      {item.status === 'pending' && drafts === null && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> loading proposals…
        </p>
      )}
      {drafts?.map((d) => (
        <DraftDecision key={d.id} draft={d} onDecided={onDecided} />
      ))}
    </div>
  );
}

/**
 * One proposal on a scratch card: summary + approve/reject. Approval can be
 * refused with instructions (e.g. a start-less event, 66ae41e) — the typed
 * fields editor then opens right here so the fix never leaves the card.
 */
function DraftDecision({
  draft,
  onDecided,
}: {
  draft: NoteDraft;
  onDecided: () => void;
}) {
  const category = categoryOf(draft.tags)?.tag ?? null;
  const fields0 = fieldsToDraft(category, draft.fields);
  const [fieldsDraft, setFieldsDraft] = useState<FieldsDraft>(fields0);
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setBusy('approve');
    setError(null);
    try {
      const patch = draftToPatch(fieldsDraft, fields0);
      if (patch) await api.updateDraft(draft.id, { fields: patch });
      await api.approveDraft(draft.id);
      onDecided(); // item status derives from its drafts — refetch the list
    } catch (err) {
      setError(errMessage(err));
      // 422 with instructions (missing start etc.) → open the editor here.
      if (category) setFixing(true);
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setBusy('reject');
    setError(null);
    try {
      await api.rejectDraft(draft.id);
      onDecided();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2">
      <p className="text-sm font-medium text-foreground">{draft.title}</p>
      <div className="mt-1.5">
        <FieldsSummary
          category={category}
          fields={draftToFields(draft.fields, fieldsDraft)}
        />
      </div>
      {fixing && (
        <div className="mt-1.5">
          <FieldsEditor
            category={category}
            draft={fieldsDraft}
            onChange={setFieldsDraft}
          />
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      <div className="mt-2 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy != null}
          onClick={() => void reject()}
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
          disabled={busy != null}
          onClick={() => void approve()}
          className="h-8 flex-1 gap-1"
        >
          {busy === 'approve' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {fixing ? 'Save & approve' : 'Approve'}
        </Button>
      </div>
    </div>
  );
}

/**
 * What was read from a capture (a voice memo's transcript, a file's text):
 * a few lines, tap for the rest — a PDF's text shouldn't swallow the card.
 */
function ReadText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280 || text.split('\n').length > 4;
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      disabled={!long}
      className="mt-1 block w-full text-left"
    >
      <p
        className={cn(
          'whitespace-pre-wrap break-words text-xs italic text-muted-foreground',
          !open && long && 'line-clamp-4',
        )}
      >
        “{text}”
      </p>
      {long && (
        <span className="text-[11px] font-medium text-primary">
          {open ? 'Show less' : 'Show all'}
        </span>
      )}
    </button>
  );
}

/** Image thumbnail / audio playback for media items (authed blob fetch). */
function MediaBlock({ item }: { item: ScratchItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [wanted, setWanted] = useState(item.kind === 'image');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!wanted || !item.mediaHash) return;
    let cancelled = false;
    scratchMediaUrl(item.id, item.mediaHash)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, item.id, item.mediaHash]);

  if (!item.mediaHash) return null;
  if (failed) {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        (media unavailable{item.mediaMime ? ` · ${item.mediaMime}` : ''})
      </p>
    );
  }
  if (item.kind === 'image') {
    return url ? (
      <img
        src={url}
        alt={item.content || 'scratch image'}
        className="mt-1.5 max-h-48 rounded-lg border border-border object-contain"
      />
    ) : (
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> loading image…
      </p>
    );
  }
  if (item.kind === 'audio') {
    return url ? (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <audio controls autoPlay src={url} className="mt-1.5 h-9 w-full" />
    ) : (
      <button
        type="button"
        onClick={() => setWanted(true)}
        className="mt-1.5 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Play className="h-3.5 w-3.5" />
        Play voice note
      </button>
    );
  }
  if (item.kind === 'video') {
    return url ? (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        controls
        autoPlay
        src={url}
        className="mt-1.5 max-h-64 w-full rounded-lg bg-black"
      />
    ) : (
      <button
        type="button"
        onClick={() => setWanted(true)}
        className="mt-1.5 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Play className="h-3.5 w-3.5" />
        Play {item.mediaName ?? 'video'}
      </button>
    );
  }
  // A document: its filename and type, and the file itself on tap.
  return <FileBlock item={item} />;
}

function fileType(item: ScratchItem): string {
  const ext = item.mediaName?.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  if (ext) return ext.toUpperCase();
  const sub = item.mediaMime?.split('/')[1]?.split(';')[0];
  return sub ? sub.toUpperCase() : 'File';
}

function fmtSize(n: number | null): string | null {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function FileBlock({ item }: { item: ScratchItem }) {
  const [busy, setBusy] = useState(false);
  const open = () => {
    if (!item.mediaHash || busy) return;
    setBusy(true);
    scratchMediaUrl(item.id, item.mediaHash)
      .then((u) => {
        const a = document.createElement('a');
        a.href = u;
        a.download = item.mediaName ?? 'file';
        a.click();
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      onClick={open}
      className="mt-1.5 flex max-w-full items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left hover:bg-muted"
    >
      {busy ? (
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">
          {item.mediaName ?? 'Untitled file'}
        </span>
        <span className="block text-xs text-muted-foreground">
          {[fileType(item), fmtSize(item.mediaSize)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </button>
  );
}

/** A preview image (favicon / thumbnail), fetched through the app. */
function PreviewImage({
  id,
  which,
  className,
}: {
  id: number;
  which: 'icon' | 'image';
  className: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    scratchPreviewUrl(id, which)
      .then((u) => live && setUrl(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, which]);
  return url ? (
    <img src={url} alt="" className={className} />
  ) : (
    <span className={cn('block bg-muted', className)} />
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * A link as what it is (UX doc): the page title and favicon, or for a
 * YouTube link its thumbnail, title and channel. Until the preview is in
 * (or when there is none) it's the plain URL.
 */
function LinkPreview({ item }: { item: ScratchItem }) {
  const p = item.preview;
  const title = p?.title ?? item.transcriptJob?.title ?? null;
  if (!title) {
    return (
      <a
        href={item.content}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 block break-all text-sm text-primary underline-offset-2 hover:underline"
      >
        {item.content}
      </a>
    );
  }
  const site = p?.site ?? item.transcriptJob?.channel ?? null;
  if (p?.image) {
    return (
      <a
        href={item.content}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1.5 block overflow-hidden rounded-lg border border-border hover:bg-muted/60"
      >
        <span className="relative block aspect-video w-full bg-muted">
          <PreviewImage
            id={item.id}
            which="image"
            className="h-full w-full object-cover"
          />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60">
              <Play className="h-5 w-5 fill-white text-white" />
            </span>
          </span>
        </span>
        <span className="block px-3 py-2">
          <span className="line-clamp-2 text-sm font-medium text-foreground">
            {title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {[site, hostOf(item.content)].filter(Boolean).join(' · ')}
          </span>
        </span>
      </a>
    );
  }
  return (
    <a
      href={item.content}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 flex items-start gap-2.5 rounded-lg border border-border px-3 py-2 hover:bg-muted/60"
    >
      {p?.icon ? (
        <PreviewImage
          id={item.id}
          which="icon"
          className="mt-0.5 h-4 w-4 shrink-0 rounded-sm object-contain"
        />
      ) : (
        <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0">
        <span className="line-clamp-2 text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[site, hostOf(item.content)].filter(Boolean).join(' · ')}
        </span>
      </span>
    </a>
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
          {r.note ??
            'Looks like a secret — left untouched, never shown to the model.'}
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
          {r.note ??
            'The action failed — the note is unchanged. Hold send on it to retry.'}
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
  // The stream, newest FIRST as the API pages it; rendered oldest-to-newest
  // so the newest sits at the bottom, nearest the composer (UX doc).
  const [items, setItems] = useState<ScratchItem[] | null>(null);
  const [pinned, setPinned] = useState<ScratchItem[]>([]);
  const [filter, setFilter] = useState<ScratchFilter | null>(null);
  const [pinsOpen, setPinsOpen] = useState(() => {
    try {
      return localStorage.getItem(PINS_OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Items with an /act call in flight (processing overlay on the card).
  const [acting, setActing] = useState<Set<number>>(new Set());
  const seqRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  // After a render: 'bottom' = land on the newest; a number = keep the
  // reader where they were after older items were added above.
  const scrollPlan = useRef<'bottom' | number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (q: string, type: ScratchFilter | null) => {
    const seq = ++seqRef.current;
    setError(null);
    try {
      const page = await api.listScratch({
        q: q || undefined,
        type,
        limit: PAGE,
      });
      if (seqRef.current !== seq) return;
      scrollPlan.current = 'bottom';
      setItems(page.items);
      setPinned(page.pinned);
      setHasMore(page.items.length === PAGE);
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
      void load('', filter);
      return;
    }
    const t = setTimeout(() => void load(q, filter), 300);
    return () => clearTimeout(t);
  }, [query, filter, load]);

  useLayoutEffect(() => {
    const el = listRef.current;
    const plan = scrollPlan.current;
    if (!el || plan === null) return;
    scrollPlan.current = null;
    el.scrollTop = plan === 'bottom' ? el.scrollHeight : el.scrollHeight - plan;
  });

  // Link previews are fetched in the background: while any shown item's is
  // still pending, look again a few times and fold in what arrived (in
  // place, so nothing moves under the reader).
  const previewTries = useRef(0);
  const anyPending =
    (items ?? []).some((i) => i.preview?.status === 'pending') ||
    pinned.some((i) => i.preview?.status === 'pending');
  useEffect(() => {
    if (!anyPending) {
      previewTries.current = 0;
      return;
    }
    if (previewTries.current >= 6) return;
    const t = setTimeout(() => {
      previewTries.current += 1;
      api
        .listScratch({
          q: query.trim() || undefined,
          type: filter,
          limit: PAGE,
        })
        .then((page) => {
          const fresh = new Map(
            [...page.items, ...page.pinned].map((i) => [i.id, i]),
          );
          const fold = (list: ScratchItem[]) =>
            list.map((i) => {
              const f = fresh.get(i.id);
              return f ? { ...i, preview: f.preview } : i;
            });
          setItems((prev) => (prev ? fold(prev) : prev));
          setPinned((prev) => fold(prev));
        })
        .catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
  }, [anyPending, items, pinned, query, filter]);

  /** A new capture lands at the bottom; follow it there. */
  const addItem = (item: ScratchItem) => {
    scrollPlan.current = 'bottom';
    setItems((prev) => [item, ...(prev ?? [])]);
  };

  const loadMore = async () => {
    if (!items || items.length === 0) return;
    setLoadingMore(true);
    try {
      const older = await api.listScratch({
        q: query.trim() || undefined,
        type: filter,
        before: items[items.length - 1].id,
        limit: PAGE,
      });
      const el = listRef.current;
      if (el) scrollPlan.current = el.scrollHeight - el.scrollTop;
      setItems((prev) => [...(prev ?? []), ...older.items]);
      setHasMore(older.items.length === PAGE);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const replaceItem = (next: ScratchItem) => {
    setItems((prev) =>
      prev ? prev.map((i) => (i.id === next.id ? next : i)) : prev,
    );
    setPinned((prev) => prev.map((i) => (i.id === next.id ? next : i)));
  };

  /** The hold-send action, shared by text/media/voice captures. */
  const runAct = async (item: ScratchItem) => {
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
  };

  // --- Raw voice notes: swipe UP on the mic to record; send stops & saves. ---
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);

  const startRecording = async () => {
    if (recording || recorderRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch {
      setError('Microphone unavailable.');
    }
  };

  const finishRecording = (): Promise<Blob | null> =>
    new Promise((resolve) => {
      const rec = recorderRef.current;
      if (!rec) return resolve(null);
      rec.onstop = () => {
        rec.stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        setRecording(false);
        resolve(
          chunksRef.current.length > 0
            ? new Blob(chunksRef.current, {
                type: rec.mimeType || 'audio/webm',
              })
            : null,
        );
      };
      rec.stop();
    });

  const cancelRecording = () => {
    chunksRef.current = [];
    void finishRecording();
  };

  // Recorder must not outlive the tab (mic indicator honesty).
  useEffect(() => cancelRecording, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Capture; with `act` (hold-send) the agent gets one shot at the item.
   * While recording, send stops the recording and posts the audio (with any
   * typed text as its caption) — tap-send-to-stop, per the agreed gesture.
   */
  const send = async (act: boolean) => {
    if (sending) return;
    const text = value.trim();
    setError(null);

    if (recording) {
      setSending(true);
      try {
        const blob = await finishRecording();
        if (!blob) return;
        const ext = (blob.type.split('/')[1] ?? 'webm').split(';')[0] || 'webm';
        const item = await api.addScratchMedia(
          blob,
          `voice-note.${ext}`,
          text || undefined,
        );
        setValue('');
        addItem(item);
        if (act) await runAct(item);
      } catch (err) {
        setError(errMessage(err));
      } finally {
        setSending(false);
      }
      return;
    }

    if (!text) return;
    setValue('');
    setSending(true);
    try {
      const item = await api.addScratch(text);
      addItem(item);
      if (act) await runAct(item);
    } catch (err) {
      setError(errMessage(err));
      setValue((v) => (v ? v : text)); // capture failed — restore the draft
    } finally {
      setSending(false);
    }
  };

  /** Attach any file (photo etc.) with the typed text as caption. Inert. */
  const attach = async (file: File) => {
    setSending(true);
    setError(null);
    try {
      const item = await api.addScratchMedia(
        file,
        file.name,
        value.trim() || undefined,
      );
      setValue('');
      addItem(item);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSending(false);
    }
  };

  // --- Mic gestures: tap = dictate into the field; swipe UP = raw record. ---
  const {
    status: dictation,
    partial,
    supported: dictationSupported,
    start: startDictation,
    stop: stopDictation,
  } = useDictation();
  const micGesture = useRef<{ y: number; swiped: boolean } | null>(null);
  const micDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    micGesture.current = { y: e.clientY, swiped: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const micMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const g = micGesture.current;
    if (g && !g.swiped && g.y - e.clientY > 40 && !recording) {
      g.swiped = true; // swipe up: raw recording, not dictation
      if (dictation === 'idle') void startRecording();
    }
  };
  const micUp = () => {
    const g = micGesture.current;
    micGesture.current = null;
    if (!g || g.swiped || recording) return;
    if (dictation === 'listening') {
      void stopDictation().then((t) => {
        if (t) setValue((v) => (v ? `${v.trimEnd()} ${t}` : t));
      });
    } else if (dictation === 'idle') {
      void startDictation();
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
    const pinIdx = pinned.findIndex((i) => i.id === item.id);
    setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
    setPinned((prev) => prev.filter((i) => i.id !== item.id));
    api.deleteScratch(item.id).catch((err: unknown) => {
      if (pinIdx >= 0) {
        setPinned((prev) => {
          const next = [...prev];
          next.splice(Math.min(pinIdx, next.length), 0, item);
          return next;
        });
      } else {
        setItems((prev) => {
          const next = prev ? [...prev] : [];
          next.splice(Math.min(Math.max(idx, 0), next.length), 0, item);
          return next;
        });
      }
      setError(errMessage(err));
    });
  };

  /** Pin above the stream, or put it back in the stream by its age. */
  const togglePin = (item: ScratchItem) => {
    const next = { ...item, pinned: !item.pinned };
    if (next.pinned) {
      setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
      setPinned((prev) => [next, ...prev]);
      setPinsOpen(true);
    } else {
      setPinned((prev) => prev.filter((i) => i.id !== item.id));
      setItems((prev) => {
        if (!prev) return prev;
        const oldest = prev[prev.length - 1];
        // Older than everything loaded: it'll come back with "Load older".
        if (hasMore && oldest && item.id < oldest.id) return prev;
        return [...prev, next].sort((a, b) => b.id - a.id);
      });
    }
    api
      .setScratchPinned(item.id, next.pinned)
      .then(replaceItem, (err: unknown) => {
        setError(errMessage(err));
        void load(query.trim(), filter);
      });
  };

  const setPinsOpenRemembered = (open: boolean) => {
    setPinsOpen(open);
    try {
      localStorage.setItem(PINS_OPEN_KEY, open ? '1' : '0');
    } catch {
      /* per-device nicety only */
    }
  };

  const card = (item: ScratchItem) => (
    <ScratchCard
      item={item}
      acting={acting.has(item.id)}
      onToggleReadable={() => toggleReadable(item)}
      onTogglePin={() => togglePin(item)}
      onRemove={() => remove(item)}
      onDecided={() => void load(query.trim(), filter)}
      onStartChat={onStartChat}
      onOpenTranscripts={onOpenTranscripts}
    />
  );
  const filterLabel = FILTERS.find((f) => f.key === filter)?.label ?? null;
  const stream = items ? [...items].reverse() : null;

  const toggleReadable = (item: ScratchItem) => {
    replaceItem({ ...item, llmReadable: !item.llmReadable });
    api.setScratchReadable(item.id, !item.llmReadable).then(replaceItem, () => {
      replaceItem(item); // revert
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-2xl font-semibold">Scratch</h2>
        <ListFilterButton
          title="Show only"
          options={FILTERS}
          value={filter}
          onChange={setFilter}
        />
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
      <ActiveFilter
        label={filterLabel}
        count={(items?.length ?? 0) + pinned.length}
        more={hasMore}
        onClear={() => setFilter(null)}
      />

      {/* Pinned: as many as I like, above the stream (UX doc). */}
      {pinned.length > 0 && (
        <div className="border-b border-border bg-muted/30">
          <button
            type="button"
            onClick={() => setPinsOpenRemembered(!pinsOpen)}
            aria-expanded={pinsOpen}
            className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left text-xs font-medium text-muted-foreground"
          >
            <Pin className="h-3.5 w-3.5" />
            {pinned.length} pinned
            {!pinsOpen && (
              <span className="min-w-0 flex-1 truncate font-normal">
                · {pinned[0].content || pinned[0].kind}
              </span>
            )}
            {pinsOpen ? (
              <ChevronUp className="ml-auto h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0" />
            )}
          </button>
          {pinsOpen && (
            <ul className="max-h-[40vh] divide-y divide-border overflow-y-auto overscroll-contain border-t border-border">
              {pinned.map((item) => (
                <li key={item.id} className="px-4 py-3">
                  {card(item)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-2 text-sm text-destructive">{error}</p>}
        {stream === null ? (
          <p className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : stream.length === 0 && pinned.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-8 py-16 text-center text-muted-foreground">
            <StickyNote className="h-10 w-10 opacity-40" />
            <p className="text-lg font-medium text-foreground">
              {query.trim() || filter ? 'Nothing here' : 'Notes to self'}
            </p>
            {!query.trim() && !filter && (
              <p className="max-w-sm text-sm">
                Anything you'd message yourself: links, addresses, snippets. Tap
                send to save it silently — hold send to let the agent act on it.
              </p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border">
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
            {stream.map((item) => (
              <li key={item.id} className="px-4 py-3">
                {card(item)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Capture bar. Tap send: inert. Hold send: the agent gets one shot.
          Mic: tap = dictate into the field; swipe UP = raw voice note,
          stopped by send (or discarded by the X). */}
      <div className="px-safe pb-safe border-t border-border bg-background">
        {recording && (
          <p className="flex items-center gap-2 px-4 pt-2 text-xs text-muted-foreground">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-destructive" />
            Recording voice note — tap send to save it
            <button
              type="button"
              aria-label="Discard recording"
              onClick={cancelRecording}
              className="ml-auto rounded p-1 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </p>
        )}
        {(dictation === 'listening' || dictation === 'starting') && (
          <p className="flex items-start gap-2 px-4 pt-2 text-xs text-muted-foreground">
            <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-destructive" />
            <span className="line-clamp-2 min-w-0">
              {partial ||
                (dictation === 'listening'
                  ? 'Listening… tap the mic when you’re done.'
                  : 'Connecting…')}
            </span>
          </p>
        )}
        <div className="px-3 pb-5 pt-3 sm:px-4">
          <div className="flex items-end gap-1.5 rounded-2xl border border-input bg-card px-3 py-2 focus-within:ring-2 focus-within:ring-ring">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={sending || recording}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach a file"
              title="Attach a photo or file (typed text becomes its caption)"
              className="h-9 w-9 shrink-0 rounded-full text-muted-foreground"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void attach(f);
              }}
            />
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
              placeholder={
                recording ? 'Caption for the voice note…' : 'Note to self…'
              }
              className="max-h-40 min-h-[2.25rem] w-full resize-none border-0 bg-transparent px-1 py-1.5 text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
            />
            {(dictationSupported || recording) && (
              <Button
                type="button"
                variant={dictation === 'listening' ? 'destructive' : 'ghost'}
                size="icon"
                disabled={sending || recording || dictation === 'finishing'}
                onPointerDown={micDown}
                onPointerMove={micMove}
                onPointerUp={micUp}
                aria-label="Dictate (swipe up to record a voice note)"
                title="Tap: dictate into the field · Swipe up: record a voice note"
                className="h-9 w-9 shrink-0 touch-none select-none rounded-full"
              >
                {dictation === 'starting' || dictation === 'finishing' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : dictation === 'listening' ? (
                  <Square className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </Button>
            )}
            <Button
              type="button"
              size="icon"
              disabled={sending || (!value.trim() && !recording)}
              {...sendHold}
              aria-label="Save note to self (hold to let the agent act on it)"
              title="Tap: save silently · Hold: let the agent act on it"
              className={cn(
                'h-9 w-9 shrink-0 select-none rounded-full',
                recording && 'ring-2 ring-destructive/50',
              )}
            >
              <SendHorizontal className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One Scratch item, in the stream or among the pins. */
function ScratchCard({
  item,
  acting,
  onToggleReadable,
  onTogglePin,
  onRemove,
  onDecided,
  onStartChat,
  onOpenTranscripts,
}: {
  item: ScratchItem;
  acting: boolean;
  onToggleReadable: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
  onDecided: () => void;
  onStartChat: (draft: string) => void;
  onOpenTranscripts: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{fmtWhen(item.createdAt)}</span>
        {item.kind !== 'text' && (
          <span className="rounded bg-accent px-1 py-px text-[10px] text-accent-foreground">
            {item.kind}
          </span>
        )}
        {item.transcriptJob && JOB_LABEL[item.transcriptJob.status] && (
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-[10px] font-medium',
              JOB_LABEL[item.transcriptJob.status].tone,
            )}
          >
            {JOB_LABEL[item.transcriptJob.status].label}
          </span>
        )}
        {item.status !== 'inert' && !item.transcriptJob && (
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-[10px] font-medium',
              STATUS_TONE[item.status],
            )}
          >
            {item.status}
          </span>
        )}
        {acting && (
          <span className="flex items-center gap-1 text-[10px]">
            <Loader2 className="h-3 w-3 animate-spin" /> agent working…
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
              item.llmReadable ? 'Seen by the agent' : 'Never seen by the agent'
            }
            onClick={onToggleReadable}
            className="rounded p-1.5 opacity-60 hover:opacity-100"
          >
            {item.llmReadable ? (
              <Eye className="h-3.5 w-3.5 text-primary" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            aria-label={item.pinned ? 'Unpin' : 'Pin'}
            title={item.pinned ? 'Unpin' : 'Pin above the stream'}
            onClick={onTogglePin}
            className="rounded p-1.5 opacity-60 hover:opacity-100"
          >
            {item.pinned ? (
              <PinOff className="h-3.5 w-3.5 text-primary" />
            ) : (
              <Pin className="h-3.5 w-3.5" />
            )}
          </button>
          <CopyButton text={item.content} />
          <button
            type="button"
            aria-label="Delete"
            title="Delete"
            onClick={onRemove}
            className="rounded p-1.5 opacity-60 hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {item.kind === 'url' && /^https?:\/\//i.test(item.content) ? (
        <LinkPreview item={item} />
      ) : (
        item.content && (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
            {item.content}
          </p>
        )
      )}
      <MediaBlock item={item} />
      {item.transcript && <ReadText text={item.transcript} />}
      <ActionResult
        item={item}
        onDecided={onDecided}
        onStartChat={onStartChat}
        onOpenTranscripts={onOpenTranscripts}
      />
    </>
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
