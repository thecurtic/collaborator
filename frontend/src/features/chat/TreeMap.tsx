import { Maximize2, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ConversationTree, TreeNode } from '@/domain/models';
import { getTreeName, setTreeName } from './treeNames';

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
const NAME_H = 34; // space above each tree for its name label
const TREE_GAP = 90; // horizontal gap between separate trees

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

// ---- Layout ---------------------------------------------------------------

interface Seg {
  startNodeId: number;
  nodeIds: number[];
  count: number;
  active: boolean;
  children: Seg[];
  offset: number;
  left: number;
  right: number;
}

interface Segment {
  startNodeId: number;
  nodeIds: number[];
  count: number;
  column: number;
  startRow: number;
  parentColumn: number | null;
  forkRow: number | null;
  active: boolean;
}

interface TreeLayout {
  rootNodeId: number;
  rootName: string;
  segments: Segment[];
  minCol: number;
  maxCol: number;
  rows: number;
  originId: number | null; // node this without-context tree branched from
  xOffset: number; // px offset of this tree in the forest
}

interface Detach {
  node: TreeNode;
  originId: number;
}

/** Build a tidy tree, detaching context-boundary children as new tree roots. */
function buildSeg(node: TreeNode, activeIds: Set<number>, detached: Detach[]): Seg {
  const nodeIds: number[] = [];
  let cur = node;
  for (;;) {
    nodeIds.push(cur.id);
    const attached: TreeNode[] = [];
    for (const k of cur.children) {
      if (k.contextBoundary) detached.push({ node: k, originId: cur.id });
      else attached.push(k);
    }
    if (attached.length === 1) {
      cur = attached[0];
      continue;
    }
    const children =
      attached.length > 1
        ? attached.map((a) => buildSeg(a, activeIds, detached))
        : [];
    return {
      startNodeId: node.id,
      nodeIds,
      count: nodeIds.length,
      active: nodeIds.some((id) => activeIds.has(id)),
      children,
      offset: 0,
      left: 0,
      right: 0,
    };
  }
}

function measure(seg: Seg) {
  if (seg.children.length === 0) return;
  seg.children.forEach(measure);
  const c0 = seg.children[0];
  c0.offset = 0;
  let leftEdge = -c0.left;
  let rightEdge = c0.right;
  for (let i = 1; i < seg.children.length; i++) {
    const c = seg.children[i];
    if (i % 2 === 1) {
      c.offset = rightEdge + 1 + c.left;
      rightEdge = c.offset + c.right;
    } else {
      c.offset = leftEdge - 1 - c.right;
      leftEdge = c.offset - c.left;
    }
  }
  seg.left = -leftEdge;
  seg.right = rightEdge;
}

function assign(
  seg: Seg,
  col: number,
  startRow: number,
  parentColumn: number | null,
  forkRow: number | null,
  out: Segment[],
) {
  out.push({
    startNodeId: seg.startNodeId,
    nodeIds: seg.nodeIds,
    count: seg.count,
    column: col,
    startRow,
    parentColumn,
    forkRow,
    active: seg.active,
  });
  const myFork = startRow + seg.count - 1;
  for (const c of seg.children) {
    assign(c, col + c.offset, myFork + 1, col, myFork, out);
  }
}

function buildForest(tree: ConversationTree, activeIds: Set<number>) {
  const queue: { node: TreeNode; originId: number | null }[] = tree.roots.map(
    (r) => ({ node: r, originId: null }),
  );
  const trees: TreeLayout[] = [];

  while (queue.length) {
    const { node, originId } = queue.shift()!;
    const detached: Detach[] = [];
    const rootSeg = buildSeg(node, activeIds, detached);
    measure(rootSeg);
    const segments: Segment[] = [];
    assign(rootSeg, 0, 0, null, null, segments);
    const cols = segments.map((s) => s.column);
    trees.push({
      rootNodeId: node.id,
      rootName: getTreeName(node.id) ?? node.preview ?? 'Untitled',
      segments,
      minCol: Math.min(...cols),
      maxCol: Math.max(...cols),
      rows: segments.reduce((m, s) => Math.max(m, s.startRow + s.count), 0),
      originId,
      xOffset: 0,
    });
    detached.forEach((d) => queue.push(d));
  }

  // Lay trees out left-to-right.
  let x = 0;
  for (const t of trees) {
    t.xOffset = x;
    x += (t.maxCol - t.minCol) * COL + COL + TREE_GAP;
  }
  return trees;
}

