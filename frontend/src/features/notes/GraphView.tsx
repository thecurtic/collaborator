import { ChevronLeft, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import type { NoteMeta } from '@/domain/models';
import { layoutGraph } from './graphLayout';

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * Graph View: the vault as a network — nodes are notes (sized by link
 * degree), edges are [[wikilinks]]. Pan/pinch/wheel like the conversation
 * map; tap a node to open the note.
 */
export function GraphView({
  onBack,
  onOpenNote,
}: {
  onBack: () => void;
  onOpenNote: (title: string) => void;
}) {
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });

  const containerRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
    null,
  );
  const pinch = useRef<{
    dist: number;
    scale: number;
    mx: number;
    my: number;
  } | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listNotes()
      .then((n) => {
        if (!cancelled) setNotes(n);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Could not load notes');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const graph = useMemo(() => (notes ? layoutGraph(notes) : null), [notes]);

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = containerRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const zoomAt = (mx: number, my: number, nextScale: number) => {
    setView((v) => {
      const ns = clamp(nextScale, 0.3, 4);
      const cx = (mx - v.x) / v.scale;
      const cy = (my - v.y) / v.scale;
      return { x: mx - cx * ns, y: my - cy * ns, scale: ns };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);
    moved.current = false;
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
      moved.current = true;
      const [a, b] = [...pointers.current.values()];
      const ratio = dist(a, b) / (pinch.current.dist || 1);
      zoomAt(pinch.current.mx, pinch.current.my, pinch.current.scale * ratio);
    } else if (pointers.current.size === 1 && drag.current) {
      const d = drag.current;
      if (Math.hypot(p.x - d.x, p.y - d.y) > 4) moved.current = true;
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to notes"
          onClick={onBack}
          className="h-9 w-9"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h2 className="text-2xl font-semibold">Graph View</h2>
      </div>

      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        className="relative flex-1 touch-none overflow-hidden"
      >
        {error ? (
          <p className="px-4 py-6 text-sm text-destructive">{error}</p>
        ) : graph === null ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading graph…
          </div>
        ) : graph.nodes.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No notes yet — approve some drafts and the network appears here.
          </p>
        ) : (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            <svg
              width={graph.size}
              height={graph.size}
              className="select-none"
            >
              {graph.edges.map((e, i) => (
                <line
                  key={i}
                  x1={graph.nodes[e.a].x}
                  y1={graph.nodes[e.a].y}
                  x2={graph.nodes[e.b].x}
                  y2={graph.nodes[e.b].y}
                  stroke="var(--color-border)"
                  strokeWidth={1.5}
                />
              ))}
              {graph.nodes.map((n) => (
                <g
                  key={n.title}
                  className="cursor-pointer"
                  onClick={() => {
                    // Don't open a note when the tap was really a pan/pinch.
                    if (!moved.current) onOpenNote(n.title);
                  }}
                >
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={6 + Math.min(10, n.degree * 2)}
                    fill="var(--color-primary)"
                    opacity={0.85}
                  />
                  {/* Counter-scaled label: constant on-screen size. */}
                  <text
                    x={n.x}
                    y={n.y + (6 + Math.min(10, n.degree * 2)) + 4}
                    fontSize={11 / view.scale}
                    dominantBaseline="hanging"
                    textAnchor="middle"
                    fill="var(--color-foreground)"
                    pointerEvents="none"
                  >
                    {n.title.length > 28 ? `${n.title.slice(0, 28)}…` : n.title}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
