import type { ConversationTree, TreeNode } from '@/domain/models';

/** Selection key for top-level roots (they have no parent turn). */
export const VIRTUAL_ROOT = 0;
/** Selection sentinel: "no branch chosen here — stop and continue from this turn". */
export const CONTINUE = -1;

export interface PathStep {
  node: TreeNode;
  /** All children at this level (siblings of `node`) — for the root switcher. */
  siblings: TreeNode[];
  /** Parent id (VIRTUAL_ROOT for top-level). Keys the selection map. */
  parentId: number;
}

export interface NodeIndex {
  byId: Map<number, TreeNode>;
  childrenOf: Map<number, TreeNode[]>;
  /** child id → parent id (VIRTUAL_ROOT for roots), derived from the nesting. */
  parentOf: Map<number, number>;
}

export function indexNodes(tree: ConversationTree): NodeIndex {
  const byId = new Map<number, TreeNode>();
  const childrenOf = new Map<number, TreeNode[]>();
  const parentOf = new Map<number, number>();
  childrenOf.set(VIRTUAL_ROOT, tree.roots);
  const walk = (nodes: TreeNode[], parentId: number) => {
    for (const n of nodes) {
      byId.set(n.id, n);
      childrenOf.set(n.id, n.children);
      parentOf.set(n.id, parentId);
      walk(n.children, n.id);
    }
  };
  walk(tree.roots, VIRTUAL_ROOT);
  return { byId, childrenOf, parentOf };
}

/** The conversation root containing `id` (walks up to just below VIRTUAL_ROOT). */
export function rootOf(parentOf: Map<number, number>, id: number): number {
  let cur = id;
  let parent = parentOf.get(cur);
  while (parent !== undefined && parent !== VIRTUAL_ROOT) {
    cur = parent;
    parent = parentOf.get(cur);
  }
  return cur;
}

/** The main line at a fork = the newest non-branched (continuation) child. */
export function mainChild(siblings: TreeNode[]): TreeNode | undefined {
  for (let i = siblings.length - 1; i >= 0; i--) {
    if (!siblings[i].branched) return siblings[i];
  }
  return undefined;
}

/**
 * Walk root→leaf following the MAIN line (`0/n`) by default — the non-branched
 * continuation. Branches are opt-in: only followed when explicitly selected. If a
 * node has no continuation (all children are branches), the main line ends there.
 */
export function computePath(
  childrenOf: Map<number, TreeNode[]>,
  selection: Map<number, number>,
): PathStep[] {
  const path: PathStep[] = [];
  let parentId = VIRTUAL_ROOT;
  let siblings = childrenOf.get(VIRTUAL_ROOT) ?? [];
  while (siblings.length > 0) {
    const selId = selection.get(parentId);
    if (selId === CONTINUE) break; // "0" with no continuation → stop here
    let chosen =
      selId !== undefined ? siblings.find((s) => s.id === selId) : undefined;
    if (!chosen) chosen = mainChild(siblings); // default: the main line
    if (!chosen) break; // only branches, none selected → main line ends
    path.push({ node: chosen, siblings, parentId });
    parentId = chosen.id;
    siblings = childrenOf.get(chosen.id) ?? [];
  }
  return path;
}

/**
 * Branch switcher for a node's children: position 0 = the main line, 1..n = the
 * branches (branched children). null if there are no branches (linear turn).
 * `label` = the generated label of the line shown (the selected branch, or the
 * main line), null until it's been summarized.
 */
export function forkOf(
  children: TreeNode[],
  selId: number | undefined,
): {
  current: number;
  total: number;
  paragraphIndex: number | null;
  label: string | null;
} | null {
  const branches = children.filter((c) => c.branched);
  if (branches.length === 0) return null;
  let current = 0; // 0 = main line
  let paragraphIndex: number | null = null;
  let label: string | null = children.find((c) => !c.branched)?.label ?? null;
  if (selId !== undefined && selId !== CONTINUE) {
    const bi = branches.findIndex((b) => b.id === selId);
    if (bi >= 0) {
      current = bi + 1;
      paragraphIndex = branches[bi].paragraphIndex;
      label = branches[bi].label;
    }
  }
  return { current, total: branches.length, paragraphIndex, label };
}
