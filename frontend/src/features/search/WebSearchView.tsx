import {
  Check,
  Copy,
  Lightbulb,
  Loader2,
  MessageSquare,
  Search,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '@/api/collaborator';
import { ApiRequestError } from '@/api/http';
import { Button } from '@/components/ui/button';
import { cleanUrl, cleanUrlsInText } from '@/lib/urlClean';
import type { WebSearch } from '@/domain/models';

// Session cache: the screen unmounts when you navigate away — returning
// should restore the last search instead of a blank page.
let lastSearch: {
  query: string;
  result: WebSearch | null;
  error: string | null;
} | null = null;

/**
 * Compose the "Ask Collaborator" draft: the full results page (answers,
 * infoboxes, numbered results with URLs and snippets) so the model reasons
 * over what YOU saw — and can fetch any of the URLs — with room at the end
 * for the user's actual question.
 */
function draftFromSearch(s: WebSearch): string {
  const lines: string[] = [`Web search results for "${s.query}":`, ''];
  for (const a of s.answers) lines.push(`Answer: ${a}`, '');
  for (const b of s.infoboxes) {
    lines.push(`${b.title ? `${b.title}: ` : ''}${b.content}`, '');
  }
  s.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`, `   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  lines.push('', '');
  return lines.join('\n');
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * SearXNG relays whatever the engines return — only http(s) may become a
 * clickable href (a javascript: URL here would run in the app origin).
 */
function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? cleanUrl(url) : '#';
}

function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Copy URL"
      title="Copy URL"
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="h-8 w-8 shrink-0 text-muted-foreground"
    >
      {copied ? (
        <Check className="h-4 w-4 text-primary" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </Button>
  );
}

/**
 * Raw web search (GET /api/search → private SearXNG). No LLM anywhere in the
 * search path; the escape hatches hand off to a new chat where the model
 * fetches pages itself.
 */
export function WebSearchView({
  onStartChat,
}: {
  /** Open a new seed chat with this draft in the composer. */
  onStartChat: (draft: string) => void;
}) {
  const [query, setQuery] = useState(() => lastSearch?.query ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WebSearch | null>(
    () => lastSearch?.result ?? null,
  );
  const [error, setError] = useState<string | null>(
    () => lastSearch?.error ?? null,
  );
  const [unconfigured, setUnconfigured] = useState(false);

  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.searchWeb(q);
      setResult(res);
      lastSearch = { query: q, result: res, error: null };
    } catch (err) {
      setResult(null);
      if (err instanceof ApiRequestError && err.status === 503) {
        // Search isn't configured on this server — disable the UI.
        setUnconfigured(true);
      } else {
        // 502 = engines failed (detail lists per-engine reasons). This is a
        // FAILURE, deliberately distinct from a genuine empty result set.
        const msg = `Search failed: ${err instanceof Error ? err.message : 'unknown error'}`;
        setError(msg);
        lastSearch = { query: q, result: null, error: msg };
      }
    } finally {
      setBusy(false);
    }
  };

  if (unconfigured) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        <p className="text-lg font-medium text-foreground">
          Web search isn’t configured
        </p>
        <p className="mt-1 text-sm">
          Set <code className="text-xs">tools.web_search.url</code> on the
          backend to enable it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <form onSubmit={(e) => void run(e)} className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the web…"
              className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
            />
          </div>
          <Button type="submit" disabled={busy || !query.trim()} className="h-9">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Search'}
          </Button>
        </form>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Private SearXNG — no model involved, nothing saved to conversations.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl">
          {error && (
            <p className="px-4 py-3 text-sm text-destructive">{error}</p>
          )}

          {result && (
            <>
              {/* Engine health (41f2a61): silent when everything answered; a
                  degraded search must be visible — the instance once ran
                  weeks on Brave alone and nothing showed it. */}
              {result.enginesFailed.length > 0 && (
                <details className="mx-4 mt-3 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700">
                  <summary className="cursor-pointer select-none font-medium">
                    Partial coverage — {result.enginesFailed.length}{' '}
                    {result.enginesFailed.length === 1 ? 'engine' : 'engines'}{' '}
                    down
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {result.enginesFailed.map((f) => (
                      <li key={f.engine}>
                        {f.engine}
                        {f.reason ? ` — ${f.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                  {Object.keys(result.enginesResponded).length > 0 && (
                    <p className="mt-1 opacity-80">
                      Answered:{' '}
                      {Object.entries(result.enginesResponded)
                        .map(([e, n]) => `${e} (${n})`)
                        .join(', ')}
                    </p>
                  )}
                </details>
              )}
              {/* Direct answers / infoboxes, when SearXNG has them. */}
              {result.answers.map((a, i) => (
                <div
                  key={`ans-${i}`}
                  className="mx-4 mt-3 flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-2.5 text-sm"
                >
                  <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="whitespace-pre-wrap break-words">{a}</p>
                </div>
              ))}
              {result.infoboxes.map((b, i) => (
                <div
                  key={`box-${i}`}
                  className="mx-4 mt-3 rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm"
                >
                  {b.title && <p className="mb-1 font-medium">{b.title}</p>}
                  <p className="whitespace-pre-wrap break-words text-muted-foreground">
                    {b.content}
                  </p>
                </div>
              ))}

              {result.results.length === 0 && !error ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  No results for “{result.query}”.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-border">
                  {result.results.map((r) => (
                    <li key={r.url} className="flex items-start gap-1 px-4 py-3">
                      <a
                        href={safeHref(r.url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 flex-1"
                      >
                        <span className="block truncate text-sm font-medium text-primary">
                          {r.title}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {host(r.url)}
                          {r.engine ? ` · ${r.engine}` : ''}
                        </span>
                        {r.snippet && (
                          <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                            {r.snippet}
                          </span>
                        )}
                      </a>
                      <CopyUrlButton url={cleanUrl(r.url)} />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Chat about this page"
                        title="Chat about this page — the model reads it first"
                        onClick={() => onStartChat(`${cleanUrl(r.url)}\n\n`)}
                        className="h-8 w-8 shrink-0 text-muted-foreground"
                      >
                        <MessageSquare className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Escalation: hand the WHOLE results page to the model (new
                  seed chat) — it reasons over what you saw and can fetch any
                  of the URLs; your question goes underneath. */}
              <button
                type="button"
                onClick={() => onStartChat(cleanUrlsInText(draftFromSearch(result)))}
                className="mx-4 my-4 flex w-[calc(100%-2rem)] items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-primary hover:bg-primary/10"
              >
                <MessageSquare className="h-4 w-4" />
                Ask Collaborator about “{result.query}”
              </button>
            </>
          )}

          {!result && !error && !busy && (
            <div className="py-16 text-center text-muted-foreground">
              <p className="text-lg font-medium text-foreground">
                Search the web
              </p>
              <p className="mt-1 text-sm">
                Raw results from your own SearXNG — hand any of them to the
                model when you want to go deeper.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
