import type { NoteMeta } from '@/domain/models';
import { TYPE_TAGS } from './categories';

/**
 * Project-name inference over the projects lens. Model (greenfield, agreed
 * 2026-08-17): every member note is tagged `project`; the project's NAME is
 * one of its other tags — inferred, never declared. Facets are the rest.
 *
 * The discriminator is EXCLUSIVITY, not frequency: project names partition
 * the universe (a note never carries two names), while shared facets (bug,
 * feature) bridge partitions. So names = the set of pairwise near-disjoint
 * tags that together cover the most notes. Raw frequency fails here: a
 * facet spanning two projects can outnumber either project's name.
 *
 * Type tags (event, social-graph, user-profile) are never names: since
 * 2026-10-12 events and people join projects, and a type says what a note
 * is, not which project it belongs to.
 *
 * Deterministic, presentation-only — misfires are fixed by a future
 * pin/ignore override (backend-persisted, deferred), NEVER by retagging.
 */
export interface ProjectCluster {
  name: string;
  notes: NoteMeta[];
}

export interface ProjectInference {
  clusters: ProjectCluster[];
  /** Notes tagged `project` carrying no accepted name tag. */
  unassigned: NoteMeta[];
}

// Two tags conflict (can't both be names) when their note-sets overlap by
// ≥20% of the smaller set. Below that, the odd mis-tag doesn't merge them.
const CONFLICT_RATIO = 0.2;

const NOT_NAMES = new Set<string>(['project', ...TYPE_TAGS]);

interface Candidate {
  tag: string;
  notes: NoteMeta[];
  keys: Set<string>;
}

function overlapRatio(a: Candidate, b: Candidate): number {
  let shared = 0;
  const [small, large] = a.keys.size <= b.keys.size ? [a, b] : [b, a];
  for (const k of small.keys) if (large.keys.has(k)) shared++;
  return shared / small.keys.size;
}

/** Greedy pack: accept size-ordered candidates that conflict with nothing. */
function pack(
  ordered: Candidate[],
  banned: string | null,
): { names: Candidate[]; coverage: number } {
  const names: Candidate[] = [];
  const covered = new Set<string>();
  for (const c of ordered) {
    if (c.tag === banned) continue;
    if (names.some((n) => overlapRatio(c, n) >= CONFLICT_RATIO)) continue;
    names.push(c);
    for (const k of c.keys) covered.add(k);
  }
  return { names, coverage: covered.size };
}

export function inferProjects(universe: NoteMeta[]): ProjectInference {
  const byTag = new Map<string, NoteMeta[]>();
  for (const note of universe) {
    for (const tag of note.tags) {
      if (NOT_NAMES.has(tag)) continue;
      const list = byTag.get(tag);
      if (list) list.push(note);
      else byTag.set(tag, [note]);
    }
  }
  const ordered: Candidate[] = [...byTag.entries()]
    .map(([tag, notes]) => ({
      tag,
      notes,
      keys: new Set(notes.map((n) => n.filename)),
    }))
    .sort((a, b) => b.notes.length - a.notes.length || a.tag.localeCompare(b.tag));

  // Leave-one-out search: plain greedy loses when a bridging facet is the
  // single biggest tag (it gets accepted first and blocks the real names).
  // Re-packing with each of the top candidates banned finds the partition
  // with the best total coverage instead. O(K·n²) at personal scale.
  let best = pack(ordered, null);
  for (const c of ordered.slice(0, 10)) {
    const alt = pack(ordered, c.tag);
    if (alt.coverage > best.coverage) best = alt;
  }

  const rank = new Map(best.names.map((c, i) => [c.tag, i]));
  const size = new Map(best.names.map((c) => [c.tag, c.notes.length]));
  const byName = new Map<string, NoteMeta[]>(
    best.names.map((c) => [c.tag, []]),
  );
  const unassigned: NoteMeta[] = [];
  for (const note of universe) {
    // Near-disjoint means multiple names on one note is rare — prefer the
    // larger project, deterministically.
    const names = note.tags
      .filter((t) => rank.has(t))
      .sort(
        (a, b) =>
          (size.get(b) ?? 0) - (size.get(a) ?? 0) || a.localeCompare(b),
      );
    if (names.length === 0) unassigned.push(note);
    else byName.get(names[0])?.push(note);
  }

  return {
    clusters: best.names
      .map((c) => ({ name: c.tag, notes: byName.get(c.tag) ?? [] }))
      .filter((c) => c.notes.length > 0)
      .sort((a, b) => b.notes.length - a.notes.length),
    unassigned,
  };
}

/**
 * Facet tags within a note set: co-occurring tags minus `project` and the
 * excluded ones (project name + already-drilled), by frequency.
 */
export function facetsOf(
  notes: NoteMeta[],
  exclude: string[],
): { tag: string; count: number }[] {
  const skip = new Set(['project', ...exclude]);
  const counts = new Map<string, number>();
  for (const n of notes) {
    for (const t of n.tags) {
      if (!skip.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
