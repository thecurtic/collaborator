import type { NoteMeta } from '@/domain/models';

export interface GraphNode {
  title: string;
  x: number;
  y: number;
  /** Link degree (in + out) — drives node radius. */
  degree: number;
}

export interface GraphEdge {
  a: number; // node indices
  b: number;
}

export interface NoteGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  size: number; // square canvas side, px
}

/**
 * Resolve each note's outgoing [[wikilinks]] to node indices
 * (case-insensitive, like the backend's title lookup); unresolved links
 * (notes that don't exist yet) are skipped; duplicate/reciprocal pairs
 * collapse to one edge.
 */
export function buildEdges(notes: NoteMeta[]): GraphEdge[] {
  const index = new Map<string, number>();
  notes.forEach((n, i) => index.set(n.title.toLowerCase(), i));
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  notes.forEach((n, i) => {
    for (const link of n.links) {
      const j = index.get(link.toLowerCase());
      if (j === undefined || j === i) continue;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(i < j ? { a: i, b: j } : { a: j, b: i });
    }
  });
  return edges;
}

/**
 * Force-directed layout (basic Fruchterman–Reingold): deterministic spiral
 * start, ~250 cooling iterations, clamped to a square canvas sized to the
 * note count. Synchronous — vault sizes are personal-scale.
 */
export function layoutGraph(notes: NoteMeta[]): NoteGraph {
  const n = notes.length;
  const edges = buildEdges(notes);
  const size = Math.max(360, Math.ceil(Math.sqrt(n)) * 180);
  const pad = 40;

  // Deterministic golden-angle spiral start (stable layout across mounts).
  const nodes: GraphNode[] = notes.map((note, i) => {
    const r = ((size / 2 - pad) * Math.sqrt(i + 0.5)) / Math.sqrt(n || 1);
    const th = i * 2.399963229728653;
    return {
      title: note.title,
      x: size / 2 + r * Math.cos(th),
      y: size / 2 + r * Math.sin(th),
      degree: 0,
    };
  });
  for (const e of edges) {
    nodes[e.a].degree++;
    nodes[e.b].degree++;
  }

  const k = size / Math.sqrt(n + 1); // ideal spring length
  const iterations = 250;
  let temp = size / 8;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);

  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    // Repulsion between all pairs.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let vx = nodes[i].x - nodes[j].x;
        let vy = nodes[i].y - nodes[j].y;
        let d = Math.hypot(vx, vy);
        if (d < 0.01) {
          // Coincident nodes: nudge apart deterministically.
          vx = 0.1 * ((i % 3) - 1) || 0.1;
          vy = 0.1 * ((j % 3) - 1) || -0.1;
          d = Math.hypot(vx, vy);
        }
        const f = (k * k) / d / d; // (k²/d) / d → per-axis via v components
        dx[i] += vx * f;
        dy[i] += vy * f;
        dx[j] -= vx * f;
        dy[j] -= vy * f;
      }
    }
    // Attraction along edges.
    for (const e of edges) {
      const vx = nodes[e.a].x - nodes[e.b].x;
      const vy = nodes[e.a].y - nodes[e.b].y;
      const d = Math.hypot(vx, vy) || 0.01;
      const f = d / k; // (d²/k) / d → per-axis
      dx[e.a] -= vx * f;
      dy[e.a] -= vy * f;
      dx[e.b] += vx * f;
      dy[e.b] += vy * f;
    }
    // Apply, capped by the cooling temperature.
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(dx[i], dy[i]);
      if (d < 0.01) continue;
      const cap = Math.min(d, temp) / d;
      nodes[i].x += dx[i] * cap;
      nodes[i].y += dy[i] * cap;
      nodes[i].x = Math.min(size - pad, Math.max(pad, nodes[i].x));
      nodes[i].y = Math.min(size - pad, Math.max(pad, nodes[i].y));
    }
    temp *= 0.97;
  }

  return { nodes, edges, size };
}
