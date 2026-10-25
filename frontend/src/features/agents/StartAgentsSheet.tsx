import { FileText, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/api/collaborator';
import { agentsApi, type TeamRequest } from '@/api/agents';
import { Button } from '@/components/ui/button';
import type { NoteMeta } from '@/domain/models';
import { cn } from '@/lib/utils';
import { useModalA11y } from '@/lib/useModalA11y';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** What the team accepts as a project name (it becomes the repo's name). */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

/** A note's first line of prose (a heading only when there's nothing
 * else), for the one-line description. */
export function firstLine(body: string): string {
  const lines = body.split('\n').map((l) => l.trim())
    .filter((l) => l && !/^([-*_])\1{2,}$/.test(l));
  const pick = lines.find((l) => !l.startsWith('#')) ?? lines[0] ?? '';
  const line = pick.replace(/^(#+|[-*+]|\d+\.|>)\s*/, '')
    .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_m, a, _b, c) => c ?? a)
    .replace(/[*_`]/g, '').trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/** Pick a note whose body becomes the intents: the project's own notes first. */
function NotePicker({ suggestions, onPick }: {
  suggestions: string[];
  onPick: (body: string, title: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<NoteMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      api.searchNotes(q.trim(), 'keyword', 6).then(setHits).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const titles = q.trim().length >= 2 ? hits.map((n) => n.title) : suggestions.slice(0, 6);
  return (
    <div className="rounded border border-border p-1.5">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a note"
             aria-label="Find a note for the intents"
             className="w-full bg-transparent px-1 py-0.5 text-base outline-none sm:text-sm" />
      {titles.map((title) => (
        <button key={title} type="button"
                onClick={() => {
                  setError(null);
                  api.getNote(title).then((note) => onPick(note.body, note.title))
                    .catch((err) => setError(errMessage(err)));
                }}
                className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-sm hover:bg-muted">
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{title}</span>
        </button>
      ))}
      {error && <p className="px-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

const field = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-base outline-none focus:border-primary sm:text-sm';

/**
 * Start agents on a project that already exists here: the name is the
 * project's own tag, never typed; the intents come from a note (the one it
 * was opened from, or one picked). Nothing is sent until Start. Opened from a
 * project note or the project view; the PM sets up the repo from it.
 */
export function StartAgentsSheet({
  open,
  tag,
  note = null,
  suggestions = [],
  onClose,
  onStarted,
}: {
  open: boolean;
  tag: string;
  /** The note it was opened from: its body becomes the intents. */
  note?: { title: string; body: string } | null;
  /** The project's notes, offered first when picking one for the intents. */
  suggestions?: string[];
  onClose: () => void;
  onStarted: (r: TeamRequest) => void;
}) {
  const panelRef = useModalA11y<HTMLDivElement>(open, onClose);
  const [description, setDescription] = useState('');
  const [roles, setRoles] = useState('');
  const [intents, setIntents] = useState('');
  const [fromNote, setFromNote] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [kickoff, setKickoff] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from the note as it is now.
  const noteTitle = note?.title ?? null;
  const noteBody = note?.body ?? '';
  useEffect(() => {
    if (!open) return;
    setDescription(noteTitle ? firstLine(noteBody) : '');
    setIntents(noteBody);
    setFromNote(noteTitle);
    setPicking(!noteTitle);
    setRoles('');
    setKickoff('');
    setError(null);
  }, [open, noteTitle, noteBody]);

  if (!open) return null;
  const nameOk = NAME_RE.test(tag);
  const ready = nameOk && description.trim() && intents.trim();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onStarted(await agentsApi.createProject({
        name: tag, description,
        roles: roles.split(/[\s,]+/).map((r) => r.trim()).filter(Boolean),
        intentsMd: intents, kickoff, noteTitle: fromNote ?? undefined,
      }));
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={`Start agents on ${tag}`}
           tabIndex={-1}
           className="pb-safe relative max-h-[90vh] w-full space-y-3 overflow-y-auto rounded-t-2xl border border-border bg-card px-5 py-4 text-sm outline-none sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
            Start agents on <span className="font-mono">{tag}</span>
          </h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </div>
        {!nameOk && (
          <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            “{tag}” can't be the repo's name: it needs 2–39 lowercase letters, digits and hyphens,
            not starting with a hyphen. Rename the project's tag to start agents on it.
          </p>
        )}
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">One-line description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={field} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Roles (optional; empty means the team's usual ones)</span>
          <input value={roles} onChange={(e) => setRoles(e.target.value.toLowerCase())}
                 placeholder="pm, backend, auditor" className={field} autoCapitalize="none" />
        </label>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-muted-foreground">
              Intents{fromNote ? <> from “{fromNote}”</> : null}
            </span>
            <button type="button" onClick={() => setPicking((p) => !p)}
                    className="text-xs text-primary underline-offset-2 hover:underline">
              {picking ? 'Type them' : 'Use another note'}
            </button>
          </div>
          {picking && (
            <NotePicker suggestions={suggestions} onPick={(body, title) => {
              setIntents(body);
              setFromNote(title);
              if (!description.trim()) setDescription(firstLine(body));
              setPicking(false);
            }} />
          )}
          <textarea value={intents} onChange={(e) => { setIntents(e.target.value); setFromNote(null); }}
                    rows={7} placeholder="# What it's for…" className={cn(field, 'resize-y font-mono')} />
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Kickoff for the PM (optional)</span>
          <textarea value={kickoff} onChange={(e) => setKickoff(e.target.value)} rows={2}
                    className={cn(field, 'resize-y')} />
        </label>
        <p className="text-xs text-muted-foreground">
          The PM sets up the repo from these intents. The intents are a copy: editing the note later
          doesn't change the project. A repo can't be uncreated, but you can withdraw the request
          until the work starts.
        </p>
        <div className="flex gap-2">
          <Button disabled={busy || !ready} onClick={() => void submit()} className="gap-1.5">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Start agents
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}
