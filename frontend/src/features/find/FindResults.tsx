import {
  FileText,
  Film,
  NotebookText,
  Paperclip,
  Sprout,
  StickyNote,
  type LucideIcon,
} from 'lucide-react';
import { Fragment } from 'react';
import { parseApiDate } from '@/lib/utils';
import type { FindGroup, FindHit, FindScope } from './findApi';

export const SCOPE_LABEL: Record<FindScope, string> = {
  chats: 'Chats',
  notes: 'Notes',
  scratch: 'Scratch',
  transcripts: 'Transcripts',
  attachments: 'Attachments',
};

const ICON: Record<FindHit['type'], LucideIcon> = {
  chat: Sprout,
  note: NotebookText,
  scratch: StickyNote,
  transcript: Film,
  attachment: Paperclip,
};

/** The query's words in bold, case-insensitively. */
function Highlight({ text, q }: { text: string; q: string }) {
  const words = q
    .split(/\W+/)
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-primary/15 px-0.5 font-medium text-foreground">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function when(raw?: string | null): string | null {
  if (!raw) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00`) : parseApiDate(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function Hit({ hit, q, onOpen }: { hit: FindHit; q: string; onOpen: (h: FindHit) => void }) {
  const Icon = hit.type === 'attachment' && hit.kind === 'pdf' ? FileText : ICON[hit.type];
  const meta = [
    when(hit.when),
    hit.type === 'chat' && hit.matches && hit.matches > 1 ? `${hit.matches} matching turns` : null,
    hit.channel ?? null,
  ].filter(Boolean);
  return (
    <button
      type="button"
      onClick={() => onOpen(hit)}
      className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/60 active:bg-muted"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          <Highlight text={hit.title} q={q} />
        </span>
        {hit.snippet && (
          <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            <Highlight text={hit.snippet} q={q} />
          </span>
        )}
        {(meta.length > 0 || (hit.tags?.length ?? 0) > 0) && (
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {meta.length > 0 && <span className="shrink-0">{meta.join(' · ')}</span>}
            {hit.tags?.slice(0, 3).map((t) => (
              <span key={t} className="shrink-0 rounded bg-accent px-1 py-px text-[10px] text-accent-foreground">
                {t}
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Results grouped by pile, in the order the backend returns them. With
 * `onShowAll`, a pile that has more than it shows offers the rest.
 */
export function FindResults({
  groups,
  q,
  onOpen,
  onShowAll,
  showHeadings = true,
}: {
  groups: FindGroup[];
  q: string;
  onOpen: (hit: FindHit) => void;
  onShowAll?: (scope: FindScope) => void;
  showHeadings?: boolean;
}) {
  return (
    <div>
      {groups.map((g) => (
        <section key={g.scope} className="border-b border-border">
          {showHeadings && (
            <h3 className="flex items-baseline justify-between px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {SCOPE_LABEL[g.scope]}
              <span className="font-normal normal-case tracking-normal tabular-nums">{g.total}</span>
            </h3>
          )}
          <ul className="divide-y divide-border/60">
            {g.items.map((h) => (
              <li key={`${h.type}:${h.id}`}>
                <Hit hit={h} q={q} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          {onShowAll && g.total > g.items.length && (
            <button
              type="button"
              onClick={() => onShowAll(g.scope)}
              className="w-full px-4 py-2.5 text-left text-xs font-medium text-primary hover:bg-muted/60"
            >
              Show all {g.total} in {SCOPE_LABEL[g.scope]}
            </button>
          )}
        </section>
      ))}
    </div>
  );
}
