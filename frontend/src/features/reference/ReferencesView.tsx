import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { PageBar } from '@/components/PageBar';
import { useBack } from '@/lib/back';
import { cn } from '@/lib/utils';
import type { PromptInfo } from '@/domain/models';

const SOURCE_LABEL: Record<PromptInfo['source'], string> = {
  file: 'file',
  config: 'config',
  default: 'built-in',
};

function SourceBadge({ prompt }: { prompt: PromptInfo }) {
  return (
    <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">
      {SOURCE_LABEL[prompt.source]}
      {prompt.file ? ` · ${prompt.file}` : ''}
    </span>
  );
}

/**
 * Read-only viewer for the backend's prompt building blocks, exactly as the
 * runtime resolves them (GET /api/prompts). Deliberately no edit affordances —
 * the backend shelved editability and the API is view-only by design.
 */
export function ReferencesView() {
  const [prompts, setPrompts] = useState<PromptInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPrompts(await api.listPrompts());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load prompts');
      setPrompts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const detail = prompts?.find((p) => p.name === selected) ?? null;
  useBack(detail !== null, () => setSelected(null));

  if (detail) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1 border-b border-border px-2 py-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to references"
            onClick={() => setSelected(null)}
            className="h-9 w-9"
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
            {detail.name}
          </h2>
          <SourceBadge prompt={detail} />
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-3xl px-4 py-4">
            {detail.applies && (
              <p className="mb-2 text-xs text-muted-foreground">
                Applies to: {detail.applies}
              </p>
            )}
            {detail.note && (
              <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                {detail.note}
              </p>
            )}
            <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
              <Markdown>{detail.content}</Markdown>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageBar title="References">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          onClick={() => void load()}
          disabled={prompts === null}
          className="h-8 w-8 text-muted-foreground"
        >
          <RefreshCw className={cn('h-4 w-4', prompts === null && 'animate-spin')} />
        </Button>
      </PageBar>
      <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        The prompts the model actually receives — live from the backend, read-only.
      </p>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
        {prompts === null ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading prompts…
          </div>
        ) : prompts.length === 0 && !error ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            The backend didn’t report any prompts.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {prompts.map((p) => (
              <li key={p.name}>
                <button
                  type="button"
                  onClick={() => setSelected(p.name)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/60 active:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {p.name}
                      </span>
                      <SourceBadge prompt={p} />
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {p.description || p.applies}
                    </span>
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
