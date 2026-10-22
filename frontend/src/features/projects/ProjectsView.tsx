import {
  Bot,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  FileText,
  FileVideo,
  FolderKanban,
  Loader2,
  MessageSquare,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { agentsApi, connectAgentsLive, type AgentProject } from '@/api/agents';
import { api } from '@/api/collaborator';
import { request } from '@/api/http';
import { ActionSheet, type SheetAction } from '@/components/ActionSheet';
import { Button } from '@/components/ui/button';
import { rootLabel, type NoteMeta, type Transcript, type TreeNode } from '@/domain/models';
import { AgentArea } from '@/features/agents/AgentArea';
import { useLongPress } from '@/lib/useLongPress';
import { inferProjects, type NameOverrides, type ProjectItem } from './projectInference';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** A project member (note, chat or transcript) with what its row needs. */
interface Member extends ProjectItem {
  kind: 'note' | 'chat' | 'transcript';
  title: string;
  /** Sort key, newest first: last edit (notes), newest turn id (chats), date. */
  order: number;
  /** Shown under the title (notes: last edited; transcripts: when). */
  when: string | null;
  note?: NoteMeta;
  root?: TreeNode;
  transcriptId?: number;
}

/** Newest turn id in a subtree; ids are monotonic, so this sorts by activity. */
function latestId(node: TreeNode): number {
  let max = node.id;
  for (const c of node.children) max = Math.max(max, latestId(c));
  return max;
}

function time(iso: string | null): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function shortDate(iso: string | null): string | null {
  const t = time(iso);
  if (!t) return null;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

function membersFrom(notes: NoteMeta[], roots: TreeNode[], transcripts: Transcript[]): Member[] {
  return [
    ...notes.map((n) => ({
      key: `note:${n.filename}`, tags: n.tags, kind: 'note' as const, title: n.title,
      order: time(n.edited ?? n.created), when: n.edited ?? n.created, note: n })),
    ...roots
      .filter((r) => r.chatTags.includes('project'))
      .map((r) => ({ key: `chat:${r.id}`, tags: r.chatTags, kind: 'chat' as const,
                     title: rootLabel(r), order: latestId(r), when: null, root: r })),
    ...transcripts.map((t) => ({
      key: `transcript:${t.id}`, tags: t.tags, kind: 'transcript' as const,
      title: t.title ?? t.url, order: time(t.createdAt), when: t.createdAt, transcriptId: t.id })),
  ];
}

function counts(items: Member[]): string {
  const n = (kind: Member['kind']) => items.filter((i) => i.kind === kind).length;
  const part = (c: number, w: string) => (c ? `${c} ${w}${c === 1 ? '' : 's'}` : null);
  return [part(n('chat'), 'chat'), part(n('note'), 'note'), part(n('transcript'), 'transcript')]
    .filter(Boolean).join(' · ');
}

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-[18px] text-primary-foreground">
      {n}
    </span>
  );
}

