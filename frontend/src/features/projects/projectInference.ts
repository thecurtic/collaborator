import { TYPE_TAGS } from '@/features/notes/categories';

/** Anything that can belong to a project: a note, a chat. */
export interface ProjectItem {
  /** Unique across kinds, e.g. note:<filename>, chat:<root id>. */
  key: string;
  tags: string[];
}

/** Manual corrections (UX doc): never retag, override instead. */
export interface NameOverrides {
  /** Always project names. */
  pinned: string[];
  /** Never project names. */
  ignored: string[];
}

/**
 * Project-name inference over everything tagged `project` (notes and chats). Model (greenfield, agreed
 * 2026-08-17): every member note is tagged `project`; the project's NAME is
 * one of its other tags — inferred, never declared. The rest are ordinary
 * tags (bug, feature); the project view doesn't filter by them.
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
export interface ProjectCluster<T extends ProjectItem = ProjectItem> {
  name: string;
  items: T[];
}

export interface ProjectInference<T extends ProjectItem = ProjectItem> {
  clusters: ProjectCluster<T>[];
  /** Items tagged `project` carrying no accepted name tag. */
  unassigned: T[];
}

// Two tags conflict (can't both be names) when their note-sets overlap by
// ≥20% of the smaller set. Below that, the odd mis-tag doesn't merge them.
const CONFLICT_RATIO = 0.2;

const NOT_NAMES = new Set<string>(['project', ...TYPE_TAGS]);

interface Candidate<T extends ProjectItem> {
  tag: string;
  items: T[];
  keys: Set<string>;
}

function overlapRatio<T extends ProjectItem>(a: Candidate<T>, b: Candidate<T>): number {
  let shared = 0;
  const [small, large] = a.keys.size <= b.keys.size ? [a, b] : [b, a];
  for (const k of small.keys) if (large.keys.has(k)) shared++;
  return shared / small.keys.size;
}

/** Greedy pack: accept size-ordered candidates that conflict with nothing;
 * pinned names are accepted first, unconditionally. */
function pack<T extends ProjectItem>(
  ordered: Candidate<T>[],
  banned: string | null,
  pinned: Set<string>,
): { names: Candidate<T>[]; coverage: number } {
  const names: Candidate<T>[] = [];
  const covered = new Set<string>();
  for (const c of ordered.filter((x) => pinned.has(x.tag))) {
    names.push(c);
    for (const k of c.keys) covered.add(k);
  }
  for (const c of ordered) {
    if (pinned.has(c.tag) || c.tag === banned) continue;
    if (names.some((n) => overlapRatio(c, n) >= CONFLICT_RATIO)) continue;
    names.push(c);
    for (const k of c.keys) covered.add(k);
  }
  return { names, coverage: covered.size };
}

export function inferProjects<T extends ProjectItem>(
  universe: T[],
  overrides: NameOverrides = { pinned: [], ignored: [] },
): ProjectInference<T> {
  const pinned = new Set(overrides.pinned);
  const ignored = new Set(overrides.ignored);
  const byTag = new Map<string, T[]>();
  for (const item of universe) {
    for (const tag of item.tags) {
      if (NOT_NAMES.has(tag) || ignored.has(tag)) continue;
      const list = byTag.get(tag);
      if (list) list.push(item);
      else byTag.set(tag, [item]);
    }
  }
  const ordered: Candidate<T>[] = [...byTag.entries()]
    .map(([tag, items]) => ({
      tag,
      items,
      keys: new Set(items.map((n) => n.key)),
    }))
    .sort((a, b) => b.items.length - a.items.length || a.tag.localeCompare(b.tag));

  // Leave-one-out search: plain greedy loses when a bridging facet is the
  // single biggest tag (it gets accepted first and blocks the real names).
  // Re-packing with each of the top candidates banned finds the partition
  // with the best total coverage instead. O(K·n²) at personal scale.
  let best = pack(ordered, null, pinned);
  for (const c of ordered.slice(0, 10)) {
    if (pinned.has(c.tag)) continue;
    const alt = pack(ordered, c.tag, pinned);
    // Equal coverage: the finer partition wins — a tag that covers exactly
    // what several names cover between them is a kind tag spanning them.
    if (alt.coverage > best.coverage ||
        (alt.coverage === best.coverage && alt.names.length > best.names.length)) {
      best = alt;
    }
  }

  const rank = new Map(best.names.map((c, i) => [c.tag, i]));
  const size = new Map(best.names.map((c) => [c.tag, c.items.length]));
  const byName = new Map<string, T[]>(best.names.map((c) => [c.tag, []]));
  const unassigned: T[] = [];
  for (const item of universe) {
    // Near-disjoint means multiple names on one item is rare — prefer the
    // larger project, deterministically.
    const names = item.tags
      .filter((t) => rank.has(t))
      .sort(
        (a, b) =>
          (size.get(b) ?? 0) - (size.get(a) ?? 0) || a.localeCompare(b),
      );
    if (names.length === 0) unassigned.push(item);
    else byName.get(names[0])?.push(item);
  }

  return {
    clusters: best.names
      .map((c) => ({ name: c.tag, items: byName.get(c.tag) ?? [] }))
      .filter((c) => c.items.length > 0)
      .sort((a, b) => b.items.length - a.items.length),
    unassigned,
  };
}

/** The project an item belongs to: the cluster inferProjects placed it in
 * (by key), so a note page and the Projects view always agree. Null when
 * it isn't in any project. */
export function nameFor(key: string, inference: ProjectInference): string | null {
  return inference.clusters.find((c) => c.items.some((i) => i.key === key))?.name ?? null;
}
