import { Pencil, Sprout, TreePine } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { TreeNode } from '@/domain/models';

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

/**
 * A tappable list of conversation roots (used for both the Conversations tab
 * and the Chats/seeds tab), sorted by most recent activity. Titles fall back
 * to the root's preview until a name is set (or the backend grows
 * auto-generated titles).
 */
export function RootList({
  roots,
  emptyTitle,
  emptyHint,
  onOpen,
  onRename,
  onPromote,
}: RootListProps) {
  const [editing, setEditing] = useState<{ rootId: number; value: string } | null>(
    null,
  );

  const sorted = [...roots].sort((a, b) => latestId(b) - latestId(a));

  const commitName = () => {
    if (editing) {
      onRename(editing.rootId, editing.value);
      setEditing(null);
    }
  };

  if (sorted.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        <p className="text-lg font-medium text-foreground">{emptyTitle}</p>
        <p className="mt-1 text-sm">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ul className="flex-1 divide-y divide-border overflow-y-auto overscroll-contain">
        {sorted.map((root) => {
          const count = turnCount(root);
          const isSeed = root.state === 'seed';
          return (
            <li key={root.id} className="flex items-center gap-1 pr-2">
              <button
                type="button"
                onClick={() => onOpen(root)}
                className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/60 active:bg-muted"
              >
                {isSeed ? (
                  <Sprout className="h-4 w-4 shrink-0 text-primary/70" />
                ) : (
                  <TreePine className="h-4 w-4 shrink-0 text-primary/70" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {root.name ?? root.preview ?? 'Untitled'}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {count} {count === 1 ? 'turn' : 'turns'}
                  </span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Rename"
                title="Rename"
                onClick={() =>
                  setEditing({ rootId: root.id, value: root.name ?? '' })
                }
                className="h-9 w-9 shrink-0 text-muted-foreground"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              {onPromote && isSeed && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onPromote(root.id)}
                  title="Promote to a full conversation"
                  className="h-9 shrink-0 gap-1.5 px-2.5 text-primary"
                >
                  <TreePine className="h-4 w-4" />
                  Promote
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {/* Inline rename panel (naming a seed also promotes it). */}
      {editing && (
        <div className="border-t border-border bg-card p-4">
          <p className="mb-2 text-sm font-medium">Name this chat</p>
          <div className="flex gap-2">
            <input
              autoFocus
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(null);
                }
              }}
              placeholder="Chat name"
              className="min-h-[2.5rem] flex-1 rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
            />
            <Button onClick={commitName}>Save</Button>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
