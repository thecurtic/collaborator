import { describe, expect, it } from 'vitest';
import type { ConversationTree, TreeNode } from '@/domain/models';
import {
  CONTINUE,
  computePath,
  forkOf,
  indexNodes,
  mainChild,
  rootOf,
  VIRTUAL_ROOT,
} from './treePath';

function node(id: number, children: TreeNode[] = [], branched = false): TreeNode {
  return {
    id,
    role: id % 2 === 1 ? 'user' : 'assistant',
    content: `content ${id}`,
    preview: `preview ${id}`,
    paragraphs: [],
    parentTurnId: null,
    paragraphIndex: null,
    contextBoundary: false,
    branched,
    name: null,
    title: null,
    chatTags: [],
    state: 'tree',
    recall: null,
    tools: [],
    children,
  };
}

function tree(roots: TreeNode[]): ConversationTree {
  return { roots, count: 0, contextWindow: null };
}

// A linear main line 1→2→3 with a branch 10→11 forked off turn 2.
function forkedTree() {
  const t = tree([
    node(1, [
      node(2, [
        node(3), // main-line continuation
        node(10, [node(11)], true), // explicit branch
      ]),
    ]),
  ]);
  return indexNodes(t);
}

describe('indexNodes', () => {
  it('maps parents from the nesting, roots to VIRTUAL_ROOT', () => {
    const { parentOf, childrenOf } = forkedTree();
    expect(parentOf.get(1)).toBe(VIRTUAL_ROOT);
    expect(parentOf.get(2)).toBe(1);
    expect(parentOf.get(10)).toBe(2);
    expect(childrenOf.get(2)?.map((n) => n.id)).toEqual([3, 10]);
  });
});

describe('mainChild', () => {
  it('picks the newest non-branched child', () => {
    expect(mainChild([node(1), node(2), node(3, [], true)])?.id).toBe(2);
  });

  it('returns undefined when all children are branches', () => {
    expect(mainChild([node(1, [], true)])).toBeUndefined();
  });
});

describe('computePath', () => {
  it('follows the main line by default, ignoring branches', () => {
    const { childrenOf } = forkedTree();
    const path = computePath(childrenOf, new Map());
    expect(path.map((s) => s.node.id)).toEqual([1, 2, 3]);
  });

  it('follows an explicitly selected branch', () => {
    const { childrenOf } = forkedTree();
    const path = computePath(childrenOf, new Map([[2, 10]]));
    expect(path.map((s) => s.node.id)).toEqual([1, 2, 10, 11]);
  });

  it('stops at a CONTINUE sentinel', () => {
    const { childrenOf } = forkedTree();
    const path = computePath(childrenOf, new Map([[2, CONTINUE]]));
    expect(path.map((s) => s.node.id)).toEqual([1, 2]);
  });

  it('falls back to the main line when the selection points at a deleted id', () => {
    const { childrenOf } = forkedTree();
    const path = computePath(childrenOf, new Map([[2, 999]]));
    expect(path.map((s) => s.node.id)).toEqual([1, 2, 3]);
  });

  it('ends the main line where only branches remain', () => {
    const idx = indexNodes(tree([node(1, [node(10, [], true)])]));
    const path = computePath(idx.childrenOf, new Map());
    expect(path.map((s) => s.node.id)).toEqual([1]);
  });
});

describe('rootOf', () => {
  it('walks any node up to its conversation root', () => {
    const { parentOf } = forkedTree();
    expect(rootOf(parentOf, 11)).toBe(1);
    expect(rootOf(parentOf, 3)).toBe(1);
    expect(rootOf(parentOf, 1)).toBe(1);
  });

  it('returns the id itself when unknown to the index', () => {
    const { parentOf } = forkedTree();
    expect(rootOf(parentOf, 999)).toBe(999);
  });
});

describe('forkOf', () => {
  const children = [node(3), node(10, [], true), node(20, [], true)];

  it('returns null when there are no branch children', () => {
    expect(forkOf([node(3)], undefined)).toBeNull();
  });

  it('defaults to position 0 (main line)', () => {
    expect(forkOf(children, undefined)).toEqual({
      current: 0,
      total: 2,
      paragraphIndex: null,
      name: null,
    });
  });

  it('numbers a selected branch 1..n', () => {
    expect(forkOf(children, 20)?.current).toBe(2);
  });

  it("reports the selected branch's own name, never the root's", () => {
    const named = [node(3), { ...node(20, [], true), name: 'pricing idea' }];
    expect(forkOf(named, 20)?.name).toBe('pricing idea');
    expect(forkOf(named, undefined)?.name).toBeNull();
  });

  it('treats CONTINUE as the main-line position', () => {
    expect(forkOf(children, CONTINUE)?.current).toBe(0);
  });
});
