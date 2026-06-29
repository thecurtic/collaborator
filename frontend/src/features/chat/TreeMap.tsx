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

const COL = 40; // px between branch columns
const ROW = 30; // px per turn
const PAD = 32;

// NOTE: coloring is BRANCH-based for now. Per Curtis, this will likely change to
// TOPIC-based (boundaries determined by LLM review), possibly as a separate mode
// / toggle. Keep colorFor() as the single place to swap that in later.
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
function colorFor(column: number): string {
  const idx = column >= 0 ? column * 2 : -column * 2 - 1;
  return COLORS[idx % COLORS.length];
}

interface Segment {
  startNodeId: number;
  count: number; // turns in this branch
  column: number; // signed: 0 = centered trunk, + right, - left
  startRow: number;
  parentColumn: number | null;
  forkRow: number | null; // row of the parent fork (for the connector)
  active: boolean;
}

/**
 * Decompose the tree into branch segments. The main line (root + first-children)
 * stays in the centered column 0; each other branch is placed in the nearest free
 * side column, alternating left/right, so overlapping branches don't collide.
 */
function layout(roots: TreeNode[], activeIds: Set<number>) {
  const segments: Segment[] = [];
  const occupancy = new Map<number, Array<[number, number]>>();
  let sideToggle = 1;

  const overlaps = (col: number, a: number, b: number) =>
    (occupancy.get(col) ?? []).some(([s, e]) => a <= e && b >= s);
  const record = (col: number, a: number, b: number) => {
    const arr = occupancy.get(col) ?? [];
    arr.push([a, b]);
    occupancy.set(col, arr);
  };
  const allocateBranch = (a: number, b: number) => {
    const first = sideToggle;
    sideToggle = -sideToggle; // alternate which side we try first
    for (let mag = 1; mag < 100; mag += 1) {
      for (const sign of [first, -first]) {
        const col = sign * mag;
        if (!overlaps(col, a, b)) return col;
      }
    }
    return first * 99;
  };

  const build = (
    node: TreeNode,
    startRow: number,
    parentColumn: number,
    forkRow: number | null,
    isBranch: boolean,
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
    const count = ids.length;
    const endRow = startRow + count - 1;
    const column = isBranch ? allocateBranch(startRow, endRow) : parentColumn;
    record(column, startRow, endRow);
    segments.push({
      startNodeId: node.id,
      count,
      column,
      startRow,
      // Keep the parent link for ALL non-root segments (forkRow === null only for
      // roots) so continuations draw a connector and the trunk isn't broken.
      parentColumn: forkRow === null ? null : parentColumn,
      forkRow,
      active: ids.some((id) => activeIds.has(id)),
    });
    if (cur.children.length > 1) {
      const fr = endRow;
      cur.children.forEach((child, i) =>
        build(child, fr + 1, column, fr, i !== 0),
      );
    }
  };

  roots.forEach((root) => build(root, 0, 0, null, false));

  const cols = segments.map((s) => s.column);
  const minCol = Math.min(0, ...cols);
  const maxCol = Math.max(0, ...cols);
  const rows = segments.reduce((m, s) => Math.max(m, s.startRow + s.count), 0);
  return { segments, minCol, maxCol, rows };
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
  const { segments, minCol, maxCol, rows } = useMemo(
    () => layout(tree.roots, activeIds),
    [tree, activeIds],
  );

  if (!open) return null;

  // Symmetric span so the trunk (column 0) sits in the horizontal centre.
  const half = Math.max(1, maxCol, -minCol);
  const colX = (c: number) => PAD + (c + half) * COL;
  const rowY = (r: number) => PAD + r * ROW;
  const width = Math.max(2 * half * COL + PAD * 2, 200);
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
          <div className="flex min-h-full min-w-full justify-center">
          <svg width={width} height={height} className="select-none">
            {segments.map((seg) => {
              const x = colX(seg.column);
              const top = rowY(seg.startRow);
              const bottom = rowY(seg.startRow + seg.count - 1);
              const color = colorFor(seg.column);
              const isSel = selected?.startNodeId === seg.startNodeId;
              const opacity = seg.active || isSel ? 1 : 0.45;
              return (
                <g
                  key={seg.startNodeId}
                  onClick={() => setSelected(seg)}
                  className="cursor-pointer"
                >
                  {seg.parentColumn != null && seg.forkRow != null && (
                    <path
                      d={`M ${colX(seg.parentColumn)} ${rowY(seg.forkRow)} C ${colX(seg.parentColumn)} ${top} ${x} ${rowY(seg.forkRow)} ${x} ${top}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={isSel ? 8 : seg.active ? 6 : 4}
                      strokeLinecap="round"
                      opacity={opacity}
                    />
                  )}
                  <line
                    x1={x}
                    y1={top}
                    x2={x}
                    y2={bottom}
                    stroke={color}
                    strokeWidth={isSel ? 8 : seg.active ? 6 : 4}
                    strokeLinecap="round"
                    opacity={opacity}
                  />
                  {Array.from({ length: seg.count }).map((_, i) => (
                    <circle
                      key={i}
                      cx={x}
                      cy={rowY(seg.startRow + i)}
                      r={isSel || seg.active ? 5 : 4}
                      fill={color}
                      opacity={opacity}
                    />
                  ))}
                  <line
                    x1={x}
                    y1={top - 10}
                    x2={x}
                    y2={bottom + 10}
                    stroke="transparent"
                    strokeWidth={26}
                  />
                </g>
              );
            })}
          </svg>
          </div>
        )}
      </div>

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
