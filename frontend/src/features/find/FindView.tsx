import { ChevronLeft, Loader2, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AttachmentSheet } from '@/features/attachments/AttachmentViews';
import type { AttachmentKind, TurnAttachment } from '@/domain/models';
import { find, type FindGroup, type FindHit, type FindScope } from './findApi';
import { FindResults, SCOPE_LABEL } from './FindResults';

/**
 * Unified search (UX doc, Search): one search over my own world — chats,
 * notes, Scratch, transcripts and attachments at once, grouped by pile.
 * This is mine, not the model's: it includes Scratch, which no model tool
 * reaches. Web search stays its own thing in the menu.
 */
export function FindView({
  initialQuery = '',
  initialScope = null,
  onOpen,
}: {
  initialQuery?: string;
  initialScope?: FindScope | null;
  /** Navigate to a hit (attachments open here, in their sheet). */
  onOpen: (hit: FindHit, q: string) => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [scope, setScope] = useState<FindScope | null>(initialScope);
  const [groups, setGroups] = useState<FindGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<TurnAttachment | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setGroups(null);
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      find(query, { scope: scope ?? undefined, limit: scope ? 100 : 5, signal: ctl.signal })
        .then((g) => {
          setGroups(g);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : 'Search failed');
        })
        .finally(() => !ctl.signal.aborted && setLoading(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, scope]);

  const open = (hit: FindHit) => {
    if (hit.type === 'attachment') {
      setAttachment({
        id: Number(hit.id),
        filename: hit.title,
        mime: hit.mime ?? null,
        kind: (hit.kind ?? 'file') as AttachmentKind,
        size: hit.size ?? 0,
      });
      return;
    }
    onOpen(hit, q.trim());
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search chats, notes, Scratch, transcripts…"
            enterKeyHint="search"
            className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-8 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQ('');
                inputRef.current?.focus();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {scope && (
          <button
            type="button"
            onClick={() => setScope(null)}
            className="mt-2 flex items-center gap-1 text-xs font-medium text-primary"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Everywhere (showing {SCOPE_LABEL[scope]} only)
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
        {loading && !groups && (
          <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Searching…
          </p>
        )}
        {!q.trim() && (
          <p className="px-8 py-12 text-center text-sm text-muted-foreground">
            One search over everything of yours: chats, notes, Scratch, transcripts and
            attached files. Only you see these results; Scratch never reaches the model.
          </p>
        )}
        {groups && groups.length === 0 && q.trim() && !loading && (
          <p className="px-8 py-12 text-center text-sm text-muted-foreground">
            Nothing matches “{q.trim()}”{scope ? ` in ${SCOPE_LABEL[scope]}` : ''}.
          </p>
        )}
        {groups && groups.length > 0 && (
          <FindResults
            groups={groups}
            q={q.trim()}
            onOpen={open}
            onShowAll={scope ? undefined : (s) => setScope(s)}
          />
        )}
      </div>
      <AttachmentSheet item={attachment} onClose={() => setAttachment(null)} />
    </div>
  );
}
