import { describe, expect, it } from 'vitest';
import type { NoteMeta } from '@/domain/models';
import { facetsOf, inferProjects } from './projectInference';

let seq = 0;
function note(tags: string[]): NoteMeta {
  seq += 1;
  return {
    filename: `n${seq}.md`,
    title: `n${seq}`,
    created: '2026-08-01',
    tags: ['project', ...tags],
    sourceTurns: [],
    links: [],
    score: null,
    fields: null,
    occurrence: null,
    recurring: false,
    moved: false,
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

  it('type tags are never names: events and people join their project', () => {
    // Every event is in garden, so `event` alone would look like a name
    // nested in it; people span both projects.
    const universe = [
      ...times(3, () => note(['garden'])),
      ...times(3, () => note(['event', 'garden'])),
      note(['social-graph', 'garden']),
      ...times(2, () => note(['social-graph', 'homelab'])),
      ...times(2, () => note(['homelab'])),
    ];
    const { clusters, unassigned } = inferProjects(universe);
    expect(clusters.map((c) => c.name)).toEqual(['garden', 'homelab']);
    expect(clusters[0].notes).toHaveLength(7);
    expect(clusters[1].notes).toHaveLength(4);
    expect(unassigned).toHaveLength(0);
    // Inside the project, `event` is a facet to drill by.
    expect(facetsOf(clusters[0].notes, ['garden']).map((f) => f.tag)).toEqual([
      'event',
      'social-graph',
    ]);
  });

  it('an event with no name tag is unassigned, not a project called event', () => {
    const universe = [...times(3, () => note(['event'])), note(['garden'])];
    const { clusters, unassigned } = inferProjects(universe);
    expect(clusters.map((c) => c.name)).toEqual(['garden']);
    expect(unassigned).toHaveLength(3);
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
