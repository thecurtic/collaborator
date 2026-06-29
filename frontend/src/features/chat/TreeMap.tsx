import { LogIn, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ConversationTree, TreeNode } from '@/domain/models';

interface TreeMapProps {
  open: boolean;
  tree: ConversationTree;
  activeIds: Set<number>;
  onSelect: (turnId: number) => void;
  onDeleteSubtree: (turnId: number) => void;
  onClose: () => void;
}

const COL = 34; // px between branch columns
const ROW = 26; // px per turn
const PAD = 28;
const COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#6366f1',
];

interface Segment {
  startNodeId: number;
  count: number; // turns in this branch
  column: number;
  startRow: number;
  parentColumn: number | null;
  forkRow: number | null; // row of the parent fork (for the connector)
  active: boolean;
}

/** Decompose the tree into branch segments (linear runs between forks). */
function layout(roots: TreeNode[], activeIds: Set<number>) {
  const segments: Segment[] = [];
  let column = -1;
  const nextCol = () => (column += 1);

  const build = (
    node: TreeNode,
    col: number,
    startRow: number,
    parentColumn: number | null,
    forkRow: number | null,
  ) => {
    const ids: number[] = [];
    let cur = node;
    while (true) {
      ids.push(cur.id);
      if (cur.children.length === 1) {
        cur = cur.children[0];
        continue;
      }
      break;
    }
    segments.push({
      startNodeId: node.id,
      count: ids.length,
      column: col,
      startRow,
      parentColumn,
      forkRow,
      active: ids.some((id) => activeIds.has(id)),
    });
    if (cur.children.length > 1) {
      const myForkRow = startRow + ids.length - 1;
      cur.children.forEach((child, i) => {
        const childCol = i === 0 ? col : nextCol();
        build(
          child,
          childCol,
          myForkRow + 1,
          i === 0 ? null : col,
          i === 0 ? null : myForkRow,
        );
      });
    }
  };

  roots.forEach((root) => build(root, nextCol(), 0, null, null));

  const columns = column + 1;
  const rows = segments.reduce(
    (m, s) => Math.max(m, s.startRow + s.count),
    0,
  );
  return { segments, columns, rows };
}

export function TreeMap({
  open,
  tree,
  activeIds,
  onSelect,
  onDeleteSubtree,
  onClose,
}: TreeMapProps) {
  const [selected, setSelected] = useState<Segment | null>(null);
  const { segments, columns, rows } = useMemo(
    () => layout(tree.roots, activeIds),
    [tree, activeIds],
  );

  if (!open) return null;

  const colX = (c: number) => PAD + c * COL;
  const rowY = (r: number) => PAD + r * ROW;
  const width = Math.max(columns * COL + PAD, 200);
  const height = Math.max(rows * ROW + PAD, 200);

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

      <div className="flex-1 overflow-auto p-2">
        {segments.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No conversation yet.
          </p>
        ) : (
          <svg width={width} height={height} className="select-none">
            {segments.map((seg) => {
              const x = colX(seg.column);
              const top = rowY(seg.startRow);
              const bottom = rowY(seg.startRow + seg.count - 1);
              const color = COLORS[seg.column % COLORS.length];
              const isSel = selected?.startNodeId === seg.startNodeId;
              const opacity = seg.active || isSel ? 1 : 0.45;
              return (
                <g
                  key={seg.startNodeId}
                  onClick={() => setSelected(seg)}
                  className="cursor-pointer"
                >
                  {/* connector from the parent fork */}
                  {seg.parentColumn != null && seg.forkRow != null && (
                    <path
                      d={`M ${colX(seg.parentColumn)} ${rowY(seg.forkRow)} C ${colX(seg.parentColumn)} ${top} ${x} ${rowY(seg.forkRow)} ${x} ${top}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={2.5}
                      opacity={opacity}
                    />
                  )}
                  {/* the branch line (length ∝ turns) */}
                  <line
                    x1={x}
                    y1={top}
                    x2={x}
                    y2={bottom}
                    stroke={color}
                    strokeWidth={isSel ? 7 : seg.active ? 5 : 3}
                    strokeLinecap="round"
                    opacity={opacity}
                  />
                  {/* a dot per turn */}
                  {Array.from({ length: seg.count }).map((_, i) => (
                    <circle
                      key={i}
                      cx={x}
                      cy={rowY(seg.startRow + i)}
                      r={2.5}
                      fill={color}
                      opacity={opacity}
                    />
                  ))}
                  {/* wide transparent hit area for easy tapping */}
                  <line
                    x1={x}
                    y1={top - 8}
                    x2={x}
                    y2={bottom + 8}
                    stroke="transparent"
                    strokeWidth={22}
                  />
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* Action sheet for the tapped branch. */}
      {selected && (
        <div className="border-t border-border bg-card p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            Branch · {selected.count} {selected.count === 1 ? 'turn' : 'turns'}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1 gap-2"
              onClick={() => {
                onSelect(selected.startNodeId);
                setSelected(null);
              }}
            >
              <LogIn className="h-4 w-4" />
              Enter branch
            </Button>
            <Button
              variant="destructive"
              className="flex-1 gap-2"
              onClick={() => {
                const id = selected.startNodeId;
                setSelected(null);
                onDeleteSubtree(id);
              }}
            >
              <Trash2 className="h-4 w-4" />
              Delete branch
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Cancel"
              onClick={() => setSelected(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
