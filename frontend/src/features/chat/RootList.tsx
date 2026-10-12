import {
  MoreHorizontal,
  NotebookPen,
  Pencil,
  RefreshCw,
  Sprout,
  Trash2,
  TreePine,
} from 'lucide-react';
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
  /** Delete this conversation and everything in it (permanent, no confirm). */
  onDelete?: (rootId: number) => void;
  /** Open the three-dots card (summary + tags) for this chat. */
  onOpenCard: (root: TreeNode) => void;
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
  onCard,
}: {
  root: TreeNode;
  onOpen: () => void;
  onMenu: () => void;
  onCard: () => void;
}) {
  // Tap opens the chat; tap-and-hold (or right-click) opens the action menu.
  const press = useLongPress(onMenu, { onClick: onOpen });
  const count = turnCount(root);
  const isSeed = root.state === 'seed';
  return (
    <div className="flex items-center hover:bg-muted/60">
      <button
        type="button"
        {...press}
        title="Hold for options"
        className="flex min-w-0 flex-1 select-none items-center gap-3 py-3.5 pl-4 text-left [-webkit-touch-callout:none] active:bg-muted"
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
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">
              {count} {count === 1 ? 'turn' : 'turns'}
            </span>
            {/* An untagged chat visibly lacks tags: loose, not lost. */}
            {root.chatTags.length === 0 ? (
              <span className="shrink-0 italic opacity-70">· untagged</span>
            ) : (
              <span className="flex min-w-0 gap-1 overflow-hidden">
                {root.chatTags.map((t) => (
                  <span
                    key={t}
                    className="shrink-0 rounded bg-accent px-1.5 py-px text-[10px] text-accent-foreground"
                  >
                    {t}
                  </span>
                ))}
              </span>
            )}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`About ${rootLabel(root)}`}
        onClick={onCard}
        className="flex shrink-0 items-center self-stretch px-4 text-muted-foreground hover:text-foreground"
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
    </div>
  );
}

/**
 * A tappable list of conversation roots (Conversations tab and Chats/seeds
 * tab), sorted by most recent activity. Each row shows its chat tags (or
 * that it has none) and a three-dots control for the chat card; row actions
 * (rename / promote / synthesize) live behind tap-and-hold.
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
  onDelete,
  onOpenCard,
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
        ...(onDelete
          ? [
              {
                label: 'Delete',
                icon: Trash2,
                destructive: true,
                onSelect: () => onDelete(menuRoot.id),
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
                onCard={() => onOpenCard(root)}
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
