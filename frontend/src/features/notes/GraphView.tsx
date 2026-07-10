import { Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import { useModalA11y } from '@/lib/useModalA11y';
import type { NoteMeta } from '@/domain/models';
import { layoutGraph } from './graphLayout';

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * Graph View: the vault as a 3D network. Fullscreen and dark (white edges,
 * labeled nodes). One finger orbits, pinch zooms, two-finger drag pans,
 * wheel zooms; tap a node to open the note. Rendering is a hand-rolled
 * rotate-then-perspective projection onto SVG — no 3D dependency.
 */
export function GraphView({
  onClose,
  onOpenNote,
}: {
  onClose: () => void;
  onOpenNote: (title: string) => void;
}) {
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cam, setCam] = useState<Camera>({
    yaw: 0.6,
    pitch: 0.25,
    zoom: 1,
    panX: 0,
    panY: 0,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useModalA11y<HTMLDivElement>(true, onClose);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const orbit = useRef<{ x: number; y: number } | null>(null);
  const pinch = useRef<{ dist: number; zoom: number; mx: number; my: number } | null>(
    null,
  );
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

  // ---- Gestures: 1 finger = orbit, 2 fingers = pinch zoom + pan ----------
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = containerRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);
    moved.current = false;
    if (pointers.current.size === 1) {
      orbit.current = p;
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: dist(a, b),
        zoom: cam.zoom,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
      orbit.current = null;
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2 && pinch.current) {
      moved.current = true;
      const [a, b] = [...pointers.current.values()];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const ratio = dist(a, b) / (pinch.current.dist || 1);
      const start = pinch.current;
      setCam((c) => ({
        ...c,
        zoom: clamp(start.zoom * ratio, 0.3, 5),
        panX: c.panX + (mx - start.mx),
        panY: c.panY + (my - start.my),
      }));
      pinch.current = { ...start, mx, my };
    } else if (pointers.current.size === 1 && orbit.current) {
      const o = orbit.current;
      const ddx = p.x - o.x;
      const ddy = p.y - o.y;
      if (Math.hypot(ddx, ddy) > 3) moved.current = true;
      setCam((c) => ({
        ...c,
        yaw: c.yaw + ddx * 0.006,
        pitch: clamp(c.pitch + ddy * 0.006, -1.45, 1.45),
      }));
      orbit.current = p;
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    orbit.current =
      pointers.current.size === 1
        ? [...pointers.current.values()][0]
        : null;
    if (pointers.current.size < 2) pinch.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    setCam((c) => ({
      ...c,
      zoom: clamp(c.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.3, 5),
    }));
  };

  // ---- Projection: rotate (yaw then pitch) → perspective ------------------
  const projected = useMemo(() => {
    if (!graph) return null;
    const c = graph.size / 2;
    const f = graph.size * 1.4; // focal length
    const cosY = Math.cos(cam.yaw);
    const sinY = Math.sin(cam.yaw);
    const cosP = Math.cos(cam.pitch);
    const sinP = Math.sin(cam.pitch);
    const pts = graph.nodes.map((n) => {
      const x0 = n.x - c;
      const y0 = n.y - c;
      const z0 = n.z - c;
      const x1 = x0 * cosY + z0 * sinY;
      const z1 = -x0 * sinY + z0 * cosY;
      const y2 = y0 * cosP - z1 * sinP;
      const z2 = y0 * sinP + z1 * cosP;
      const s = f / (f + z2); // z2 > 0 = away from camera
      return { x: c + x1 * s, y: c + y2 * s, s, depth: z2 };
    });
    // Painter's order: far nodes first so near ones draw on top.
    const order = pts
      .map((_, i) => i)
      .sort((i, j) => pts[j].depth - pts[i].depth);
    return { pts, order };
  }, [graph, cam.yaw, cam.pitch]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Graph View"
      tabIndex={-1}
      className="fixed inset-0 z-50 bg-neutral-950 outline-none"
    >
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        className="h-full w-full touch-none overflow-hidden"
      >
        {error ? (
          <p className="px-6 py-16 text-sm text-red-400">{error}</p>
        ) : graph === null || projected === null ? (
          <div className="flex h-full items-center justify-center gap-2 text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading graph…
          </div>
        ) : graph.nodes.length === 0 ? (
          <p className="flex h-full items-center justify-center px-8 text-center text-sm text-neutral-400">
            No notes yet — approve some drafts and the network appears here.
          </p>
        ) : (
          <svg
            viewBox={`0 0 ${graph.size} ${graph.size}`}
            preserveAspectRatio="xMidYMid meet"
            className="h-full w-full select-none"
            style={{
              transform: `translate(${cam.panX}px, ${cam.panY}px) scale(${cam.zoom})`,
            }}
          >
            {/* Edges: white, nearer = brighter. */}
            {graph.edges.map((e, i) => {
              const a = projected.pts[e.a];
              const b = projected.pts[e.b];
              const nearness = (a.s + b.s) / 2; // ~0.6 far … ~1.6 near
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="white"
                  strokeOpacity={clamp(0.15 + (nearness - 0.7) * 0.8, 0.12, 0.9)}
                  strokeWidth={1.4 * nearness}
                />
              );
            })}
            {/* Nodes + labels, far-to-near. */}
            {projected.order.map((i) => {
              const n = graph.nodes[i];
              const p = projected.pts[i];
              const r = (5 + Math.min(9, n.degree * 1.8)) * p.s;
              return (
                <g
                  key={n.title}
                  className="cursor-pointer"
                  onClick={() => {
                    if (!moved.current) onOpenNote(n.title);
                  }}
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    fill="white"
                    fillOpacity={clamp(0.5 + (p.s - 0.7) * 0.7, 0.35, 1)}
                  />
                  <text
                    x={p.x}
                    y={p.y + r + 4}
                    fontSize={11 * p.s}
                    dominantBaseline="hanging"
                    textAnchor="middle"
                    fill="white"
                    fillOpacity={clamp(0.55 + (p.s - 0.7) * 0.7, 0.4, 1)}
                    pointerEvents="none"
                  >
                    {n.title.length > 26 ? `${n.title.slice(0, 26)}…` : n.title}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* Close — the only chrome on the screen. */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close Graph View"
        onClick={onClose}
        className="pt-safe absolute right-3 top-3 z-10 h-10 w-10 box-content text-neutral-300 hover:bg-white/10 hover:text-white"
      >
        <X className="h-5 w-5" />
      </Button>
    </div>
  );
}
