import { NotebookPen, Pencil, RefreshCw, Sprout, TreePine } from 'lucide-react';
import { useState } from 'react';
import { ActionSheet, type SheetAction } from '@/components/ActionSheet';
import { RenameSheet } from '@/components/RenameSheet';
import { useLongPress } from '@/lib/useLongPress';
import { rootLabel, type TreeNode } from '@/domain/models';

interface RootListProps {
  /** Conversation roots to list (already filtered by state), any order. */
  roots: TreeNode[];
  emptyTitle: string;
  emptyHint: string;
  onOpen: (root: TreeNode) => void;
  /** Rename a conversation via its root (renaming a seed also promotes it). */
  onRename: (rootId: number, name: string) => void;
  /** Present on the seeds list: graduate this chat to a full conversation. */
  onPromote?: (rootId: number) => void;
  /** Synthesize notes from this conversation (slow, backgrounded). */
  onSynthesize?: (rootId: number, label: string) => void;
  /** Regenerate the LLM-generated title for this conversation. */
  onRegenerateTitle?: (rootId: number) => void;
}

/** Count all turns in a subtree (shown as light row metadata). */
function turnCount(node: TreeNode): number {
  let n = 1;
  for (const c of node.children) n += turnCount(c);
  return n;
}

/** Newest turn id in a subtree — ids are monotonic, so this sorts by activity. */
function latestId(node: TreeNode): number {
  let max = node.id;
  for (const c of node.children) max = Math.max(max, latestId(c));
  return max;
}

function Row({
  root,
  onOpen,
  onMenu,
}: {
  root: TreeNode;
  onOpen: () => void;
  onMenu: () => void;
}) {
  // Tap opens the chat; tap-and-hold (or right-click) opens the action menu.
  const press = useLongPress(onMenu, { onClick: onOpen });
  const count = turnCount(root);
  const isSeed = root.state === 'seed';
  return (
    <button
      type="button"
      {...press}
      title="Hold for options"
      className="flex w-full select-none items-center gap-3 px-4 py-3.5 text-left [-webkit-touch-callout:none] hover:bg-muted/60 active:bg-muted"
    >
      {isSeed ? (
        <Sprout className="h-4 w-4 shrink-0 text-primary/70" />
      ) : (
        <TreePine className="h-4 w-4 shrink-0 text-primary/70" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {rootLabel(root)}
        </span>
        <span className="block text-xs text-muted-foreground">
          {count} {count === 1 ? 'turn' : 'turns'}
        </span>
      </span>
    </button>
  );
}

/**
 * A tappable list of conversation roots (Conversations tab and Chats/seeds
 * tab), sorted by most recent activity. Row actions (rename / promote /
 * synthesize) live behind tap-and-hold, keeping rows clean.
 */
export function RootList({
  roots,
  emptyTitle,
  emptyHint,
  onOpen,
  onRename,
  onPromote,
  onSynthesize,
  onRegenerateTitle,
}: RootListProps) {
  const [menuRoot, setMenuRoot] = useState<TreeNode | null>(null);
  const [renaming, setRenaming] = useState<TreeNode | null>(null);

  const sorted = [...roots].sort((a, b) => latestId(b) - latestId(a));

  const menuActions: SheetAction[] = menuRoot
    ? [
        {
          label: 'Rename',
          icon: Pencil,
          onSelect: () => setRenaming(menuRoot),
        },
        ...(onPromote && menuRoot.state === 'seed'
          ? [
              {
                label: 'Promote to conversation',
                icon: TreePine,
                onSelect: () => onPromote(menuRoot.id),
              },
            ]
          : []),
        ...(onSynthesize
          ? [
              {
                label: 'Synthesize notes',
                icon: NotebookPen,
                onSelect: () => onSynthesize(menuRoot.id, rootLabel(menuRoot)),
              },
            ]
          : []),
        ...(onRegenerateTitle
          ? [
              {
                label: 'Regenerate title',
                icon: RefreshCw,
                onSelect: () => onRegenerateTitle(menuRoot.id),
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className="flex h-full flex-col">
      {sorted.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground">
          <p className="text-lg font-medium text-foreground">{emptyTitle}</p>
          <p className="mt-1 text-sm">{emptyHint}</p>
        </div>
      ) : (
        <ul className="flex-1 divide-y divide-border overflow-y-auto overscroll-contain">
          {sorted.map((root) => (
            <li key={root.id}>
              <Row
                root={root}
                onOpen={() => onOpen(root)}
                onMenu={() => setMenuRoot(root)}
              />
            </li>
          ))}
        </ul>
      )}

      <ActionSheet
        open={menuRoot !== null}
        title={menuRoot ? rootLabel(menuRoot) : undefined}
        actions={menuActions}
        onClose={() => setMenuRoot(null)}
      />
      <RenameSheet
        open={renaming !== null}
        initial={renaming?.name ?? ''}
        onSave={(name) => renaming && onRename(renaming.id, name)}
        onClose={() => setRenaming(null)}
      />
    </div>
  );
}
