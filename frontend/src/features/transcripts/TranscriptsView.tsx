import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileVideo,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Transcript } from '@/domain/models';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function fmtDuration(s: number | null): string | null {
  if (s == null) return null;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

/** One finished/failed/running video-transcription job, opened from the list. */
function TranscriptDetail({
  id,
  onBack,
}: {
  id: number;
  onBack: () => void;
}) {
  const [item, setItem] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
              {item.status === 'processing' && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Still transcribing — check back shortly.
                </p>
              )}
              {item.status === 'error' && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <TriangleAlert className="h-4 w-4" />
                  Transcription failed.
                </p>
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
 * also fetch results itself — this screen is for the human.
 */
export function TranscriptsView({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<Transcript[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await api.listTranscripts());
    } catch (err) {
      setError(errMessage(err));
      setItems([]);
    }
  }, []);

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
      <TranscriptDetail id={selectedId} onBack={() => setSelectedId(null)} />
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
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
        {items === null ? (
          <p className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
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
                    <span className="block text-xs text-muted-foreground">
                      {[
                        fmtDuration(t.durationS),
                        t.chars != null
                          ? `${Math.round(t.chars / 1000)}k chars`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
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
