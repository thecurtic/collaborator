import { describe, expect, it } from 'vitest';
import type { NoteMeta } from '@/domain/models';
import { facetsOf, inferProjects, openCount } from './projectInference';

let seq = 0;
function note(tags: string[], state: string | null = null): NoteMeta {
  seq += 1;
  return {
    filename: `n${seq}.md`,
    title: `n${seq}`,
    created: '2026-08-01',
    tags: ['project', ...tags],
    sourceTurns: [],
    links: [],
    score: null,
    fields: state
      ? {
          start: null,
          end: null,
          allDay: false,
          location: null,
          people: [],
          state,
          due: null,
          aliases: [],
          kind: null,
          relation: null,
          birthday: null,
          area: null,
          name: null,
          dob: null,
          residesIn: null,
          timezone: null,
        }
      : null,
  };
}

const times = (n: number, make: () => NoteMeta) =>
  Array.from({ length: n }, make);

describe('inferProjects', () => {
  it('single project: the name dominates, facets stay facets', () => {
    const universe = [
      ...times(6, () => note(['collaborator', 'bug'])),
      ...times(4, () => note(['collaborator', 'feature'])),
      ...times(2, () => note(['collaborator'])),
    ];
    const { clusters, unassigned } = inferProjects(universe);
    expect(clusters.map((c) => c.name)).toEqual(['collaborator']);
    expect(clusters[0].notes).toHaveLength(12);
    expect(unassigned).toHaveLength(0);
  });

  it('a bridging facet bigger than either project never becomes a name', () => {
    // bug spans both projects (35 notes) > collaborator (30) > homelab (20).
    const universe = [
      ...times(20, () => note(['collaborator', 'bug'])),
      ...times(10, () => note(['collaborator'])),
      ...times(15, () => note(['homelab', 'bug'])),
      ...times(5, () => note(['homelab'])),
    ];
    const { clusters, unassigned } = inferProjects(universe);
    expect(clusters.map((c) => c.name)).toEqual(['collaborator', 'homelab']);
    expect(clusters[0].notes).toHaveLength(30);
    expect(clusters[1].notes).toHaveLength(20);
    expect(unassigned).toHaveLength(0);
  });

  it('a lone new project note founds a singleton cluster', () => {
    const universe = [
      ...times(5, () => note(['collaborator', 'feature'])),
      note(['someidea']),
    ];
    const names = inferProjects(universe).clusters.map((c) => c.name);
    expect(names).toContain('someidea');
    expect(names).toContain('collaborator');
  });

  it('notes with only the project tag land in unassigned', () => {
    const universe = [
      ...times(4, () => note(['collaborator'])),
      note([]),
    ];
    const { unassigned } = inferProjects(universe);
    expect(unassigned).toHaveLength(1);
  });
});

describe('facetsOf', () => {
  it('orders co-occurring tags by frequency, excluding name + drilled', () => {
    const notes = [
      note(['collaborator', 'bug', 'voice']),
      note(['collaborator', 'bug']),
      note(['collaborator', 'feature']),
    ];
    expect(facetsOf(notes, ['collaborator']).map((f) => f.tag)).toEqual([
      'bug',
      'feature',
      'voice',
    ]);
    expect(facetsOf(notes, ['collaborator', 'bug']).map((f) => f.tag)).toEqual(
      ['feature', 'voice'],
    );
  });
});

describe('openCount', () => {
  it('counts only explicitly non-terminal states', () => {
    const notes = [
      note(['x'], 'started'),
      note(['x'], 'proposed'),
      note(['x'], 'done'),
      note(['x']), // stateless = reference material, not "open"
    ];
    expect(openCount(notes)).toBe(2);
  });
});
