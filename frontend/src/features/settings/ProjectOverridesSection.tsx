import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/api/collaborator';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/**
 * Settings → Project names (UX doc, How a project forms): the overrides
 * made from the Projects screen — tags pinned as project names, or ignored
 * as not names — kept as a small visible list so they're never hidden state.
 * Removing one returns the tag to plain inference.
 */
export function ProjectOverridesSection({ open }: { open: boolean }) {
  const [o, setO] = useState<{ pinned: string[]; ignored: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.getProjectOverrides()
      .then((v) => { if (!cancelled) setO(v); })
      .catch((err) => { if (!cancelled) setError(errMessage(err)); });
    return () => { cancelled = true; };
  }, [open]);

  if (!o || (o.pinned.length === 0 && o.ignored.length === 0)) {
    return error ? <p className="mt-5 text-xs text-destructive">{error}</p> : null;
  }

  const remove = (tag: string) => {
    const next = { pinned: o.pinned.filter((t) => t !== tag),
                   ignored: o.ignored.filter((t) => t !== tag) };
    const prev = o;
    setO(next);
    api.setProjectOverrides(next).then(setO).catch((err) => {
      setO(prev);
      setError(errMessage(err));
    });
  };

  const row = (label: string, tags: string[]) =>
    tags.length > 0 && (
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span key={t} className="flex items-center gap-1 rounded-full bg-accent py-0.5 pl-2.5 pr-1 text-xs text-accent-foreground">
              {t}
              <button type="button" aria-label={`Remove override for ${t}`} onClick={() => remove(t)}
                      className="rounded-full p-0.5 hover:bg-background/60">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      </div>
    );

  return (
    <div className="mt-5 space-y-2 border-t border-border pt-4">
      <p className="text-sm font-medium">Project names</p>
      <p className="text-xs text-muted-foreground">
        Corrections made on the Projects screen. Remove one to let the tag be
        inferred again.
      </p>
      {row('Always a project name', o.pinned)}
      {row('Never a project name', o.ignored)}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
