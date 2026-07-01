import { Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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

// Internal tree node used for tidy layout (a segment = a linear run of turns).
interface Seg {
  startNodeId: number;
  count: number;
  active: boolean;
  children: Seg[];
  offset: number; // column offset relative to the parent segment
  left: number; // subtree extent (columns) left of own column
  right: number; // subtree extent right of own column
}

/**
 * Tidy-tree layout. Each fork keeps its first child straight below it and fans
 * the rest out alternately to the right/left of THAT parent. Every subtree is
 * given a disjoint horizontal band (extents reserved bottom-up), so branches of
 * one parent never cross another's — parents shift to make room as needed.
 */
function layout(roots: TreeNode[], activeIds: Set<number>) {
  const build = (node: TreeNode): Seg => {
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
    return {
      startNodeId: node.id,
      count: ids.length,
      active: ids.some((id) => activeIds.has(id)),
      children: cur.children.length > 1 ? cur.children.map(build) : [],
      offset: 0,
      left: 0,
      right: 0,
    };
  };

  // Bottom-up: place children in disjoint bands, alternating sides.
  const measure = (seg: Seg) => {
    if (seg.children.length === 0) return;
    seg.children.forEach(measure);
    const c0 = seg.children[0];
    c0.offset = 0;
    let leftEdge = -c0.left;
    let rightEdge = c0.right;
    for (let i = 1; i < seg.children.length; i++) {
      const c = seg.children[i];
      if (i % 2 === 1) {
        c.offset = rightEdge + 1 + c.left; // next free slot to the right
        rightEdge = c.offset + c.right;
      } else {
        c.offset = leftEdge - 1 - c.right; // next free slot to the left
        leftEdge = c.offset - c.left;
      }
    }
    seg.left = -leftEdge;
    seg.right = rightEdge;
  };

  // Top-down: resolve absolute columns + rows and flatten for rendering.
  const segments: Segment[] = [];
  const segById = new Map<number, Seg>();
  const assign = (
    seg: Seg,
    col: number,
    startRow: number,
    parentColumn: number | null,
    forkRow: number | null,
  ) => {
    segById.set(seg.startNodeId, seg);
    segments.push({
      startNodeId: seg.startNodeId,
      count: seg.count,
      column: col,
      startRow,
      parentColumn,
      forkRow,
      active: seg.active,
    });
    const myFork = startRow + seg.count - 1;
    for (const c of seg.children) {
      assign(c, col + c.offset, myFork + 1, col, myFork);
    }
  };

  // Roots are laid out like children of a virtual parent (alternating bands).
  const rootSegs = roots.map(build);
  rootSegs.forEach(measure);
  if (rootSegs.length > 0) {
    const bases: number[] = [0];
    let leftEdge = -rootSegs[0].left;
    let rightEdge = rootSegs[0].right;
    for (let i = 1; i < rootSegs.length; i++) {
      const r = rootSegs[i];
      if (i % 2 === 1) {
        bases[i] = rightEdge + 1 + r.left;
        rightEdge = bases[i] + r.right;
      } else {
        bases[i] = leftEdge - 1 - r.right;
        leftEdge = bases[i] - r.left;
      }
    }
    rootSegs.forEach((r, i) => assign(r, bases[i], 0, null, null));
  }

  const cols = segments.map((s) => s.column);
  const minCol = cols.length ? Math.min(...cols) : 0;
  const maxCol = cols.length ? Math.max(...cols) : 0;
  const rows = segments.reduce((m, s) => Math.max(m, s.startRow + s.count), 0);
  return { segments, segById, minCol, maxCol, rows };
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

  // Clear the action bar when the map closes.
  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  if (!open) return null;

  // Place columns from the leftmost; the whole graph is centered in the viewport.
  const colX = (c: number) => PAD + (c - minCol) * COL;
  const rowY = (r: number) => PAD + r * ROW;
  const width = Math.max((maxCol - minCol) * COL + PAD * 2, 200);
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
              // Tapping a branch makes it active (see onClick), so the highlight
              // simply follows the active path — active branch == highlighted.
              const emphasized = seg.active;
              const opacity = emphasized ? 1 : 0.28;
              const stroke = emphasized ? 7 : 4;
              return (
                <g
                  key={seg.startNodeId}
                  onClick={() => {
                    setSelected(seg);
                    onSelect(seg.startNodeId); // enter this branch (make it active)
                  }}
                  className="cursor-pointer"
                >
                  {seg.parentColumn != null && seg.forkRow != null && (
                    <path
                      d={`M ${colX(seg.parentColumn)} ${rowY(seg.forkRow)} C ${colX(seg.parentColumn)} ${top} ${x} ${rowY(seg.forkRow)} ${x} ${top}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={emphasized ? 5 : 4}
                      strokeLinecap="round"
                      opacity={opacity}
                      pointerEvents="none"
                    />
                  )}
                  <line
                    x1={x}
                    y1={top}
                    x2={x}
                    y2={bottom}
                    stroke={color}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    opacity={opacity}
                  />
                  {Array.from({ length: seg.count }).map((_, i) => (
                    <circle
                      key={i}
                      cx={x}
                      cy={rowY(seg.startRow + i)}
                      r={emphasized ? 5 : 4}
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
            Active branch · {selected.count}{' '}
            {selected.count === 1 ? 'turn' : 'turns'}
          </p>
          <div className="flex gap-2">
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
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              Go to conversation
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
