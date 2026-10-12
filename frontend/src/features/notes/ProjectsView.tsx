import { ChevronRight, FolderKanban, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/collaborator';
import { cn } from '@/lib/utils';
import type { NoteMeta } from '@/domain/models';
import { parseWallClock } from './eventFields';
import { facetsOf, inferProjects } from './projectInference';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** Days since the newest note in the set (created is the activity proxy). */
function daysQuiet(notes: NoteMeta[]): number | null {
  let newest: Date | null = null;
  for (const n of notes) {
    const d = n.created ? parseWallClock(n.created) : null;
    if (d && (!newest || d > newest)) newest = d;
  }
  if (!newest) return null;
  return Math.floor((Date.now() - newest.getTime()) / 86_400_000);
}

function NoteRow({
  note,
  onOpenNote,
}: {
  note: NoteMeta;
  onOpenNote: (title: string) => void;
}) {
  return (
    <li className="flex items-center gap-2 px-4 py-2.5">
      <button
        type="button"
        onClick={() => onOpenNote(note.title)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-sm font-medium text-foreground">
          {note.title}
        </span>
        {note.created && (
          <span className="text-xs text-muted-foreground">{note.created}</span>
        )}
      </button>
    </li>
  );
}

/**
 * The projects lens (2026-08-17 spec): everything tagged `project`; the
 * project NAME is inferred by exclusivity (projectInference.ts). Drilling is
 * pure set intersection over flat facet tags; breadcrumbs truncate — no
 * separate navigation state. Presentation is disposable by design.
 */
export function ProjectsView({
  onOpenNote,
}: {
  onOpenNote: (title: string) => void;
}) {
  const [universe, setUniverse] = useState<NoteMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // crumbs[0] = project name, rest = drilled facets. Empty = projects list.
  const [crumbs, setCrumbs] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .listNotes('project')
      .then((notes) => {
        if (!cancelled) setUniverse(notes);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(errMessage(err));
          setUniverse([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const inference = useMemo(
    () => (universe ? inferProjects(universe) : null),
    [universe],
  );

  if (universe === null || inference === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading projects…
      </div>
    );
  }

  const cluster =
    crumbs.length > 0
      ? inference.clusters.find((c) => c.name === crumbs[0])
      : null;
  // Drill scope: intersection of the cluster with every drilled facet.
  const scope = cluster
    ? cluster.notes.filter((n) =>
        crumbs.slice(1).every((f) => n.tags.includes(f)),
      )
    : [];

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumbs: tapping truncates to that position and re-intersects. */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-4 py-2 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          onClick={() => setCrumbs([])}
          className={cn(
            'shrink-0',
            crumbs.length === 0
              ? 'font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Projects
        </button>
        {crumbs.map((c, i) => (
          <span key={c} className="flex shrink-0 items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <button
              type="button"
              onClick={() => setCrumbs(crumbs.slice(0, i + 1))}
              className={cn(
                i === crumbs.length - 1
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {c}
            </button>
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {error && (
          <p className="px-4 py-2 text-sm text-destructive">{error}</p>
        )}

        {crumbs.length === 0 ? (
          // ---- Projects list: size and how long it's been quiet.
          inference.clusters.length === 0 &&
          inference.unassigned.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <FolderKanban className="mx-auto mb-3 h-8 w-8 opacity-40" />
              <p className="text-lg font-medium text-foreground">
                No projects yet
              </p>
              <p className="mt-1 px-8 text-sm">
                Tag notes with “project” plus the project's own tag — the
                clusters appear here on their own.
              </p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {inference.clusters.map((c) => {
                  const quiet = daysQuiet(c.notes);
                  return (
                    <li key={c.name}>
                      <button
                        type="button"
                        onClick={() => setCrumbs([c.name])}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/60 active:bg-muted"
                      >
                        <FolderKanban className="h-4 w-4 shrink-0 text-primary/70" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {c.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {c.notes.length}{' '}
                            {c.notes.length === 1 ? 'note' : 'notes'}
                            {quiet != null && quiet > 0 && ` · quiet ${quiet}d`}
                          </span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  );
                })}
              </ul>
              {inference.unassigned.length > 0 && (
                <div className="border-t border-border">
                  <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    No project tag yet
                  </p>
                  <ul className="divide-y divide-border">
                    {inference.unassigned.map((n) => (
                      <NoteRow
                        key={n.filename}
                        note={n}
                        onOpenNote={onOpenNote}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )
        ) : cluster == null ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            This project has no notes anymore.
          </p>
        ) : (
          // ---- Project profile / drill-down (same renderer; crumbs decide).
          <>
            {(() => {
              const facets = facetsOf(scope, crumbs);
              return facets.length > 0 ? (
                <div className="flex gap-1.5 overflow-x-auto border-b border-border px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {facets.map((f) => (
                    <button
                      key={f.tag}
                      type="button"
                      onClick={() => setCrumbs([...crumbs, f.tag])}
                      className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {f.tag} · {f.count}
                    </button>
                  ))}
                </div>
              ) : null;
            })()}
            {scope.length > 0 ? (
              <ul className="divide-y divide-border">
                {[...scope]
                  .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
                  .map((n) => (
                    <NoteRow key={n.filename} note={n} onOpenNote={onOpenNote} />
                  ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                Nothing here at this intersection.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
