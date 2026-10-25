import type { Note, TreeNode } from '@/domain/models';
import { NoteTeamPanel } from '@/features/agents/ProjectTeam';
import { nameFor } from './projectInference';
import { useProjectInference } from './useProjectInference';

/** A project note's team panel, its project named exactly as the Projects
 * view names it. Mounted only for notes tagged `project`. */
export function ProjectNoteTeam({ note, roots, onOpenProject }: {
  note: Note;
  roots: TreeNode[];
  onOpenProject: (tag: string) => void;
}) {
  const { inference, notes } = useProjectInference(roots);
  if (notes === null) return null;
  const tag = nameFor(`note:${note.filename}`, inference);
  if (!tag) return null;
  return <NoteTeamPanel note={{ title: note.title, body: note.body }} tag={tag}
                        onOpenProject={onOpenProject} />;
}
