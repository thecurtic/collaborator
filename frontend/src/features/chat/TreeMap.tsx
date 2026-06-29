import { Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ConversationTree, TreeNode } from '@/domain/models';

interface TreeMapProps {
  open: boolean;
  tree: ConversationTree;
  activeIds: Set<number>;
  /** Navigate the chat to this node's path. */
  onSelect: (turnId: number) => void;
  /** Delete this node and its whole branch (subtree). */
  onDeleteSubtree: (turnId: number) => void;
  onClose: () => void;
}

interface RowProps {
  node: TreeNode;
  depth: number;
  activeIds: Set<number>;
  onSelect: (id: number) => void;
  onDeleteSubtree: (id: number) => void;
}

function NodeRow({ node, depth, activeIds, onSelect, onDeleteSubtree }: RowProps) {
  const active = activeIds.has(node.id);
  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 rounded-md',
          active && 'bg-primary/10',
        )}
      >
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left"
          style={{ paddingLeft: depth * 16 + 8 }}
        >
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              active
                ? 'bg-primary'
                : node.role === 'user'
                  ? 'bg-muted-foreground'
                  : 'bg-border',
            )}
          />
          <span
            className={cn(
              'truncate text-sm',
              active ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {node.preview || '(empty)'}
          </span>
        </button>
        <button
          type="button"
          aria-label="Delete this branch"
          title="Delete this branch"
          onClick={() => onDeleteSubtree(node.id)}
          className="shrink-0 p-1.5 text-muted-foreground opacity-60 transition hover:text-destructive active:scale-90"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {node.children.map((c) => (
        <NodeRow
          key={c.id}
          node={c}
          depth={depth + 1}
          activeIds={activeIds}
          onSelect={onSelect}
          onDeleteSubtree={onDeleteSubtree}
        />
      ))}
    </div>
  );
}

export function TreeMap({
  open,
  tree,
  activeIds,
  onSelect,
  onDeleteSubtree,
  onClose,
}: TreeMapProps) {
  if (!open) return null;

  return (
    <div className="pt-safe pb-safe px-safe fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold">Conversation map</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close map"
          onClick={onClose}
          className="h-8 w-8"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        {tree.roots.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No conversation yet.
          </p>
        ) : (
          tree.roots.map((root) => (
            <NodeRow
              key={root.id}
              node={root}
              depth={0}
              activeIds={activeIds}
              onSelect={onSelect}
              onDeleteSubtree={onDeleteSubtree}
            />
          ))
        )}
      </div>
    </div>
  );
}
