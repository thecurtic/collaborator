import type { NoteMeta } from '@/domain/models';

export interface GraphNode {
  title: string;
  x: number;
  y: number;
  z: number;
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
  /** Cube side length, px (world units, centered on size/2). */
  size: number;
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
 * 3D force-directed layout (Fruchterman–Reingold in a cube): deterministic
 * Fibonacci-sphere start, ~250 cooling iterations. Synchronous — vault sizes
 * are personal-scale.
 */
export function layoutGraph(notes: NoteMeta[]): NoteGraph {
  const n = notes.length;
  const edges = buildEdges(notes);
  const size = Math.max(360, Math.ceil(Math.sqrt(n)) * 180);
  const pad = 40;
  const c = size / 2;

  // Deterministic Fibonacci-sphere start (stable layout across mounts).
  const nodes: GraphNode[] = notes.map((note, i) => {
    const t = (i + 0.5) / (n || 1);
    const y = 1 - 2 * t;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * 2.399963229728653;
    const R = (c - pad) * (0.4 + 0.6 * Math.sqrt(t)); // fill the volume, not a shell
    return {
      title: note.title,
      x: c + R * r * Math.cos(th),
      y: c + R * y,
      z: c + R * r * Math.sin(th),
      degree: 0,
    };
  });
  for (const e of edges) {
    nodes[e.a].degree++;
    nodes[e.b].degree++;
  }

  const k = size / Math.cbrt(n + 1); // ideal spring length (3D volume)
  const iterations = 250;
  let temp = size / 8;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const dz = new Float64Array(n);

  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    dz.fill(0);
    // Repulsion between all pairs.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let vx = nodes[i].x - nodes[j].x;
        let vy = nodes[i].y - nodes[j].y;
        let vz = nodes[i].z - nodes[j].z;
        let d = Math.hypot(vx, vy, vz);
        if (d < 0.01) {
          vx = 0.1 * ((i % 3) - 1) || 0.1;
          vy = 0.1 * ((j % 3) - 1) || -0.1;
          vz = 0.1;
          d = Math.hypot(vx, vy, vz);
        }
        const f = (k * k) / d / d;
        dx[i] += vx * f;
        dy[i] += vy * f;
        dz[i] += vz * f;
        dx[j] -= vx * f;
        dy[j] -= vy * f;
        dz[j] -= vz * f;
      }
    }
    // Attraction along edges.
    for (const e of edges) {
      const vx = nodes[e.a].x - nodes[e.b].x;
      const vy = nodes[e.a].y - nodes[e.b].y;
      const vz = nodes[e.a].z - nodes[e.b].z;
      const d = Math.hypot(vx, vy, vz) || 0.01;
      const f = d / k;
      dx[e.a] -= vx * f;
      dy[e.a] -= vy * f;
      dz[e.a] -= vz * f;
      dx[e.b] += vx * f;
      dy[e.b] += vy * f;
      dz[e.b] += vz * f;
    }
    // Apply, capped by the cooling temperature; clamp inside the cube.
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(dx[i], dy[i], dz[i]);
      if (d < 0.01) continue;
      const cap = Math.min(d, temp) / d;
      nodes[i].x = Math.min(size - pad, Math.max(pad, nodes[i].x + dx[i] * cap));
      nodes[i].y = Math.min(size - pad, Math.max(pad, nodes[i].y + dy[i] * cap));
      nodes[i].z = Math.min(size - pad, Math.max(pad, nodes[i].z + dz[i] * cap));
    }
    temp *= 0.97;
  }

  return { nodes, edges, size };
}
