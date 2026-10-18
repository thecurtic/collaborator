import { ArrowRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { find, type FindGroup, type FindHit, type FindScope } from './findApi';
import { FindResults } from './FindResults';

/**
 * Under a screen's own search bar: hand the same query to unified search
 * (UX doc: a search bar inside a screen is the same search, scoped).
 */
export function SearchEverywhere({
  q,
  onSearch,
}: {
  q: string;
  onSearch: (q: string) => void;
}) {
  const query = q.trim();
  if (!query) return null;
  return (
    <button
      type="button"
      onClick={() => onSearch(query)}
      className="mt-1.5 flex max-w-full items-center gap-1 text-xs font-medium text-primary"
    >
      <span className="truncate">Search everywhere for “{query}”</span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

/** Unified search's results for one pile: a screen's bar, scoped. */
export function ScopedResults({
  scope,
  q,
  onOpen,
  emptyHint,
}: {
  scope: FindScope;
  q: string;
  onOpen: (hit: FindHit) => void;
  emptyHint?: string;
}) {
  const [groups, setGroups] = useState<FindGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const query = q.trim();
    if (!query) return;
    const ctl = new AbortController();
    setGroups(null);
    const t = setTimeout(() => {
      find(query, { scope, limit: 100, signal: ctl.signal })
        .then((g) => {
          setGroups(g);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : 'Search failed');
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, scope]);

  if (error) return <p className="px-4 py-3 text-sm text-destructive">{error}</p>;
  if (!groups)
    return (
      <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Searching…
      </p>
    );
  if (groups.length === 0)
    return (
      <p className="px-8 py-12 text-center text-sm text-muted-foreground">
        Nothing matches “{q.trim()}”.{emptyHint ? ` ${emptyHint}` : ''}
      </p>
    );
  return <FindResults groups={groups} q={q.trim()} onOpen={onOpen} showHeadings={false} />;
}
