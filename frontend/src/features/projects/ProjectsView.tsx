import {
  ChevronLeft,
  ChevronRight,
  EyeOff,
  FileText,
  FileVideo,
  FolderKanban,
  Loader2,
  MessageSquare,
  Pin,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/api/collaborator';
import { ActionSheet, type SheetAction } from '@/components/ActionSheet';
import { Button } from '@/components/ui/button';
import { rootLabel, type NoteMeta, type Transcript, type TreeNode } from '@/domain/models';
import { useLongPress } from '@/lib/useLongPress';
import { cn } from '@/lib/utils';
import {
  facetsOf,
  inferProjects,
  type NameOverrides,
  type ProjectItem,
} from './projectInference';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** A project member (note, chat or transcript) with what the shelves need. */
interface Member extends ProjectItem {
  kind: 'note' | 'chat' | 'transcript';
  title: string;
  note?: NoteMeta;
  root?: TreeNode;
  transcriptId?: number;
}

function membersFrom(notes: NoteMeta[], roots: TreeNode[], transcripts: Transcript[]): Member[] {
  return [
    ...notes.map((n) => ({ key: `note:${n.filename}`, tags: n.tags, kind: 'note' as const,
                           title: n.title, note: n })),
    ...roots
      .filter((r) => r.chatTags.includes('project'))
      .map((r) => ({ key: `chat:${r.id}`, tags: r.chatTags, kind: 'chat' as const,
                     title: rootLabel(r), root: r })),
    ...transcripts.map((t) => ({ key: `transcript:${t.id}`, tags: t.tags,
                                 kind: 'transcript' as const, title: t.title ?? t.url,
                                 transcriptId: t.id })),
  ];
}

function counts(items: Member[]): string {
  const n = (kind: Member['kind']) => items.filter((i) => i.kind === kind).length;
  const part = (c: number, w: string) => (c ? `${c} ${w}${c === 1 ? '' : 's'}` : null);
  return [part(n('note'), 'note'), part(n('chat'), 'chat'), part(n('transcript'), 'transcript')]
    .filter(Boolean).join(' · ');
}

function ProjectRow({ name, items, onOpen, onMenu }: {
  name: string; items: Member[]; onOpen: () => void; onMenu: () => void;
}) {
  const press = useLongPress(onMenu, { onClick: onOpen });
  return (
    <button type="button" {...press} title="Hold for options"
            className="flex w-full select-none items-center gap-3 px-4 py-3 text-left [-webkit-touch-callout:none] hover:bg-muted/60 active:bg-muted">
      <FolderKanban className="h-4 w-4 shrink-0 text-primary/70" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">{counts(items)}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** One horizontally scrolling lane of cards (UX doc: shelves, with a count). */
function Shelf({ label, icon: Icon, items, onOpen }: {
  label: string;
  icon: typeof FileText;
  items: Member[];
  onOpen: (m: Member) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="py-3">
      <p className="mb-2 flex items-center gap-1.5 px-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label} · {items.length}
      </p>
      <div className="flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((m) => (
          <button key={m.key} type="button" onClick={() => onOpen(m)}
                  className="flex w-40 shrink-0 flex-col gap-1 rounded-lg border border-border bg-card p-2.5 text-left hover:bg-muted/60 active:bg-muted">
            <span className="line-clamp-2 text-sm font-medium text-foreground">{m.title}</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {m.tags.filter((t) => t !== 'project').join(', ')}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Projects (UX doc, Projects): a project is whatever wears `project` plus one
 * name tag — notes, chats and transcripts alike — and every project gets the
 * same base view: a shelf for each, filtered by kind tags (bug,
 * feature). Names are inferred by exclusivity; misfires are fixed with an
 * override (hold a project: not a name; hold a kind tag: treat as a name),
 * listed in Settings. Nothing is retagged.
 */
export function ProjectsView({
  roots,
  onOpenNote,
  onOpenChat,
  onOpenTranscript,
}: {
  /** Conversation roots (their chat tags place chats in projects). */
  roots: TreeNode[];
  onOpenNote: (title: string) => void;
  onOpenChat: (root: TreeNode) => void;
  onOpenTranscript: (id: number) => void;
}) {
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [overrides, setOverrides] = useState<NameOverrides>({ pinned: [], ignored: [] });
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [facet, setFacet] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ title: string; actions: SheetAction[] } | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.listNotes('project'), api.getProjectOverrides(),
                 api.listTranscripts({ tag: 'project' })])
      .then(([n, o, t]) => {
        setNotes(n);
        setOverrides(o);
        setTranscripts(t.items);
      })
      .catch((err) => {
        setError(errMessage(err));
        setNotes((prev) => prev ?? []);
      });
  }, []);

  useEffect(() => load(), [load]);

  const members = useMemo(() => membersFrom(notes ?? [], roots, transcripts),
    [notes, roots, transcripts]);
  const inference = useMemo(() => inferProjects(members, overrides), [members, overrides]);

  const saveOverrides = (next: NameOverrides) => {
    const prev = overrides;
    setOverrides(next);                                         // optimistic
    api.setProjectOverrides(next).then(setOverrides).catch((err) => {
      setOverrides(prev);
      setError(errMessage(err));
    });
  };
  const ignore = (tag: string) =>
    saveOverrides({ pinned: overrides.pinned.filter((t) => t !== tag),
                    ignored: [...new Set([...overrides.ignored, tag])] });
  const pin = (tag: string) =>
    saveOverrides({ pinned: [...new Set([...overrides.pinned, tag])],
                    ignored: overrides.ignored.filter((t) => t !== tag) });

  const openMember = (m: Member) => {
    if (m.kind === 'note' && m.note) onOpenNote(m.note.title);
    else if (m.root) onOpenChat(m.root);
    else if (m.transcriptId != null) onOpenTranscript(m.transcriptId);
  };

  if (notes === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading projects…
      </div>
    );
  }

  const cluster = open ? inference.clusters.find((c) => c.name === open) : null;

  if (open) {
    const scope = (cluster?.items ?? []).filter((m) => !facet || m.tags.includes(facet));
    const facets = facetsOf(cluster?.items ?? [], [open]);
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1 border-b border-border px-2 py-3">
          <Button variant="ghost" size="icon" aria-label="Back to projects"
                  onClick={() => { setOpen(null); setFacet(null); }} className="h-9 w-9">
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{open}</h2>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {facets.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto border-b border-border px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {facets.map((f) => (
                <FacetChip key={f.tag} tag={f.tag} count={f.count} active={facet === f.tag}
                           onToggle={() => setFacet(facet === f.tag ? null : f.tag)}
                           onMenu={() => setMenu({ title: f.tag, actions: [
                             { label: 'Treat as a project name', icon: Pin, onSelect: () => pin(f.tag) },
                           ] })} />
              ))}
            </div>
          )}
          {!cluster || scope.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              {cluster ? 'Nothing here with that tag.' : 'This project has nothing in it anymore.'}
            </p>
          ) : (
            <>
              <Shelf label="Notes" icon={FileText} items={scope.filter((m) => m.kind === 'note')}
                     onOpen={openMember} />
              <Shelf label="Chats" icon={MessageSquare} items={scope.filter((m) => m.kind === 'chat')}
                     onOpen={openMember} />
              <Shelf label="Transcripts" icon={FileVideo}
                     items={scope.filter((m) => m.kind === 'transcript')} onOpen={openMember} />
            </>
          )}
        </div>
        <ActionSheet open={menu !== null} title={menu?.title} actions={menu?.actions ?? []}
                     onClose={() => setMenu(null)} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-2xl font-semibold">Projects</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-2 text-sm text-destructive">{error}</p>}
        {inference.clusters.length === 0 && inference.unassigned.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground">
            <FolderKanban className="mx-auto mb-3 h-8 w-8 opacity-40" />
            <p className="text-lg font-medium text-foreground">No projects yet</p>
            <p className="mt-1 px-8 text-sm">
              Tag notes, chats or transcripts with “project” plus the project's name — it appears here on its own.
            </p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {inference.clusters.map((c) => (
                <li key={c.name}>
                  <ProjectRow name={c.name} items={c.items as Member[]}
                              onOpen={() => setOpen(c.name)}
                              onMenu={() => setMenu({ title: c.name, actions: [
                                { label: 'Not a project name', icon: EyeOff, onSelect: () => ignore(c.name) },
                              ] })} />
                </li>
              ))}
            </ul>
            {inference.unassigned.length > 0 && (
              <div className="border-t border-border">
                <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Tagged project, no name yet
                </p>
                <ul className="divide-y divide-border">
                  {(inference.unassigned as Member[]).map((m) => (
                    <li key={m.key}>
                      <button type="button" onClick={() => openMember(m)}
                              className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/60">
                        {m.kind === 'note' ? <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          : m.kind === 'chat' ? <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                          : <FileVideo className="h-4 w-4 shrink-0 text-muted-foreground" />}
                        <span className="min-w-0 flex-1 truncate text-sm">{m.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
      <ActionSheet open={menu !== null} title={menu?.title} actions={menu?.actions ?? []}
                   onClose={() => setMenu(null)} />
    </div>
  );
}

function FacetChip({ tag, count, active, onToggle, onMenu }: {
  tag: string; count: number; active: boolean; onToggle: () => void; onMenu: () => void;
}) {
  const press = useLongPress(onMenu, { onClick: onToggle });
  return (
    <button type="button" {...press} aria-pressed={active}
            className={cn('shrink-0 select-none rounded-full border px-2.5 py-1 text-xs [-webkit-touch-callout:none]',
              active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
      {tag} · {count}
    </button>
  );
}