// ---- Component ------------------------------------------------------------

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function TreeMap({
  open,
  tree,
  activeIds,
  onSelect,
  onDeleteSubtree,
  onClose,
}: TreeMapProps) {
  const [selected, setSelected] = useState<Segment | null>(null);
  const [editing, setEditing] = useState<{ rootId: number; value: string } | null>(
    null,
  );
  const [nameVersion, setNameVersion] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });

  const containerRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const pinch = useRef<{ dist: number; scale: number; mx: number; my: number } | null>(
    null,
  );

  const trees = useMemo(
    () => buildForest(tree, activeIds),
    // nameVersion forces a rebuild when a name is edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, activeIds, nameVersion],
  );

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setEditing(null);
    }
  }, [open]);

  const layout = useMemo(() => {
    const globalX = (t: TreeLayout, col: number) =>
      PAD + t.xOffset + (col - t.minCol) * COL;
    const rowY = (row: number) => PAD + NAME_H + row * ROW;
    const pos = new Map<number, { x: number; y: number }>();
    for (const t of trees) {
      for (const s of t.segments) {
        s.nodeIds.forEach((id, j) => {
          pos.set(id, { x: globalX(t, s.column), y: rowY(s.startRow + j) });
        });
      }
    }
    const width = trees.length
      ? Math.max(...trees.map((t) => globalX(t, t.maxCol))) + PAD
      : 200;
    const height = trees.length
      ? Math.max(...trees.map((t) => rowY(t.rows))) + PAD
      : 200;
    return { globalX, rowY, pos, width, height };
  }, [trees]);

  if (!open) return null;

  const { globalX, rowY, pos, width, height } = layout;

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = containerRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const zoomAt = (mx: number, my: number, nextScale: number) => {
    setView((v) => {
      const ns = clamp(nextScale, 0.3, 3);
      const cx = (mx - v.x) / v.scale;
      const cy = (my - v.y) / v.scale;
      return { x: mx - cx * ns, y: my - cy * ns, scale: ns };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) {
      drag.current = { x: p.x, y: p.y, px: view.x, py: view.y };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: dist(a, b),
        scale: view.scale,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
      drag.current = null;
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const ratio = dist(a, b) / (pinch.current.dist || 1);
      zoomAt(pinch.current.mx, pinch.current.my, pinch.current.scale * ratio);
    } else if (pointers.current.size === 1 && drag.current) {
      const d = drag.current;
      setView((v) => ({ ...v, x: d.px + (p.x - d.x), y: d.py + (p.y - d.y) }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    drag.current = null;
    if (pointers.current.size < 2) pinch.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = localPoint(e);
    zoomAt(p.x, p.y, view.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  };

  const commitName = () => {
    if (editing) {
      setTreeName(editing.rootId, editing.value);
      setNameVersion((n) => n + 1);
      setEditing(null);
    }
  };

  return (
    <div className="pt-safe pb-safe px-safe fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold">Conversation map</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Reset view"
            onClick={() => setView({ x: 0, y: 0, scale: 1 })}
            className="h-8 w-8"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close map"
            onClick={onClose}
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        className="relative flex-1 touch-none overflow-hidden"
      >
        {trees.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No conversation yet.
          </p>
        ) : (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            <svg width={width} height={height} className="select-none">
              {/* Dashed connectors from a branch point to a detached tree. */}
              {trees.map((t) => {
                if (t.originId == null) return null;
                const from = pos.get(t.originId);
                const to = pos.get(t.rootNodeId);
                if (!from || !to) return null;
                const dx = Math.max(40, (to.x - from.x) / 2);
                return (
                  <path
                    key={`conn-${t.rootNodeId}`}
                    d={`M ${from.x} ${from.y} C ${from.x + dx} ${from.y} ${to.x - dx} ${to.y} ${to.x} ${to.y}`}
                    fill="none"
                    stroke="currentColor"
                    className="text-muted-foreground"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    opacity={0.5}
                    pointerEvents="none"
                  />
                );
              })}

              {/* Tree name labels (centered above each root). */}
              {trees.map((t) => (
                <foreignObject
                  key={`name-${t.rootNodeId}`}
                  x={globalX(t, 0) - 90}
                  y={PAD - 6}
                  width={180}
                  height={NAME_H}
                >
                  <div className="flex h-full items-center justify-center">
                    <button
                      type="button"
                      onClick={() =>
                        setEditing({ rootId: t.rootNodeId, value: t.rootName })
                      }
                      title="Rename tree"
                      className="max-w-full truncate rounded-md border border-border bg-card px-2 py-0.5 text-xs font-medium text-foreground shadow-sm hover:border-primary/50"
                    >
                      {t.rootName}
                    </button>
                  </div>
                </foreignObject>
              ))}

              {/* Branch segments. */}
              {trees.map((t) =>
                t.segments.map((seg) => {
                  const x = globalX(t, seg.column);
                  const top = rowY(seg.startRow);
                  const bottom = rowY(seg.startRow + seg.count - 1);
                  const color = colorFor(seg.column);
                  const emphasized = seg.active;
                  const opacity = emphasized ? 1 : 0.28;
                  return (
                    <g
                      key={seg.startNodeId}
                      onClick={() => {
                        setSelected(seg);
                        onSelect(seg.startNodeId);
                      }}
                      className="cursor-pointer"
                    >
                      {seg.parentColumn != null && seg.forkRow != null && (
                        <path
                          d={`M ${globalX(t, seg.parentColumn)} ${rowY(seg.forkRow)} C ${globalX(t, seg.parentColumn)} ${top} ${x} ${rowY(seg.forkRow)} ${x} ${top}`}
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
                        strokeWidth={emphasized ? 7 : 4}
                        strokeLinecap="round"
                        opacity={opacity}
                        pointerEvents="none"
                      />
                      {Array.from({ length: seg.count }).map((_, i) => (
                        <circle
                          key={i}
                          cx={x}
                          cy={rowY(seg.startRow + i)}
                          r={emphasized ? 5 : 4}
                          fill={color}
                          opacity={opacity}
                          pointerEvents="none"
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
                }),
              )}
            </svg>
          </div>
        )}
      </div>

      {/* Rename panel. */}
      {editing && (
        <div className="border-t border-border bg-card p-4">
          <p className="mb-2 text-sm font-medium">Rename tree</p>
          <div className="flex gap-2">
            <input
              autoFocus
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') setEditing(null);
              }}
              placeholder="Tree name"
              className="min-h-[2.5rem] flex-1 rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
            />
            <Button onClick={commitName}>Save</Button>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Active-branch action bar. */}
      {!editing && selected && (
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