function ProjectRow({ name, subtitle, waiting, onOpen, onMenu }: {
  name: string; subtitle: string; waiting: number; onOpen: () => void; onMenu?: () => void;
}) {
  const press = useLongPress(onMenu ?? (() => {}), { onClick: onOpen });
  return (
    <button type="button" {...press} title={onMenu ? 'Hold for options' : undefined}
            className="flex w-full select-none items-center gap-3 px-4 py-3 text-left [-webkit-touch-callout:none] hover:bg-muted/60 active:bg-muted">
      <FolderKanban className="h-4 w-4 shrink-0 text-primary/70" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      </span>
      <Badge n={waiting} />
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

const SHOWN = 5;

/** One section of the project page: the five most recent, then "show all". */
function Section({ label, icon: Icon, items, onOpen }: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  items: Member[];
  onOpen: (m: Member) => void;
}) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <section className="border-b border-border py-2">
      <p className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </p>
      <ul>
        {shown.map((m) => (
          <li key={m.key}>
            <button type="button" onClick={() => onOpen(m)}
                    className="flex w-full items-baseline gap-3 px-4 py-2 text-left hover:bg-muted/60 active:bg-muted">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{m.title}</span>
              {m.when && shortDate(m.when) && (
                <span className="shrink-0 text-[11px] text-muted-foreground">{shortDate(m.when)}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {items.length > SHOWN && (
        <button type="button" onClick={() => setAll((a) => !a)}
                className="px-4 py-1.5 text-xs font-medium text-primary">
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}

/** What the app shell asks for: open a project, maybe straight into its agents. */
export interface ProjectRequest {
  project: string;
  agents?: boolean;
  channel?: { endpointId: string; channel: string } | null;
  nonce: number;
}

/**
 * Projects (UX doc, Projects): a project is whatever wears `project` plus one
 * name tag. Every project opens on the same plain page, agents or not: an
 * Agents row when a backend serves it, then chats, notes and transcripts,
 * most recent first, five each with "show all". Vertical only. Names are
 * inferred by exclusivity; a misfire is fixed with an override (hold a
 * project: not a name), listed in Settings. Nothing is retagged.
 */
export function ProjectsView({
  roots,
  request: req,
  onRequestDone,
  onOpenNote,
  onOpenChat,
  onOpenTranscript,
}: {
  /** Conversation roots (their chat tags place chats in projects). */
  roots: TreeNode[];
  request?: ProjectRequest | null;
  /** The request was acted on (so a later visit doesn't replay it). */
  onRequestDone?: () => void;
  onOpenNote: (title: string) => void;
  onOpenChat: (root: TreeNode) => void;
  onOpenTranscript: (id: number) => void;
}) {
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [overrides, setOverrides] = useState<NameOverrides>({ pinned: [], ignored: [] });
  const [agentProjects, setAgentProjects] = useState<AgentProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState<{ channel: ProjectRequest['channel'] } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
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
    // Agents are optional: no endpoints (or the feature off) is just none.
    agentsApi.projects().then(setAgentProjects).catch(() => setAgentProjects([]));
  }, []);

  useEffect(() => load(), [load]);

  // Badges follow the agents live: a new question or flagged message, an
  // answer, a channel read. Coalesced, since a busy team is chatty.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        agentsApi.projects().then(setAgentProjects).catch(() => {});
      }, 800);
    };
    const stop = connectAgentsLive((e) => {
      if (e.type === 'message' || e.type === 'discovery' || e.type === 'endpoint' ||
          e.type === 'health') refresh();
    }, refresh);
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    setOpen(req.project);
    setAgentsOpen(req.agents ? { channel: req.channel ?? null } : null);
    onRequestDone?.();
  }, [req, onRequestDone]);

  const members = useMemo(() => membersFrom(notes ?? [], roots, transcripts),
    [notes, roots, transcripts]);
  const inference = useMemo(() => inferProjects(members, overrides), [members, overrides]);
  const agentsByTag = useMemo(() => new Map(agentProjects.map((p) => [p.tag, p])), [agentProjects]);
  const known = useMemo(() => new Set(inference.clusters.map((c) => c.name)), [inference]);
  // A backend tag with no notes here yet: offered as a project to open.
  const backendOnly = agentProjects.filter((p) => !known.has(p.tag));

  const ignore = (tag: string) => {
    const next = { pinned: overrides.pinned.filter((t) => t !== tag),
                   ignored: [...new Set([...overrides.ignored, tag])] };
    const prev = overrides;
    setOverrides(next);                                         // optimistic
    api.setProjectOverrides(next).then(setOverrides).catch((err) => {
      setOverrides(prev);
      setError(errMessage(err));
    });
  };

  /** Opening a backend-only tag creates the project: its name note. */
  const openBackendOnly = async (tag: string) => {
    setCreating(tag);
    setError(null);
    try {
      const { draft } = await request<{ draft: { id: number } }>('/api/notes/drafts', {
        method: 'POST',
        body: JSON.stringify({ title: tag, body: `The ${tag} project.`, tags: ['project', tag] }),
      });
      await api.approveDraft(draft.id);
      load();
      setOpen(tag);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setCreating(null);
    }
  };

  const openMember = (m: Member) => {
    if (m.kind === 'note' && m.note) onOpenNote(m.note.title);
    else if (m.root) onOpenChat(m.root);
    else if (m.transcriptId != null) onOpenTranscript(m.transcriptId);
  };

  if (open && agentsOpen) {
    return (
      <AgentArea tag={open} initialChannel={agentsOpen.channel}
                 onBack={() => { setAgentsOpen(null); load(); }} />
    );
  }

  if (notes === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading projects…
      </div>
    );
  }

  if (open) {
    const cluster = inference.clusters.find((c) => c.name === open);
    const items = [...(cluster?.items ?? [])].sort((a, b) => b.order - a.order);
    const agent = agentsByTag.get(open);
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1 border-b border-border px-2 py-3">
          <Button variant="ghost" size="icon" aria-label="Back to projects"
                  onClick={() => setOpen(null)} className="h-9 w-9">
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{open}</h2>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {agent && (
            <button type="button" onClick={() => setAgentsOpen({ channel: null })}
                    className="flex w-full items-center gap-3 border-b border-border px-4 py-3.5 text-left hover:bg-muted/60 active:bg-muted">
              <Bot className="h-4 w-4 shrink-0 text-primary/70" />
              <span className="flex-1 text-sm font-medium text-foreground">Agents</span>
              <Badge n={agent.waiting} />
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          )}
          {items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              Nothing here yet. Tag a chat, note or transcript with “project” and “{open}”.
            </p>
          ) : (
            <>
              <Section label="Chats" icon={MessageSquare} items={items.filter((m) => m.kind === 'chat')}
                       onOpen={openMember} />
              <Section label="Notes" icon={FileText} items={items.filter((m) => m.kind === 'note')}
                       onOpen={openMember} />
              <Section label="Transcripts" icon={FileVideo}
                       items={items.filter((m) => m.kind === 'transcript')} onOpen={openMember} />
            </>
          )}
        </div>
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
        {inference.clusters.length === 0 && inference.unassigned.length === 0 &&
         backendOnly.length === 0 ? (
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
                  <ProjectRow name={c.name} subtitle={counts(c.items as Member[])}
                              waiting={agentsByTag.get(c.name)?.waiting ?? 0}
                              onOpen={() => setOpen(c.name)}
                              onMenu={() => setMenu({ title: c.name, actions: [
                                { label: 'Not a project name', icon: EyeOff, onSelect: () => ignore(c.name) },
                              ] })} />
                </li>
              ))}
              {backendOnly.map((p) => (
                <li key={`agents:${p.tag}`}>
                  <ProjectRow name={p.tag}
                              subtitle={creating === p.tag ? 'Creating…' : 'Agents only — open to start the project'}
                              waiting={p.waiting} onOpen={() => void openBackendOnly(p.tag)} />
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
