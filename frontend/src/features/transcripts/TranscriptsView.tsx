import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileVideo,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { SearchEverywhere } from '@/features/find/ScopedSearch';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Transcript } from '@/domain/models';
import { TagEditor } from '@/features/notes/TagEditor';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function fmtDuration(s: number | null): string | null {
  if (s == null) return null;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

/** SQLite's UTC "YYYY-MM-DD HH:MM:SS" → a short local date. */
function fmtDate(sqlUtc: string | null): string | null {
  if (!sqlUtc) return null;
  const d = new Date(`${sqlUtc.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** One finished/failed/running video-transcription job, opened from the list. */
function TranscriptDetail({
  id,
  vocabulary,
  onBack,
  onTagsSaved,
}: {
  id: number;
  /** Tags in use beyond the vault, for completion and near-miss checks. */
  vocabulary: string[];
  onBack: () => void;
  onTagsSaved: (t: Transcript) => void;
}) {
  const [item, setItem] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void api.touchFeedItem(`transcript:${id}`); // opened = touched (warm feed)
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    api
      .getTranscript(id)
      .then((t) => {
        if (!cancelled) setItem(t);
      })
      .catch((err) => {
        if (!cancelled) setError(errMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  // Tags save as they change (optimistic, restored on failure).
  const saveTags = (next: string[]) => {
    if (!item) return;
    const prev = item;
    setItem({ ...item, tags: next });
    setError(null);
    api
      .setTranscriptTags(item.id, next)
      .then((t) => {
        setItem((cur) => (cur ? { ...cur, tags: t.tags } : cur));
        onTagsSaved(t);
      })
      .catch((err) => {
        setItem(prev);
        setError(errMessage(err));
      });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to transcripts"
          onClick={onBack}
          className="h-9 w-9"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
          {item?.title ?? 'Transcript'}
        </h2>
        {item?.text && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Copy transcript"
            title="Copy the full transcript"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(item.text ?? '')
                .then(() => {
                  setCopied(true);
                  if (copyTimer.current) clearTimeout(copyTimer.current);
                  copyTimer.current = setTimeout(() => setCopied(false), 1500);
                });
            }}
            className="h-9 w-9 text-muted-foreground"
          >
            {copied ? (
              <Check className="h-4 w-4 text-primary" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-4 py-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!item && !error && (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          )}
          {item && (
            <>
              <p className="mb-3 break-all text-xs text-muted-foreground">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-2 hover:underline"
                >
                  {item.url}
                </a>
                {fmtDuration(item.durationS) && (
                  <span> · {fmtDuration(item.durationS)}</span>
                )}
              </p>
              {item.channel && (
                <p className="mb-3 -mt-2 text-xs text-muted-foreground">
                  {item.channel}
                </p>
              )}
              {/* Optional tags (UX doc, Transcripts): `project` plus a name
                  puts this transcript on that project's shelf. */}
              <div className="mb-4 border-b border-border pb-3">
                <TagEditor tags={item.tags} onChange={saveTags} vocabulary={vocabulary} />
              </div>
              {item.status === 'processing' && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Still transcribing — check back shortly.
                </p>
              )}
              {item.status === 'error' && (
                <div className="text-sm text-destructive">
                  <p className="flex items-center gap-2">
                    <TriangleAlert className="h-4 w-4" />
                    Transcription failed.
                  </p>
                  {item.error && (
                    <p className="mt-1 break-words text-xs opacity-80">
                      {item.error}
                    </p>
                  )}
                </div>
              )}
              {item.text && (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {item.text}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Background video-transcription jobs (b23d8ea): long videos transcribe
 * server-side; this list shows progress and the finished text. The model can
 * also fetch results itself — this screen is for the human. Each row keeps
 * the transcript's own shape (title, channel, length, date); a search box
 * matches title, channel and full text, and tapping a channel filters by it.
 */
export function TranscriptsView({
  onBack,
  initialId = null,
  onSearchEverywhere,
}: {
  onBack: () => void;
  /** Open this transcript first (a notification's deep link). */
  initialId?: number | null;
  /** Hand the query to unified search. */
  onSearchEverywhere?: (q: string) => void;
}) {
  const [items, setItems] = useState<Transcript[] | null>(null);
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(initialId);
  useEffect(() => {
    if (initialId != null) setSelectedId(initialId);
  }, [initialId]);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [channel, setChannel] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.listTranscripts({
        channel: channel ?? undefined,
        q: debounced,
      });
      setItems(list.items);
      setVocabulary(list.vocabulary);
    } catch (err) {
      setError(errMessage(err));
      setItems([]);
    }
  }, [channel, debounced]);

  // Optimistic delete (house style): remove, restore in place on failure.
  const remove = (t: Transcript) => {
    const idx = items?.findIndex((x) => x.id === t.id) ?? -1;
    setItems((prev) => prev?.filter((x) => x.id !== t.id) ?? prev);
    api.deleteTranscript(t.id).catch((err: unknown) => {
      setItems((prev) => {
        const next = prev ? [...prev] : [];
        next.splice(Math.min(Math.max(idx, 0), next.length), 0, t);
        return next;
      });
      setError(errMessage(err));
    });
  };

  useEffect(() => {
    void load();
  }, [load]);

  // Live-ish while a job runs: poll gently until nothing is processing.
  useEffect(() => {
    if (!items?.some((t) => t.status === 'processing')) return;
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [items, load]);

  if (selectedId != null) {
    return (
      <TranscriptDetail
        id={selectedId}
        vocabulary={vocabulary}
        onBack={() => setSelectedId(null)}
        onTagsSaved={(t) => {
          setItems((prev) => prev?.map((x) => (x.id === t.id ? { ...x, tags: t.tags } : x)) ?? prev);
          setVocabulary((v) => [...new Set([...v, ...t.tags])]);
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back"
          onClick={onBack}
          className="h-9 w-9"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
          Transcripts
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          onClick={() => void load()}
          className="h-9 w-9 text-muted-foreground"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <div className="space-y-2 border-b border-border px-4 py-2">
        <label className="flex items-center gap-2 rounded-md border border-input bg-background px-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, channels and text"
            aria-label="Search transcripts"
            className="min-h-[2.25rem] min-w-0 flex-1 bg-transparent text-base text-foreground outline-none sm:text-sm"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
        {onSearchEverywhere && <SearchEverywhere q={query} onSearch={onSearchEverywhere} />}
        {channel && (
          <button
            type="button"
            onClick={() => setChannel(null)}
            className="flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-xs text-accent-foreground"
          >
            Channel: {channel}
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
        {items === null ? (
          <p className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : items.length === 0 && (channel || debounced.trim()) ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No transcripts match.
          </p>
        ) : items.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground">
            <FileVideo className="mx-auto mb-3 h-8 w-8 opacity-40" />
            <p className="text-lg font-medium text-foreground">
              No transcripts yet
            </p>
            <p className="mt-1 px-8 text-sm">
              Ask the agent to transcribe a video — long ones run in the
              background and land here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/60 active:bg-muted"
                >
                  <FileVideo className="h-4 w-4 shrink-0 text-primary/70" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {t.title ?? t.url}
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      {t.channel && (
                        <span
                          role="button"
                          tabIndex={0}
                          title={`Only ${t.channel}`}
                          onClick={(e) => {
                            e.stopPropagation(); // the row opens the detail
                            setChannel(t.channel);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              setChannel(t.channel);
                            }
                          }}
                          className="min-w-0 truncate font-medium text-foreground/80 underline-offset-2 hover:underline"
                        >
                          {t.channel}
                        </span>
                      )}
                      <span className="shrink-0">
                        {[
                          // Leading dot only when a channel precedes it.
                          ...(t.channel ? [''] : []),
                          fmtDuration(t.durationS),
                          fmtDate(t.createdAt),
                        ]
                          .filter((x): x is string => x != null)
                          .join(' · ')
                          .trim()}
                      </span>
                    </span>
                    {t.tags.length > 0 && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {t.tags.join(', ')}
                      </span>
                    )}
                    {t.snippet && (
                      <span className="mt-0.5 line-clamp-2 block text-xs italic text-muted-foreground">
                        …{t.snippet}…
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                      t.status === 'processing' &&
                        'bg-amber-500/10 text-amber-700',
                      t.status === 'done' && 'bg-primary/10 text-primary',
                      t.status === 'error' &&
                        'bg-destructive/10 text-destructive',
                    )}
                  >
                    {t.status}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="Delete transcript"
                    title="Delete transcript"
                    onClick={(e) => {
                      e.stopPropagation(); // the row itself opens the detail
                      remove(t);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        remove(t);
                      }
                    }}
                    className="shrink-0 rounded p-1.5 opacity-60 hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
