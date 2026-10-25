import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/api/collaborator';
import { rootLabel, type NoteMeta, type Transcript, type TreeNode } from '@/domain/models';
import { inferProjects, type NameOverrides, type ProjectItem } from './projectInference';

/** A project member (note, chat or transcript) with what its row needs. */
export interface Member extends ProjectItem {
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

export function time(iso: string | null): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function membersFrom(notes: NoteMeta[], roots: TreeNode[], transcripts: Transcript[]): Member[] {
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

/**
 * Everything tagged `project` and the names inferred over it (projectInference),
 * shared by the Projects view and a note's page so both name a project the
 * same way.
 */
export function useProjectInference(roots: TreeNode[]) {
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [overrides, setOverrides] = useState<NameOverrides>({ pinned: [], ignored: [] });
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    Promise.all([api.listNotes('project'), api.getProjectOverrides(),
                 api.listTranscripts({ tag: 'project' })])
      .then(([n, o, t]) => {
        setNotes(n);
        setOverrides(o);
        setTranscripts(t.items);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
        setNotes((prev) => prev ?? []);
      });
  }, []);

  useEffect(() => reload(), [reload]);

  const members = useMemo(() => membersFrom(notes ?? [], roots, transcripts),
    [notes, roots, transcripts]);
  const inference = useMemo(() => inferProjects(members, overrides), [members, overrides]);
  return { notes, members, inference, overrides, setOverrides, error, setError, reload };
}
