import { describe, expect, it } from 'vitest';
import type { NoteMeta } from '@/domain/models';
import { buildEdges, layoutGraph } from './graphLayout';

const meta = (title: string, links: string[] = []): NoteMeta => ({
  filename: `${title}.md`,
  title,
  created: null,
  tags: [],
  sourceTurns: [],
  links,
  score: null,
  fields: null,
  occurrence: null,
  recurring: false,
  moved: false,
  edited: null,
});

describe('buildEdges', () => {
  it('resolves links case-insensitively', () => {
    const edges = buildEdges([meta('Alpha', ['beta']), meta('Beta')]);
    expect(edges).toEqual([{ a: 0, b: 1 }]);
  });

  it('skips unresolved links and self-links', () => {
    const edges = buildEdges([meta('Alpha', ['Ghost', 'Alpha'])]);
    expect(edges).toEqual([]);
  });

  it('collapses reciprocal links into one edge', () => {
    const edges = buildEdges([meta('A', ['B']), meta('B', ['A'])]);
    expect(edges).toHaveLength(1);
  });
});

describe('layoutGraph', () => {
  it('is deterministic and keeps nodes inside the cube', () => {
    const notes = [meta('A', ['B']), meta('B', ['C']), meta('C'), meta('D')];
    const g1 = layoutGraph(notes);
    const g2 = layoutGraph(notes);
    expect(g1.nodes).toEqual(g2.nodes);
    for (const node of g1.nodes) {
      for (const v of [node.x, node.y, node.z]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(g1.size);
      }
    }
  });

  it('pulls linked nodes closer than unlinked ones', () => {
    const notes = [meta('A', ['B']), meta('B'), meta('Lonely')];
    const g = layoutGraph(notes);
    const d = (i: number, j: number) =>
      Math.hypot(
        g.nodes[i].x - g.nodes[j].x,
        g.nodes[i].y - g.nodes[j].y,
        g.nodes[i].z - g.nodes[j].z,
      );
    expect(d(0, 1)).toBeLessThan(d(0, 2));
    expect(d(0, 1)).toBeLessThan(d(1, 2));
  });

  it('computes degree from resolved edges', () => {
    const g = layoutGraph([meta('Hub', ['A', 'B']), meta('A'), meta('B')]);
    expect(g.nodes[0].degree).toBe(2);
    expect(g.nodes[1].degree).toBe(1);
  });
});
