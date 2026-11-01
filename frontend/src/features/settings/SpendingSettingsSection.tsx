import { useEffect, useState } from 'react';
import { spendingApi, type SpendingSettings } from '@/features/spending/spendingApi';
import { cn } from '@/lib/utils';

const PROVIDER_NAMES: Record<string, string> = { brave: 'Brave Search', searxng: 'your SearXNG' };

/**
 * Spending: web search for unsure receipt labels. Stored per user on the
 * server, since labelling runs there in the background.
 */
export function SpendingSettingsSection({ open }: { open: boolean }) {
  const [s, setS] = useState<SpendingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    spendingApi.settings().then(setS).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [open]);

  const toggle = async () => {
    if (!s) return;
    const next = !s.searchFallback;
    setS({ ...s, searchFallback: next });
    try {
      setS(await spendingApi.setSearchFallback(next));
      setError(null);
    } catch (err) {
      setS({ ...s });
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const on = s?.searchFallback ?? true;
  const provider = s?.searchProvider ? PROVIDER_NAMES[s.searchProvider] ?? s.searchProvider : null;

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="flex items-center justify-between">
        <div className="pr-3">
          <p className="text-sm font-medium">Search for unsure receipt labels</p>
          <p className="text-xs text-muted-foreground">
            When the models aren't sure what a receipt line is, search the web
            for its printed text and the store's name, then look again.{' '}
            {provider
              ? `Searches go to ${provider} and tell it what was bought where.`
              : 'No search provider is set up on the server, so nothing is searched.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Search for unsure receipt labels"
          disabled={!s}
          onClick={() => void toggle()}
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
            on ? 'bg-primary' : 'bg-muted',
          )}
        >
          <span
            className={cn(
              'block h-5 w-5 rounded-full bg-white transition-transform',
              on ? 'translate-x-5' : 'translate-x-0.5',
            )}
          />
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
